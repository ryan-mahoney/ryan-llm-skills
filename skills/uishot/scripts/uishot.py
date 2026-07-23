#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "playwright",
# ]
# ///
"""
uishot - deterministic screenshots of a running web app, built for coding agents.

Design goals (AXI-style agent ergonomics):
  - One command, one artifact, one terse block of `key: value` output.
  - Absolute path of the PNG is always the second line, so the caller can read it back.
  - Every failure names a machine-readable code and a concrete next action.
  - Reuses a warm Chromium over CDP so repeated calls cost ~200ms, not ~2s.
  - Never screenshots a half-painted page: fonts, images, network and layout must settle first.
"""

import argparse
import base64
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Exit codes. Stable contract - do not renumber.
# ---------------------------------------------------------------------------
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_SELECTOR = 3
EXIT_NAVIGATION = 4
EXIT_BROWSER = 5
EXIT_TIMEOUT = 6
EXIT_DEPENDENCY = 7

STATE_DIR = Path(os.environ.get("UISHOT_HOME", Path.home() / ".cache" / "uishot"))
PROFILE_DIR = STATE_DIR / "profile"
PIDFILE = STATE_DIR / "browser.pid"
DEFAULT_PORT = int(os.environ.get("UISHOT_PORT", "9222"))
DEFAULT_OUT_DIR = Path(os.environ.get("UISHOT_OUT", ".uishot"))
COMMAND = os.environ.get("UISHOT_COMMAND", "uishot")


# ---------------------------------------------------------------------------
# Output helpers. All human/agent-facing text goes through these.
# ---------------------------------------------------------------------------
def emit(pairs):
    for k, v in pairs:
        print(f"{k}: {v}")


def fail(code, exit_code, **fields):
    print(f"error: {code}")
    for k, v in fields.items():
        if v is not None:
            print(f"{k}: {v}")
    sys.exit(exit_code)


# ---------------------------------------------------------------------------
# Warm browser management
# ---------------------------------------------------------------------------
def cdp_alive(port, timeout=0.5):
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/json/version", timeout=timeout
        ) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None


