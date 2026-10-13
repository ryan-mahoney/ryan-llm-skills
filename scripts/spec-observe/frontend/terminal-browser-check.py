# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Exercise the mounted Live terminal panels through the owned browser fixture.

The dashboard shell, routes, mounts and the public/local host mapping are real;
the final player asset, the open action and the terminal state matrix are the
fixture's counted stub. No tmux, asciinema or WebSocket stream is created.
Step 8 owns the real-player proof.

Run after `npm run build --prefix scripts/spec-observe/frontend`:
  SENTINEL_EVIDENCE_DIR=... uv run --script scripts/spec-observe/frontend/terminal-browser-check.py --case states
  SENTINEL_EVIDENCE_DIR=... uv run --script scripts/spec-observe/frontend/terminal-browser-check.py --case captures
  SENTINEL_EVIDENCE_DIR=... uv run --script scripts/spec-observe/frontend/terminal-browser-check.py --case real \
    --url URL --assignment UUID --probe-dir DIR --package DIR --workspace WS

The states case writes evidence/ev-5-terminal.json; the captures case writes
evidence/ev-8-terminal-captures.json plus evidence/browser/terminal-*.png.
"""
import argparse
import base64
import json
import os
import select
import subprocess
import time
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse

from playwright.sync_api import expect, sync_playwright

root = Path(__file__).resolve().parent
evidence_dir = Path(os.environ["SENTINEL_EVIDENCE_DIR"]) if os.environ.get("SENTINEL_EVIDENCE_DIR") else None
receipt_dir = evidence_dir or Path("/tmp")
shots_dir = (evidence_dir / "browser") if evidence_dir else Path("/tmp/browser")
shots_dir.mkdir(parents=True, exist_ok=True)

RUN_ID = "run-1"
SECOND_ID = "33333333-3333-4333-8333-333333333333"
# Route contract owned by src/route.ts: only these query names survive into the
# dashboard hash.
SUPPORTED_PARAMS = ("ws", "id", "tab", "source", "path", "filter", "q", "thread", "target", "package", "skill")

# terminal-state.ts contract copies asserted by both cases.
LIVE = "Live terminal stream."
CONNECTING = "Connecting to the live terminal…"
NOT_INSTALLED = "Install asciinema 3.x on the host to watch agent terminals here (see host setup)."
CHANGED = "The terminal no longer belongs to this agent. Reconcile it with the locate command."
BUSY = "Terminal streams are unavailable. Try again shortly."
FAILED = "The terminal stream could not be started. Retry."
NOT_RUNNING = "The terminal stream is not running. Retry."
NETWORK = "The terminal stream could not be reached. Check the connection and retry."
ENDED = "This agent's terminal has ended."
TOKENLESS = "Reconnect to the live dashboard to open the terminal."
HOST_LOCAL = "The live terminal is available on the host's local dashboard."


class Fixture:
    """Owned fixture process; the stub player and terminal routes are fake."""

    def __init__(self, env=None):
        environment = dict(os.environ)
        environment.update(env or {})
        self.proc = subprocess.Popen(
            ["node", str(root / "browser-fixture.mjs")],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        if not select.select([self.proc.stdout], [], [], 15)[0]:
            raise RuntimeError("Terminal fixture did not become ready within 15 seconds")
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"Terminal fixture exited before readiness: {self.proc.stderr.read()}")
        self.info = json.loads(line)
        self.url = self.info["url"]

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def control(api, fixture, action=None, value=None):
    if action is None:
        query = ""
    else:
        encoded = str(value).lower() if isinstance(value, bool) else str(value)
        query = "?" + urlencode({"action": action, "value": encoded})
    response = api.get(fixture.url + "/__fixture/control" + query)
    assert response.ok, (action, value, response.status)
    return response.json()


def write_receipt(receipt, report):
    receipt.parent.mkdir(parents=True, exist_ok=True)
    temporary = receipt.with_name(receipt.name + ".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    os.replace(temporary, receipt)


def run_states(browser, report):
    """EV-5: mounts, scalar identity, disposal and the stub state matrix."""
    report["boundary"] = "owned fixture; stub final player/process states and counted open/asset routes; no real stream; CDP 127.0.0.1:9222"
    fixtures = []
    context = None
    try:
        fixture = Fixture()
        fixtures.append(fixture)
        context = browser.new_context(viewport={"width": 1440, "height": 1100})
        page = context.new_page()
        page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
        api = context.request

        def ctl(action=None, value=None):
            return control(api, fixture, action, value)

        def terminal():
            return ctl()["terminal"]

        def wait_terminal(predicate, what, timeout=20):
            deadline = time.monotonic() + timeout
            seen = None
            while time.monotonic() < deadline:
                seen = terminal()
                if predicate(seen):
                    return seen
                page.wait_for_timeout(100)
            raise AssertionError(f"Timed out waiting for {what}: {seen}")

        def open_count():
            return terminal()["counts"]["openById"].get(RUN_ID, 0)

        def assets_by_id(value):
            return terminal()["counts"]["assetById"].get(value, {})

        def creates():
            return page.evaluate("window.__fixturePlayerCreates||{}")

        def disposals():
            return page.evaluate("window.__fixturePlayerDisposals||0")

        def refresh_state():
            # Detail recovery surfaces render their own same-named button, so
            # target the Shell header action.
            with page.expect_response(lambda response: "/api/state" in response.url and response.request.method == "GET"):
                page.locator("header").get_by_role("button", name="Refresh state", exact=True).click()

        def run_row():
            return page.locator("[data-assignment-key]").filter(has=page.get_by_text(RUN_ID, exact=True))

        def second_row():
            return page.locator("[data-assignment-key]").filter(has=page.get_by_text(SECOND_ID, exact=True))

        def spec_row():
            return page.locator(".records button.record").filter(has=page.get_by_text("browser", exact=True)).first

        def click_surface(destination):
            page.locator(f'[data-area="{destination}"]').click()

        def remount_run1():
            second_row().click()
            run_row().click()

        # Strict local dashboard: the default public Host/Origin mapping yields
        # completion local-only, which never opens a terminal.
        ctl("local", True)

        # 1. Both lists link the same assignment UUID and mount one Live section.
        # The fixture workspace scope keeps the first auto-selected row at
        # run-1/browser; without it the unscoped list transiently opens the
        # mismatch observer's alpha assignment before the row click.
        page.goto(fixture.url + "/#/agents?ws=fixture", wait_until="domcontentloaded")
        expect(run_row()).to_have_count(1)
        run_row().click()
        panel = page.locator("section.terminal-view")
        expect(page.locator("#live-terminal-heading")).to_have_count(1)
        expect(panel).to_have_count(1)
        expect(panel).to_contain_text(LIVE)
        expect(page.locator("section.session-controls + section.terminal-view")).to_have_count(1)
        expect(panel.locator('.terminal-frame[data-fixture-player="stub"]')).to_be_visible()
        wait_terminal(lambda state: open_count() == 1, "agent detail open")
        assert creates().get(RUN_ID, 0) == 1, creates()
        report["cases"].append("agent detail from list mounts one Live section after SessionPanel")

        # Scoped entry from the list keeps the specs list on the fixture
        # workspace, matching the agents scope above.
        page.goto(fixture.url + "/#/specs?ws=fixture", wait_until="domcontentloaded")
        expect(spec_row()).to_be_visible()
        spec_row().click()
        expect(page.locator("#live-terminal-heading")).to_have_count(1)
        expect(page.locator("section.terminal-view")).to_contain_text(LIVE)
        wait_terminal(lambda state: open_count() == 2, "spec Overview open")
        assert set(terminal()["counts"]["openById"]) == {RUN_ID}, terminal()["counts"]
        assert creates().get(RUN_ID, 0) == 2, creates()
        report["cases"].append("spec Overview from list mounts one Live section for the same UUID")

        # 2. Activity tab, leaving the detail and an unlinked record dispose it.
        activity_guard = open_count()
        page.get_by_role("button", name="Activity", exact=True).click()
        expect(page.locator("section.terminal-view")).to_have_count(0)
        assert disposals() >= 1, "player was not disposed on leaving Overview"
        assert open_count() == activity_guard, open_count()
        page.get_by_role("button", name="Overview", exact=True).click()
        expect(page.locator("section.terminal-view")).to_contain_text(LIVE)
        wait_terminal(lambda state: open_count() == activity_guard + 1, "Overview reopen")
        # Re-baseline after the Overview reopen: the agents surface auto-selects
        # run-1 and mounts its own panel, so its open plus the spec player's
        # disposal are the first events measured against this baseline.
        live_guard = open_count()

        agents_disposals = disposals()
        click_surface("agents")
        expect(page.locator("#live-terminal-heading")).to_have_count(1)
        agents_panel = page.locator("section.terminal-view")
        expect(agents_panel).to_have_count(1)
        expect(agents_panel).to_contain_text(LIVE)
        expect(page.locator("section.session-controls + section.terminal-view")).to_have_count(1)
        assert disposals() >= agents_disposals + 1, "spec player was not disposed on leaving Overview"
        assert open_count() == live_guard + 1, open_count()
        click_surface("specs")
        spec_row().click()
        expect(page.locator("section.terminal-view")).to_contain_text(LIVE)
        wait_terminal(lambda state: open_count() == live_guard + 2, "spec remount")

        ctl("terminal-assignment", "absent")
        refresh_state()
        expect(page.locator("section.terminal-view")).to_have_count(0)
        assert open_count() == live_guard + 2, open_count()
        report["cases"].append("Activity tab, leaving detail and unlinked record remove the player")

        ctl("terminal-assignment", "live")
        refresh_state()
        # The header refresh skips while a poll is in flight (if (fetching()) return), so allow a full poll interval.
        expect(page.locator("section.terminal-view")).to_contain_text(LIVE, timeout=15000)
        wait_terminal(lambda state: open_count() == live_guard + 3, "linked restore")

        # 3. Planned Overview never mounts a panel and never opens a stream.
        planned = Fixture({"SENTINEL_PLANNED_LAUNCH": "1"})
        fixtures.append(planned)
        planned_page = context.new_page()
        planned_page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
        planned_page.goto(planned.url + "/#/specs?ws=fixture&filter=planned", wait_until="domcontentloaded")
        planned_rows = planned_page.locator(".records button.record[data-key]")
        expect(planned_rows).to_have_count(2)
        planned_rows.filter(has=planned_page.get_by_text("browser", exact=True)).click()
        expect(planned_page.locator("#planned-assignment")).to_be_visible()
        expect(planned_page.locator("section.terminal-view")).to_have_count(0)
        assert control(api, planned)["terminal"]["counts"]["open"] == 0
        planned_page.close()
        report["cases"].append("planned spec Overview mounts no terminal panel and opens nothing")

        # 4. Assignment switch while the first assignment's assets are pending:
        # the stale result is ignored and the second assignment alone plays.
        click_surface("epics")
        ctl("terminal-delay-ms", 1500)
        ctl("publish-assignment", SECOND_ID)
        page.reload(wait_until="domcontentloaded")
        # Enter the SECOND detail directly by key: the reload above clears the
        # page player/asset caches the pending-asset checks need, and the
        # explicit id removes the auto-select race a bare /#/agents entry
        # would reintroduce.
        second_key = quote(json.dumps(["fixture", SECOND_ID], separators=(",", ":")))
        page.goto(f"{fixture.url}/#/agents?ws=fixture&id={second_key}", wait_until="domcontentloaded")
        # Same-document entry keeps the explicit id (no auto-select); the
        # just-published SECOND row may still be absent from the loaded state,
        # so force one poll before asserting the panel mounted it.
        refresh_state()
        # The awaited refresh can be an in-flight background poll whose payload
        # still lacks SECOND, so wait for row delivery before the heading.
        expect(second_row()).to_have_count(1, timeout=15000)
        expect(page.locator("#live-terminal-heading")).to_have_count(1)
        expect(page.locator("section.terminal-view")).to_contain_text(LIVE)
        wait_terminal(lambda state: state["counts"]["openById"].get(SECOND_ID, 0) >= 1, "second assignment open")
        wait_terminal(lambda state: creates().get(SECOND_ID, 0) == 1, "second assignment player")
        second_before = creates().get(SECOND_ID, 0)
        before_switch = open_count()
        run_assets_before = dict(assets_by_id(RUN_ID))
        run_row().click()
        wait_terminal(lambda state: assets_by_id(RUN_ID).get("script", 0) >= 1, "pending run-1 assets")
        assert open_count() == before_switch + 1, open_count()
        assert creates().get(RUN_ID, 0) == 0, creates()
        second_row().click()
        wait_terminal(lambda state: creates().get(SECOND_ID, 0) == second_before + 1, "second assignment player")
        page.wait_for_timeout(1800)
        assert creates().get(RUN_ID, 0) == 0, creates()
        run_assets = assets_by_id(RUN_ID)
        assert run_assets.get("script", 0) == run_assets_before.get("script", 0) + 1 and run_assets.get("styles", 0) == run_assets_before.get("styles", 0) + 1, (run_assets_before, run_assets)
        run_row().click()
        wait_terminal(lambda state: creates().get(RUN_ID, 0) == 1, "cached run-1 player")
        assert open_count() == before_switch + 2, open_count()
        assert assets_by_id(RUN_ID) == run_assets, (assets_by_id(RUN_ID), run_assets)
        ctl("terminal-delay-ms", 0)
        report["cases"].append("assignment switch during pending assets disposes the stale player and reuses cached assets")

        # 5. Two real state polls keep exactly one open and player.
        expect(page.locator("section.terminal-view")).to_contain_text(LIVE)
        polls_before = terminal()["counts"]
        creates_before = dict(creates())
        refresh_state()
        refresh_state()
        assert terminal()["counts"] == polls_before, (polls_before, terminal()["counts"])
        assert creates() == creates_before, (creates_before, creates())
        report["cases"].append("two real state polls retain one open and player")

        # 6. Local/public classification change disposes the player and never
        # replays the stale result; switching back reopens exactly once.
        live_open = open_count()
        live_creates = creates().get(RUN_ID, 0)
        ctl("local", False)
        refresh_state()
        panel = page.locator("section.terminal-view")
        expect(panel).to_contain_text(HOST_LOCAL)
        expect(panel.locator(".terminal-frame")).to_be_hidden()
        assert disposals() >= 2, disposals()
        assert open_count() == live_open, open_count()
        assert creates().get(RUN_ID, 0) == live_creates, creates()
        ctl("local", True)
        refresh_state()
        expect(panel).to_contain_text(LIVE)
        wait_terminal(lambda state: open_count() == live_open + 1, "local reopen")
        assert creates().get(RUN_ID, 0) == live_creates + 1, creates()
        report["cases"].append("local/public switch disposes the player and reopens once on return")

        # 7. Stub state matrix: each state shows its copy and hides the frame.
        run_creates = creates().get(RUN_ID, 0)
        matrix = [
            ("not-installed", "Not installed", NOT_INSTALLED, False),
            ("changed", "Unavailable", CHANGED, False),
            ("busy", "Unavailable", BUSY, True),
            ("failed", "Unavailable", FAILED, True),
            ("not-running", "Unavailable", NOT_RUNNING, True),
        ]
        for state, label, copy, retry in matrix:
            ctl("terminal-state", state)
            before_state = open_count()
            remount_run1()
            wait_terminal(lambda current, expected=before_state + 1: open_count() == expected, f"{state} open")
            panel = page.locator("section.terminal-view")
            expect(panel).to_contain_text(label)
            expect(panel).to_contain_text(copy)
            expect(panel.locator(".terminal-frame")).to_be_hidden()
            assert creates().get(RUN_ID, 0) == run_creates, creates()
            retry_button = panel.get_by_role("button", name="Retry", exact=True)
            if retry:
                expect(retry_button).to_be_visible()
                retry_button.focus()
                page.keyboard.press("Enter")
                wait_terminal(lambda current, expected=before_state + 2: open_count() == expected, f"{state} retry open")
            else:
                expect(retry_button).to_have_count(0)
            report["cases"].append(f"stub state {state} shows {label} copy with no frame")
        ctl("terminal-state", "none")

        # 8. Ended display and a live read without an action token never open.
        ctl("terminal-assignment", "ended")
        before_ended = open_count()
        refresh_state()
        panel = page.locator("section.terminal-view")
        expect(panel).to_contain_text("Ended")
        expect(panel).to_contain_text(ENDED)
        expect(panel.locator(".terminal-frame")).to_be_hidden()
        assert open_count() == before_ended, open_count()
        ctl("terminal-assignment", "live")
        refresh_state()
        expect(panel).to_contain_text(LIVE, timeout=15000)
        wait_terminal(lambda state: open_count() == before_ended + 1, "ended restore")
        report["cases"].append("ended display shows Ended copy with no frame and no open")

        ctl("state-fail", True)
        before_tokenless = open_count()
        refresh_state()
        expect(panel).to_contain_text(TOKENLESS)
        expect(panel.locator(".terminal-frame")).to_be_hidden()
        assert open_count() == before_tokenless, open_count()
        ctl("state-fail", False)
        refresh_state()
        expect(panel).to_contain_text(LIVE, timeout=15000)
        wait_terminal(lambda state: open_count() == before_tokenless + 1, "tokenless restore")
        report["cases"].append("live read without an action token shows reconnect copy with no frame")

        # 9. Imported snapshots never open the terminal.
        snapshot = api.get(fixture.url + "/api/state").json()
        page.locator("#import-file").set_input_files({
            "name": "snapshot.json",
            "mimeType": "application/json",
            "buffer": json.dumps(snapshot).encode(),
        })
        click_surface("agents")
        run_row().click()
        panel = page.locator("section.terminal-view")
        expect(panel).to_contain_text(HOST_LOCAL)
        expect(panel.locator(".terminal-frame")).to_be_hidden()
        before_imported = open_count()
        refresh_state()
        expect(panel).to_contain_text(LIVE, timeout=15000)
        wait_terminal(lambda state: open_count() == before_imported + 1, "imported restore")
        report["cases"].append("imported snapshot shows host-local copy with no frame")

        # 10. A failed player asset keeps the frame hidden; one keyboard Retry
        # recovers once and retries the asset load exactly once.
        ctl("terminal-state", "none")
        ctl("terminal-assignment", "live")
        ctl("terminal-delay-ms", 0)
        ctl("terminal-open-delay-ms", 0)
        ctl("terminal-fail-asset", "script")
        click_surface("epics")
        page.reload(wait_until="domcontentloaded")
        click_surface("agents")
        failed_assets_before = dict(assets_by_id(RUN_ID))
        run_row().click()
        panel = page.locator("section.terminal-view")
        expect(panel).to_contain_text(FAILED)
        retry_button = panel.get_by_role("button", name="Retry", exact=True)
        expect(retry_button).to_be_visible()
        expect(panel.locator(".terminal-frame")).to_be_hidden()
        failed_open = open_count()
        failed_assets = assets_by_id(RUN_ID)
        assert failed_assets.get("styles", 0) == failed_assets_before.get("styles", 0) + 1 and failed_assets.get("script", 0) == failed_assets_before.get("script", 0) + 1, (failed_assets_before, failed_assets)
        assert creates().get(RUN_ID, 0) == 0, creates()
        ctl("terminal-fail-asset", "none")
        retry_button.focus()
        page.keyboard.press("Enter")
        expect(panel).to_contain_text(LIVE)
        wait_terminal(lambda state: creates().get(RUN_ID, 0) == 1, "failed-asset recovery")
        assert open_count() == failed_open + 1, open_count()
        recovered_assets = assets_by_id(RUN_ID)
        assert recovered_assets == {
            "styles": failed_assets_before.get("styles", 0) + 2,
            "script": failed_assets_before.get("script", 0) + 2,
        }, (failed_assets_before, recovered_assets)
        report["cases"].append("failed asset hides the frame and one keyboard Retry recovers exactly once")

        # 11. A never-settling open expires through the open deadline: the
        # panel leaves Connecting for the network failure with an enabled
        # Retry, the late fixture response is discarded, and one keyboard
        # Retry reopens exactly once. The 15 s held open exceeds the 10 s
        # panel deadline without touching the fixture's delay ceiling.
        ctl("terminal-open-delay-ms", 15000)
        stalled_start = time.monotonic()
        stalled_open = open_count()
        stalled_creates = creates().get(RUN_ID, 0)
        remount_run1()
        panel = page.locator("section.terminal-view")
        expect(panel).to_contain_text("Connecting…")
        expect(panel).to_contain_text(CONNECTING, timeout=15000)
        wait_terminal(lambda current: open_count() == stalled_open + 1, "stalled open")
        expect(panel).to_contain_text("Unavailable", timeout=15000)
        expect(panel).to_contain_text(NETWORK, timeout=15000)
        expect(panel.locator(".terminal-frame")).to_be_hidden()
        retry_button = panel.get_by_role("button", name="Retry", exact=True)
        expect(retry_button).to_be_visible()
        expect(retry_button).to_be_enabled()
        assert creates().get(RUN_ID, 0) == stalled_creates, creates()
        ctl("terminal-open-delay-ms", 0)
        retry_button.focus()
        page.keyboard.press("Enter")
        expect(panel).to_contain_text(LIVE)
        wait_terminal(lambda current: open_count() == stalled_open + 2, "stalled retry open")
        wait_terminal(lambda current: creates().get(RUN_ID, 0) == stalled_creates + 1, "stalled retry player")
        # The first response lands after the held 15 s delay; the aborted
        # attempt must not replay it over the recovered Live panel.
        elapsed = time.monotonic() - stalled_start
        if elapsed < 17:
            page.wait_for_timeout(int((17 - elapsed) * 1000))
        assert creates().get(RUN_ID, 0) == stalled_creates + 1, creates()
        expect(panel).to_contain_text(LIVE)
        report["cases"].append("never-settling open expires to network Retry and discards the late response")

        # Route normalization must not leak unknown query names.
        params = urlparse(page.url).fragment.partition("?")[2]
        if params:
            names = set(part.partition("=")[0] for part in params.split("&"))
            assert names <= set(SUPPORTED_PARAMS), names

        assert not report["page_errors"], report["page_errors"]
    finally:
        if context is not None:
            context.close()
        for item in reversed(fixtures):
            item.close()


def viewport_visible(page, locator, name, minimum_height, what):
    """Visible region of locator inside the viewport; rejects vertical clipping."""
    box = locator.bounding_box()
    assert box is not None, (name, what, "missing bounding box")
    viewport = page.viewport_size
    assert viewport is not None, (name, "missing viewport")
    left = max(box["x"], 0.0)
    top = max(box["y"], 0.0)
    right = min(box["x"] + box["width"], viewport["width"])
    bottom = min(box["y"] + box["height"], viewport["height"])
    visible = {"x": left, "y": top, "width": max(right - left, 0.0), "height": max(bottom - top, 0.0)}
    assert visible["width"] > 0 and visible["height"] >= minimum_height, (name, what, box, visible)
    return box, visible


def assert_uncovered(page, name, what, box, visible):
    """The visible center must hit inside the terminal section, not an overlap."""
    viewport = page.viewport_size
    point_x = min(max(box["x"] + box["width"] / 2, 0), viewport["width"] - 1)
    point_y = min(max(visible["y"] + visible["height"] / 2, 0), viewport["height"] - 1)
    hit = page.evaluate(
        "([x, y]) => { const el = document.elementFromPoint(x, y);"
        " const scope = document.querySelector('section.terminal-view');"
        " return !!el && !!scope && (scope === el || scope.contains(el)); }",
        [point_x, point_y],
    )
    assert hit, (name, what, "covered or clipped", box, visible)


def run_captures(browser, report):
    """EV-8: state screenshots for both surfaces at 1280x860 and 390x844.

    Each capture scrolls the terminal section into view, screenshots the
    viewport, then rejects vertical clipping and overlap of the state
    message, recovery control and player before recording the capture."""
    report["boundary"] = "owned fixture; stub final player/process states; no real stream; captured content is stub data"
    fixtures = []
    context = None
    try:
        fixture = Fixture()
        fixtures.append(fixture)
        context = browser.new_context(viewport={"width": 1280, "height": 860})
        page = context.new_page()
        page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
        api = context.request

        def ctl(action=None, value=None):
            return control(api, fixture, action, value)

        def run_row():
            return page.locator("[data-assignment-key]").filter(has=page.get_by_text(RUN_ID, exact=True))

        def spec_row():
            return page.locator(".records button.record").filter(has=page.get_by_text("browser", exact=True)).first

        def open_surface(surface):
            path = "agents" if surface == "agent" else "specs"
            page.goto(f"{fixture.url}/#/{path}?ws=fixture", wait_until="domcontentloaded")
            if surface == "agent":
                expect(run_row()).to_have_count(1)
                key = run_row().get_attribute("data-assignment-key")
            else:
                expect(spec_row()).to_be_visible()
                key = spec_row().get_attribute("data-key")
            assert key, f"missing {surface} list key"
            page.goto(f"{fixture.url}/#/{path}?ws=fixture&id={quote(key)}", wait_until="domcontentloaded")
            expect(page.locator("#live-terminal-heading")).to_have_count(1)

        ctl("local", True)
        states = [
            ("live", [("terminal-state", "none"), ("terminal-open-delay-ms", "0"), ("terminal-delay-ms", "0")], "Live", LIVE, True),
            ("connecting", [("terminal-state", "none"), ("terminal-open-delay-ms", "8000"), ("terminal-delay-ms", "0")], "Connecting…", CONNECTING, False),
            ("not-installed", [("terminal-state", "not-installed"), ("terminal-open-delay-ms", "0")], "Not installed", NOT_INSTALLED, False),
            ("unavailable", [("terminal-state", "changed"), ("terminal-open-delay-ms", "0")], "Unavailable", CHANGED, False),
            ("error", [("terminal-state", "failed"), ("terminal-open-delay-ms", "0")], "Unavailable", FAILED, False),
        ]
        for state, controls, label, copy, populated in states:
            for action, value in controls:
                ctl(action, value)
            for surface in ("agent", "spec"):
                open_surface(surface)
                panel = page.locator("section.terminal-view")
                expect(panel).to_contain_text(label)
                expect(panel).to_contain_text(copy)
                frame = panel.locator(".terminal-frame")
                if populated:
                    expect(frame).to_be_visible()
                else:
                    expect(frame).to_be_hidden()
                for width, height in ((1280, 860), (390, 844)):
                    page.set_viewport_size({"width": width, "height": height})
                    panel.evaluate("el => el.scrollIntoView({block:'start'})")
                    page.wait_for_timeout(120)
                    name = f"terminal-{surface}-{state}-{width}.png"
                    path = shots_dir / name
                    page.screenshot(path=str(path))
                    checks = {}
                    message = panel.locator("p[role='status']")
                    expect(message).to_contain_text(copy)
                    message_box, message_visible = viewport_visible(page, message, name, 12, "state message")
                    assert_uncovered(page, name, "state message", message_box, message_visible)
                    checks["message_visible_height"] = round(message_visible["height"], 1)
                    retry = panel.get_by_role("button", name="Retry", exact=True)
                    if retry.count() > 0:
                        expect(retry).to_be_visible()
                        retry_box, retry_visible = viewport_visible(page, retry, name, 24, "retry control")
                        assert_uncovered(page, name, "retry control", retry_box, retry_visible)
                        checks["retry_visible_height"] = round(retry_visible["height"], 1)
                    report["captures"].append({"file": str(path), "surface": surface, "state": state, "width": width, "checks": checks})
                    if populated:
                        expect(frame).to_contain_text("fixture terminal output")
                        checks["player_text"] = True
                        box = frame.bounding_box()
                        assert box is not None and box["x"] >= -1 and box["x"] + box["width"] <= width + 1, (name, box)
                        frame_box, frame_visible = viewport_visible(page, frame, name, 120, "terminal player")
                        assert_uncovered(page, name, "terminal player", frame_box, frame_visible)
                        checks["frame_visible_height"] = round(frame_visible["height"], 1)
                        overflow = page.evaluate("document.documentElement.scrollWidth")
                        assert overflow <= width + 1, (name, overflow)
                report["cases"].append(f"{surface} {state} shows {label} copy")
        assert not report["page_errors"], report["page_errors"]
    finally:
        if context is not None:
            context.close()
        for item in reversed(fixtures):
            item.close()


def run_real(browser, report, args):
    """EV-1/EV-6: real dashboard, private tmux session, asciinema stream and player.

    The Node case owns the launched assignment, the raw v1.alis viewer and the
    owned probe directory; this script only drives the ordinary browser routes
    against the same-origin dashboard and never creates the terminal fixture."""
    report["boundary"] = (
        "real default dashboard (no injected terminal views, service or adapters), real private tmux "
        "session, real asciinema 3.x stream and real bundled player through the same-origin proxy"
    )
    report["errors"] = []
    package_name = Path(args.package).name if args.package else ""
    probe_dir = Path(args.probe_dir) if args.probe_dir else None
    context = None
    try:
        context = browser.new_context(viewport={"width": 1280, "height": 860})
        page = context.new_page()
        page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
        page.add_init_script(
            "window.__cspViolations = [];"
            "document.addEventListener('securitypolicyviolation',"
            "event => window.__cspViolations.push(event.violatedDirective || 'unknown'));"
        )

        def open_route(route):
            if route == "agents":
                page.goto(f"{args.url}/#/agents?ws={quote(args.workspace)}", wait_until="domcontentloaded")
                row = page.locator("[data-assignment-key]").filter(has=page.get_by_text(args.assignment, exact=True))
                expect(row).to_have_count(1, timeout=30000)
                row.click()
            else:
                page.goto(f"{args.url}/#/specs?ws={quote(args.workspace)}", wait_until="domcontentloaded")
                row = page.locator(".records button.record").filter(has=page.get_by_text(package_name, exact=True)).first
                expect(row).to_be_visible(timeout=30000)
                row.click()
            expect(page.locator("#live-terminal-heading")).to_have_count(1, timeout=30000)
            panel = page.locator("section.terminal-view")
            expect(panel).to_have_count(1)
            frame = panel.locator(".terminal-frame")
            expect(frame).to_be_visible(timeout=30000)
            expect(frame).to_contain_text("INITIAL_TERMINAL_MARKER", timeout=45000)
            return frame

        def capture(route, width, height):
            page.set_viewport_size({"width": width, "height": height})
            page.locator("section.terminal-view").evaluate("el => el.scrollIntoView({block:'start'})")
            page.wait_for_timeout(250)
            name = f"terminal-real-{route}-{width}.png"
            path = shots_dir / name
            page.screenshot(path=str(path))
            report["captures"].append({"file": str(path), "route": route, "width": width})

        frame = open_route("agents")
        report["cases"].append("ordinary agents detail renders the real launched UUID terminal with the initial marker")

        # The later marker is owned output that only appears after the
        # parent-owned trigger file exists; the browser stays attached and the
        # captures are taken with both markers already rendered.
        assert probe_dir is not None, "real mode requires --probe-dir"
        probe_dir.mkdir(parents=True, exist_ok=True)
        (probe_dir / "later-output.trigger").write_text("trigger\n")
        expect(frame).to_contain_text("LATER_TERMINAL_MARKER", timeout=45000)
        report["cases"].append("later owned output marker becomes visible through the real player")
        capture("agents", 1280, 860)
        capture("agents", 390, 844)

        # Viewer keyboard input targets the player frame; the parent asserts the
        # observed input log stays at its positive-control baseline.
        frame.click()
        page.keyboard.type("ADJ4-VIEWER-INPUT-ATTEMPT")
        page.wait_for_timeout(500)
        report["viewer_input"] = {"attempted": True, "text": "ADJ4-VIEWER-INPUT-ATTEMPT"}
        # The init array resets per navigation; retain the agents answer before
        # leaving the route.
        agents_violations = page.evaluate("window.__cspViolations || []")

        frame = open_route("spec")
        expect(frame).to_contain_text("LATER_TERMINAL_MARKER", timeout=45000)
        report["cases"].append("non-planned spec Overview renders the same UUID terminal and both markers")
        capture("spec", 1280, 860)
        capture("spec", 390, 844)

        api = context.request
        shell = api.get(args.url + "/")
        assert shell.ok, shell.status
        shell_csp = shell.headers.get("content-security-policy", "")
        assert "default-src 'self'" in shell_csp and "frame-ancestors 'none'" in shell_csp, shell_csp
        assert "'wasm-unsafe-eval'" in shell_csp, shell_csp
        assert "unsafe-eval" not in shell_csp.replace("'wasm-unsafe-eval'", ""), shell_csp
        package_token = base64.urlsafe_b64encode(args.package.encode()).decode().rstrip("=")
        sandbox = api.get(f"{args.url}/package-view/{package_token}/sandbox.html")
        assert sandbox.ok, sandbox.status
        sandbox_csp = sandbox.headers.get("content-security-policy", "")
        assert "sandbox allow-scripts" in sandbox_csp, sandbox_csp
        assert "allow-same-origin" not in sandbox_csp, sandbox_csp
        assert "connect-src 'none'" in sandbox_csp, sandbox_csp
        report["csp"] = {"shell": shell_csp, "sandbox": sandbox_csp}

        spec_violations = page.evaluate("window.__cspViolations || []")
        violations = agents_violations + spec_violations
        report["csp_violations"] = {"agents": agents_violations, "spec": spec_violations}
        assert violations == [], violations
        assert not report["page_errors"], report["page_errors"]
    finally:
        if context is not None:
            context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=("states", "captures", "real"), required=True)
    parser.add_argument("--url")
    parser.add_argument("--assignment")
    parser.add_argument("--probe-dir")
    parser.add_argument("--package")
    parser.add_argument("--workspace", default="")
    args = parser.parse_args()
    if args.case == "real":
        required = {"--url": args.url, "--assignment": args.assignment, "--probe-dir": args.probe_dir, "--package": args.package}
        missing = [name for name, value in required.items() if not value]
        if missing:
            parser.error(f"--case real requires {', '.join(missing)}")
    receipt_names = {"states": "ev-5-terminal.json", "captures": "ev-8-terminal-captures.json", "real": "ev-6-real-player.json"}
    receipt = receipt_dir / receipt_names[args.case]
    report = {"case": args.case, "status": "failed", "cases": [], "captures": [], "page_errors": []}
    started = time.monotonic()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
            if args.case == "states":
                run_states(browser, report)
            elif args.case == "real":
                run_real(browser, report, args)
            else:
                run_captures(browser, report)
        report["status"] = "passed"
    except BaseException as exc:
        report["error"] = repr(exc)
        raise
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - started, 2)
        write_receipt(receipt, report)
    print(json.dumps({
        "status": report["status"],
        "elapsed_seconds": report["elapsed_seconds"],
        "receipt": str(receipt),
        "cases": report["cases"],
        "captures": report["captures"],
    }))


if __name__ == "__main__":
    main()