def launch_browser(executable, port, headless=True):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    args = [
        executable,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        "--disable-lcd-text",
        "about:blank",
    ]
    if headless:
        args.insert(1, "--headless=new")
    # Chromium refuses to start its sandbox as root (containers, CI, some
    # devcontainers). Only relax it where it would otherwise be fatal.
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")

    log_path = STATE_DIR / "browser.log"
    log = open(log_path, "w")
    proc = subprocess.Popen(
        args, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if cdp_alive(port):
            PIDFILE.write_text(str(proc.pid))
            return proc.pid
        if proc.poll() is not None:
            return None
        time.sleep(0.15)
    return None


def launch_log_tail(limit=200):
    log_path = STATE_DIR / "browser.log"
    if not log_path.exists():
        return None
    lines = [ln.strip() for ln in log_path.read_text(errors="replace").splitlines() if ln.strip()]
    return lines[-1][:limit] if lines else None


def chromium_path(pw):
    try:
        path = pw.chromium.executable_path
    except Exception:
        return None
    return path if path and Path(path).exists() else None


# ---------------------------------------------------------------------------
# Render-readiness. Runs inside the page.
# ---------------------------------------------------------------------------
FREEZE_CSS = """
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
html { scroll-behavior: auto !important; }
"""

# Installed at document-start on every navigation, so mutations that happen
# during parsing and hydration are recorded too.
MUTATION_PROBE_JS = """
(() => {
  window.__uishot_lastMutation = performance.now();
  const bump = () => { window.__uishot_lastMutation = performance.now(); };
  const start = () => {
    try {
      new MutationObserver(bump).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
    } catch (e) {}
  };
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });

  // A DOM that is merely quiet is not a DOM that is finished: a skeleton
  // swapping for real content on a setTimeout leaves no trace until it fires.
  // Track short-horizon pending timers so we can wait for that deferred work.
  // Long timers (> horizon) are ignored, since polling loops never drain.
  const HORIZON_MS = 5000;
  window.__uishot_timers = new Map();
  const _set = window.setTimeout;
  const _clear = window.clearTimeout;
  window.setTimeout = function (fn, delay) {
    const rest = Array.prototype.slice.call(arguments, 2);
    const d = Number(delay) || 0;
    if (typeof fn !== 'function') return _set.apply(window, arguments);
    let id;
    const wrapped = function () {
      window.__uishot_timers.delete(id);
      return fn.apply(this, arguments);
    };
    id = _set.apply(window, [wrapped, delay].concat(rest));
    if (d >= 0 && d <= HORIZON_MS) {
      window.__uishot_timers.set(id, performance.now() + d);
    }
    return id;
  };
  window.clearTimeout = function (id) {
    window.__uishot_timers.delete(id);
    return _clear.apply(window, arguments);
  };
  // The settle routine must sleep without registering as page work.
  window.__uishot_rawTimeout = function (fn, ms) { return _set.call(window, fn, ms); };
  window.__uishot_timersDue = function () {
    const now = performance.now();
    let n = 0;
    window.__uishot_timers.forEach((fireAt) => {
      if (fireAt >= now - 50 && fireAt <= now + HORIZON_MS) n += 1;
    });
    return n;
  };
})();
"""

MEDIA_TAME_JS = """
(() => {
  // Video and audio make captures non-reproducible: frames advance and buffer
  // bars fill by a different amount on every run. Catch elements as the DOM is
  // parsed, before any frame can be presented.
  const tame = (el) => {
    try {
      el.autoplay = false;
      el.removeAttribute('autoplay');
      el.preload = 'metadata';
      el.pause();
      if (el.tagName === 'VIDEO') {
        if (el.currentTime !== 0) el.currentTime = 0;
      } else if (isFinite(el.duration) && el.duration > 0) {
        // A fully drawn audio buffer bar is stable; a partial one is not.
        el.currentTime = el.duration;
      }
    } catch (e) {}
  };
  const scan = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') tame(node);
    if (node.querySelectorAll) node.querySelectorAll('video, audio').forEach(tame);
  };
  const start = () => {
    scan(document.documentElement);
    try {
      new MutationObserver((records) => {
        records.forEach((r) => r.addedNodes.forEach(scan));
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  };
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})();
"""

SETTLE_JS = """
async ({ quietMs, budgetMs, imageBudgetMs, minWaitMs }) => {
  const rawSleep = window.__uishot_rawTimeout ||
    ((fn, ms) => setTimeout(fn, ms));
  const t0 = performance.now();
  const report = { fonts: 'skipped', images: 0, imagesFailed: 0, stable: false,
                   ms: 0, lastChangeAgoMs: null };

  // 1. Web fonts. Text reflows badly if you shoot before these land.
  try {
    if (document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise(r => rawSleep(r, 5000)),
      ]);
      report.fonts = 'ready';
    }
  } catch (e) { report.fonts = 'error'; }

  // 2. Images, including lazy ones already in flight.
  const pending = Array.from(document.images).filter(i => !i.complete);
  report.images = document.images.length;
  await Promise.all(pending.map(img => new Promise(res => {
    const done = () => res();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    rawSleep(done, imageBudgetMs);
  })));
  report.imagesFailed = Array.from(document.images)
    .filter(i => i.complete && i.naturalWidth === 0).length;

  // 2b. Confirm media actually came to rest. A single pause-and-seek loses to
  //     slow machines: the seeked event may never arrive and the element sits
  //     on a non-zero frame. Re-issue on each poll until the browser agrees.
  const media = Array.from(document.querySelectorAll('video, audio'));
  report.media = media.length;
  if (media.length) {
    const mediaDeadline = performance.now() + 1500;
    while (performance.now() < mediaDeadline) {
      let settled = true;
      for (const el of media) {
        try {
          if (!el.paused) { el.pause(); settled = false; }
          if (el.tagName === 'VIDEO' && el.currentTime !== 0) {
            el.currentTime = 0;
            settled = false;
          }
        } catch (e) {}
      }
      if (settled) break;
      await new Promise(r => rawSleep(r, 50));
    }
  }

  // 3. Optional floor. Useful when an app is known to render late and you
  //    would rather spend the time than risk a stale frame.
  if (minWaitMs > 0) {
    await new Promise(r => rawSleep(r, minWaitMs));
  }

  // 4. DOM quiet period. Any mutation anywhere resets the clock, so a skeleton
  //    that swaps for real content at t+1200ms is caught even though load and
  //    networkidle both completed long before it.
  const lastChange = () => window.__uishot_lastMutation || 0;
  const timersDue = () =>
    (typeof window.__uishot_timersDue === 'function' ? window.__uishot_timersDue() : 0);

  let sawPendingWork = false;
  while (performance.now() - t0 < budgetMs) {
    const due = timersDue();
    if (due > 0) sawPendingWork = true;
    const since = performance.now() - lastChange();
    if (due === 0 && since >= quietMs) { report.stable = true; break; }
    await new Promise(r => rawSleep(r, 25));
  }
  report.deferredWork = sawPendingWork;

  // 5. Paint confirmation. Catches purely visual settling (a CSS transition
  //    resizing a box) that never touches the DOM.
  const signature = () => {
    const d = document.documentElement;
    const b = document.body || d;
    return [d.scrollHeight, d.scrollWidth, b.scrollHeight, b.scrollWidth].join('|');
  };
  let sig = signature();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (signature() !== sig) report.stable = false;

  report.lastChangeAgoMs = Math.round(performance.now() - lastChange());
  report.ms = Math.round(performance.now() - t0);
  return report;
}
"""


# ---------------------------------------------------------------------------
# Filename derivation
# ---------------------------------------------------------------------------
def slugify(text, limit=48):
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text or "").strip("-").lower()
    return (slug[:limit] or "page").strip("-")


def derive_path(url, selector, out_dir, explicit):
    if explicit:
        p = Path(explicit).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    out_dir = Path(out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    bare = re.sub(r"^https?://", "", url)
    parts = [slugify(bare, 40)]
    if selector:
        parts.append(slugify(selector, 24))
    parts.append(datetime.now().strftime("%H%M%S"))
    return (out_dir / ("-".join(parts) + ".png")).resolve()


def parse_viewport(text):
    m = re.fullmatch(r"\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*", text or "")
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


# ---------------------------------------------------------------------------
# Subcommand: shot
# ---------------------------------------------------------------------------
def cmd_shot(args):
    try:
        from playwright.sync_api import sync_playwright
        from playwright.sync_api import Error as PWError
        from playwright.sync_api import TimeoutError as PWTimeout
    except ImportError:
        fail(
            "playwright-not-installed",
            EXIT_DEPENDENCY,
            detail="the playwright python package is not importable",
            next_action=f"run: {COMMAND} setup",
        )

    viewport = parse_viewport(args.viewport)
    if not viewport:
        fail(
            "bad-viewport",
            EXIT_USAGE,
            given=args.viewport,
            next_action="pass --viewport WIDTHxHEIGHT, e.g. --viewport 1280x800",
        )
    width, height = viewport
    started = time.time()
    console_errors = []
    page_errors = []
    failed_requests = []
    inflight = {}

    with sync_playwright() as pw:
        exe = chromium_path(pw)
        if not exe:
            fail(
                "chromium-not-installed",
                EXIT_DEPENDENCY,
                detail="playwright has no chromium build on this machine",
                next_action=f"run: {COMMAND} setup",
            )

        info = cdp_alive(args.port)
        if info:
            browser_state = "reused"
        else:
            pid = launch_browser(exe, args.port, headless=not args.headed)
            if not pid:
                fail(
                    "browser-launch-failed",
                    EXIT_BROWSER,
                    port=args.port,
                    detail=launch_log_tail(),
                    log=str(STATE_DIR / "browser.log"),
                    next_action=(
                        f"read the log above; if the port is taken "
                        f"(lsof -i :{args.port}) pass --port with a free one; "
                        f"if chromium reports missing shared libraries run: "
                        f"python -m playwright install-deps chromium"
                    ),
                )
            browser_state = "launched"

        try:
            browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{args.port}")
        except PWError as e:
            fail(
                "browser-connect-failed",
                EXIT_BROWSER,
                port=args.port,
                detail=str(e).splitlines()[0][:200],
                next_action=f"run: {COMMAND} stop, then retry",
            )

        # An isolated context is the only way Chromium honours deviceScaleFactor
        # over CDP; the shared default context silently captures at 1x. It also
        # gives every shot clean storage, which keeps results reproducible.
        owns_context = False
        context = None
        effective_scale = args.scale
        if not args.reuse_session:
            try:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=args.scale,
                    ignore_https_errors=True,
                )
                owns_context = True
            except PWError:
                context = None
        if context is None:
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            effective_scale = 1

        page = context.new_page()
        page.add_init_script(MUTATION_PROBE_JS)
        if args.freeze:
            page.add_init_script(MEDIA_TAME_JS)

        def cleanup():
            for closer in (page.close, context.close if owns_context else None,
                           browser.close):
                if closer is None:
                    continue
                try:
                    closer()
                except Exception:
                    pass

        page.on(
            "console",
            lambda m: console_errors.append(m.text[:200])
            if m.type == "error"
            else None,
        )
        page.on("pageerror", lambda e: page_errors.append(str(e).splitlines()[0][:200]))
        page.on(
            "requestfailed",
            lambda r: (
                failed_requests.append(f"{r.method} {r.url[:120]}"),
                inflight.pop(r, None),
            ),
        )
        page.on("request", lambda r: inflight.setdefault(r, time.time()))
        page.on("requestfinished", lambda r: inflight.pop(r, None))

        # Shared-session fallback: emulation must be applied by hand, and the
        # scale factor will not stick, so we report 1x rather than lie about it.
        if not owns_context:
            context.new_cdp_session(page).send(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                },
            )

        try:
            response = page.goto(
                args.url, wait_until=args.wait_until, timeout=args.timeout
            )
        except PWTimeout:
            cleanup()
            fail(
                "navigation-timeout",
                EXIT_TIMEOUT,
                url=args.url,
                timeout_ms=args.timeout,
                gate=args.wait_until,
                next_action=(
                    "confirm the dev server is serving this URL; if it is, a "
                    "subresource is stalling the '"
                    + args.wait_until
                    + "' gate - retry with --wait-until domcontentloaded"
                ),
            )
        except PWError as e:
            cleanup()
            fail(
                "navigation-failed",
                EXIT_NAVIGATION,
                url=args.url,
                detail=str(e).splitlines()[0][:200],
                next_action="confirm the dev server is running and the URL is reachable",
            )

        # Normal pages reach "load" within milliseconds of domcontentloaded, and
        # letting them get there keeps the quiet window cheap. Pages held open by
        # streaming media never will, so this is a grace period, not a gate.
        load_state = "load"
        if args.wait_until == "domcontentloaded" and args.load_grace > 0:
            try:
                page.wait_for_load_state("load", timeout=args.load_grace)
            except PWTimeout:
                load_state = "load-STALLED"

        status = response.status if response else "none"
        if response is not None and response.status >= 400 and not args.allow_error_status:
            cleanup()
            fail(
                "http-error-status",
                EXIT_NAVIGATION,
                url=args.url,
                status=response.status,
                next_action=(
                    "fix the route, or pass --allow-error-status to capture "
                    "the error page anyway"
                ),
            )

        if args.freeze:
            try:
                page.add_style_tag(content=FREEZE_CSS)
            except PWError:
                pass

        # Gate on the thing the caller actually cares about seeing.
        wait_target = args.selector or args.wait_for
        if wait_target:
            try:
                page.wait_for_selector(
                    wait_target, state="visible", timeout=args.timeout
                )
            except PWTimeout:
                cleanup()
                fail(
                    "selector-not-found",
                    EXIT_SELECTOR,
                    url=args.url,
                    selector=wait_target,
                    timeout_ms=args.timeout,
                    console_errors=len(console_errors) + len(page_errors),
                    next_action=(
                        "verify the selector matches a visible element; "
                        "raise --timeout if the component mounts late; "
                        "drop --selector to capture the whole page"
                    ),
                )

        if args.wait_text:
            try:
                page.wait_for_function(
                    "t => document.body && document.body.innerText.includes(t)",
                    arg=args.wait_text,
                    timeout=args.timeout,
                )
            except PWTimeout:
                cleanup()
                fail(
                    "text-not-found",
                    EXIT_TIMEOUT,
                    url=args.url,
                    text=args.wait_text,
                    next_action="check the expected copy, or raise --timeout",
                )

        # Playwright's networkidle imposes a flat 500ms tax on every capture and
        # never fires on dev servers holding an HMR socket open. Track in-flight
        # requests directly instead, ageing out long-lived ones so streaming
        # endpoints cannot stall the loop.
        def inflight_young(max_age=2.0):
            now = time.time()
            return sum(1 for t in inflight.values() if now - t < max_age)

        def drain_network(budget_ms):
            deadline = time.time() + budget_ms / 1000.0
            while time.time() < deadline:
                if inflight_young() == 0:
                    return "idle"
                time.sleep(0.02)
            return "busy"

        network = drain_network(args.network_timeout)

        settle = page.evaluate(
            SETTLE_JS,
            {
                "quietMs": args.quiet_ms,
                "budgetMs": args.settle_timeout,
                "imageBudgetMs": args.image_timeout,
                "minWaitMs": args.min_wait,
            },
        )

        # Deferred work often triggers a fetch; give that one more chance to
        # land, then re-settle, before we commit to a frame.
        if inflight_young() > 0:
            network = drain_network(args.network_timeout)
            settle = page.evaluate(
                SETTLE_JS,
                {
                    "quietMs": args.quiet_ms,
                    "budgetMs": args.settle_timeout,
                    "imageBudgetMs": args.image_timeout,
                    "minWaitMs": 0,
                },
            )

        out_path = derive_path(args.url, args.selector, args.out_dir, args.out)

        # If the document never reached "complete", Playwright's screenshot is
        # guaranteed to block on the pending navigation. Detect that up front
        # rather than burning a full timeout discovering it.
        try:
            doc_ready = page.evaluate("document.readyState")
        except PWError:
            doc_ready = "unknown"
        force_cdp = doc_ready != "complete"
        capture_path = "cdp-direct" if force_cdp else "playwright"
        primary_timeout = min(args.timeout, 5000)

        def cdp_capture(clip, beyond):
            # Playwright's screenshot waits for the main frame's navigation to
            # finish, which never happens on pages holding a streaming or
            # never-completing subresource. Raw CDP has no such wait.
            session = context.new_cdp_session(page)
            params = {"format": "png", "captureBeyondViewport": beyond}
            if clip:
                params["clip"] = clip
            data = session.send("Page.captureScreenshot", params)["data"]
            out_path.write_bytes(base64.b64decode(data))

        try:
            if args.selector:
                el = page.locator(args.selector).first
                box = el.bounding_box()
                if not box or box["width"] < 1 or box["height"] < 1:
                    cleanup()
                    fail(
                        "selector-zero-size",
                        EXIT_SELECTOR,
                        url=args.url,
                        selector=args.selector,
                        next_action=(
                            "the element matched but renders at zero size; "
                            "target its parent or check for display:none"
                        ),
                    )
                shot_w, shot_h = round(box["width"]), round(box["height"])
                mode = "element"
                try:
                    if force_cdp:
                        raise PWTimeout("skipped: document never completed")
                    el.screenshot(path=str(out_path), timeout=primary_timeout)
                except PWTimeout:
                    if not force_cdp:
                        capture_path = "cdp-fallback"
                    try:
                        el.scroll_into_view_if_needed(timeout=2000)
                        box = el.bounding_box() or box
                    except PWError:
                        pass
                    cdp_capture(
                        {
                            "x": box["x"],
                            "y": box["y"],
                            "width": box["width"],
                            "height": box["height"],
                            "scale": effective_scale,
                        },
                        True,
                    )
            else:
                mode = "full-page" if args.full_page else "viewport"
                shot_w = width
                shot_h = (
                    page.evaluate("document.documentElement.scrollHeight")
                    if args.full_page
                    else height
                )
                try:
                    if force_cdp:
                        raise PWTimeout("skipped: document never completed")
                    page.screenshot(
                        path=str(out_path),
                        full_page=args.full_page,
                        timeout=primary_timeout,
                    )
                except PWTimeout:
                    if not force_cdp:
                        capture_path = "cdp-fallback"
                    cdp_capture(
                        {
                            "x": 0,
                            "y": 0,
                            "width": width,
                            "height": shot_h,
                            "scale": effective_scale,
                        },
                        bool(args.full_page),
                    )
        except PWTimeout:
            cleanup()
            fail(
                "capture-timeout",
                EXIT_TIMEOUT,
                url=args.url,
                next_action="raise --timeout, or capture a smaller region with --selector",
            )

        title = (page.title() or "")[:120]
        cleanup()

    elapsed = time.time() - started
    waits = [load_state if args.wait_until == "domcontentloaded" else args.wait_until]
    if wait_target:
        waits.append("selector")
    if args.wait_text:
        waits.append("text")
    waits.append(f"network-{network}")
    waits.append(f"fonts-{settle['fonts']}")
    if settle.get("media"):
        waits.append(f"media-pinned-{settle['media']}")
    waits.append(
        f"dom-quiet-{args.quiet_ms}ms" if settle["stable"] else "dom-NEVER-QUIET"
    )

    out = [
        ("ok", "screenshot-saved"),
        ("file", str(out_path)),
        ("mode", mode),
        ("size", f"{shot_w}x{shot_h}@{effective_scale}x"),
        ("bytes", out_path.stat().st_size),
        ("url", args.url),
        ("http_status", status),
        ("title", title),
    ]
    if args.selector:
        out.append(("selector", args.selector))
    out += [
        ("browser", f"{browser_state} on port {args.port}"),
        ("readiness", ",".join(waits)),
        ("settle_ms", settle["ms"]),
        ("elapsed_ms", int(elapsed * 1000)),
    ]
    if capture_path != "playwright":
        out.append(("capture", capture_path))

    all_errors = page_errors + console_errors
    out.append(("console_errors", len(all_errors)))
    if settle["imagesFailed"]:
        out.append(("broken_images", settle["imagesFailed"]))
    if failed_requests:
        out.append(("failed_requests", len(failed_requests)))
    emit(out)

    # Surface a bounded sample. These are usually the reason the UI looks wrong,
    # so the caller should see them without a second command.
    for msg in all_errors[:5]:
        print(f"console_error: {msg}")
    for req in failed_requests[:3]:
        print(f"failed_request: {req}")
    if not settle["stable"]:
        print(
            "warning: the page never went quiet for "
            f"{args.quiet_ms}ms within the {args.settle_timeout}ms budget, so this "
            "image may be mid-render. If the app animates or polls continuously "
            "this is expected; pin the capture with --wait-for SELECTOR or "
            "--wait-text to make it deterministic."
        )
    elif not (args.selector or args.wait_for or args.wait_text):
        print(
            "note: captured on DOM quiet with no explicit wait condition. "
            "If content arrives later than that, pass --wait-for SELECTOR."
        )
    return EXIT_OK


# ---------------------------------------------------------------------------
# Subcommand: setup / status / stop
# ---------------------------------------------------------------------------
def cmd_setup(args):
    try:
        import playwright  # noqa: F401
    except ImportError:
        launcher = Path(__file__).with_name("uishot")
        fail(
            "playwright-not-installed",
            EXIT_DEPENDENCY,
            detail="run setup through the bundled launcher so dependencies stay isolated",
            next_action=f"run: {launcher} setup",
        )

    print("step: installing chromium build")
    r = subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        fail(
            "chromium-install-failed",
            EXIT_DEPENDENCY,
            detail=(r.stderr or "").strip().splitlines()[-1][:200] if r.stderr else None,
            next_action="run manually: python -m playwright install --with-deps chromium",
        )

    emit(
        [
            ("ok", "setup-complete"),
            ("next", f"{COMMAND} shot http://localhost:3000"),
        ]
    )
    return EXIT_OK


def cmd_status(args):
    info = cdp_alive(args.port)
    if info:
        emit(
            [
                ("ok", "browser-running"),
                ("port", args.port),
                ("build", info.get("Browser", "unknown")),
                ("pid", PIDFILE.read_text().strip() if PIDFILE.exists() else "unknown"),
            ]
        )
    else:
        emit(
            [
                ("ok", "browser-stopped"),
                ("port", args.port),
                ("note", "next shot will launch it automatically"),
            ]
        )
    return EXIT_OK


def cmd_stop(args):
    if not cdp_alive(args.port) and not PIDFILE.exists():
        emit([("ok", "already-stopped"), ("port", args.port)])
        return EXIT_OK
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):
                if not cdp_alive(args.port):
                    break
                time.sleep(0.1)
        except (ValueError, ProcessLookupError, PermissionError):
            pass
        PIDFILE.unlink(missing_ok=True)
    emit([("ok", "browser-stopped"), ("port", args.port)])
    return EXIT_OK


# ---------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        prog="uishot",
        description=(
            "Screenshot a running web app once it has finished rendering. "
            "Prints the absolute path of the PNG so you can read the image back."
        ),
    )
    sub = p.add_subparsers(dest="command")

    s = sub.add_parser(
        "shot",
        help="capture a screenshot",
        description="Capture URL (or one element of it) to a PNG after render settles.",
    )
    s.add_argument("url", help="page to capture, e.g. http://localhost:3000/checkout")
    s.add_argument(
        "--selector",
        help="CSS selector to capture instead of the page; also gates the wait",
    )
    s.add_argument("--out", help="exact output path; default is auto-named in --out-dir")
    s.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help="default .uishot")
    s.add_argument("--full-page", action="store_true", help="capture beyond the fold")
    s.add_argument("--viewport", default="1280x800", help="WIDTHxHEIGHT, default 1280x800")
    s.add_argument("--scale", type=int, default=2, help="device pixel ratio, default 2")
    s.add_argument("--wait-for", help="CSS selector that must be visible before capture")
    s.add_argument("--wait-text", help="text that must appear in the body before capture")
    s.add_argument("--timeout", type=int, default=15000, help="per-step ms, default 15000")
    s.add_argument(
        "--load-grace",
        type=int,
        default=1500,
        help="ms to let the load event fire before proceeding anyway, default 1500",
    )
    s.add_argument(
        "--image-timeout",
        type=int,
        default=2500,
        help="max ms to wait on a single slow image, default 2500",
    )
    s.add_argument(
        "--network-timeout",
        type=int,
        default=5000,
        help="max ms to wait for in-flight requests to finish, default 5000",
    )
    s.add_argument(
        "--quiet-ms",
        type=int,
        default=500,
        help="DOM must stop changing for this long before capture, default 500",
    )
    s.add_argument(
        "--min-wait",
        type=int,
        default=0,
        help="always wait at least this long after load, default 0",
    )
    s.add_argument(
        "--settle-timeout",
        type=int,
        default=10000,
        help="max ms to spend waiting for quiet, default 10000",
    )
    s.add_argument(
        "--no-freeze",
        dest="freeze",
        action="store_false",
        help="keep CSS animations and media playing (default: both frozen)",
    )
    s.add_argument(
        "--allow-error-status",
        action="store_true",
        help="capture even when the page returns 4xx/5xx",
    )
    s.add_argument(
        "--reuse-session",
        action="store_true",
        help="share the warm browser's cookies/login instead of a clean context "
        "(forces 1x scale)",
    )
    s.add_argument(
        "--wait-until",
        choices=["domcontentloaded", "load", "commit"],
        default="domcontentloaded",
        help=(
            "navigation gate, default domcontentloaded. 'load' can hang forever "
            "on pages with streaming or autoplaying media"
        ),
    )
    s.add_argument("--headed", action="store_true", help="launch visible, for debugging")
    s.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"CDP port, default {DEFAULT_PORT}")
    s.set_defaults(func=cmd_shot, freeze=True)

    t = sub.add_parser("setup", help="install playwright + chromium once, up front")
    t.set_defaults(func=cmd_setup)

    st = sub.add_parser("status", help="report whether the warm browser is running")
    st.add_argument("--port", type=int, default=DEFAULT_PORT)
    st.set_defaults(func=cmd_status)

    sp = sub.add_parser("stop", help="shut down the warm browser")
    sp.add_argument("--port", type=int, default=DEFAULT_PORT)
    sp.set_defaults(func=cmd_stop)

    return p


def main():
    parser = build_parser()
    argv = sys.argv[1:]
    # Bare URL is treated as `shot <url>`; agents skip the subcommand constantly.
    if argv and argv[0] not in {"shot", "setup", "status", "stop", "-h", "--help"}:
        argv = ["shot"] + argv
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return EXIT_USAGE
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
