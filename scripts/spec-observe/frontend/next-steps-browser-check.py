# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Next steps browser cases (EV-4 list, EV-7 launch) over the opt-in fixture.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=/tmp/sentinel-next-steps-evidence uv run --script \
  scripts/spec-observe/frontend/next-steps-browser-check.py --case list
SENTINEL_EVIDENCE_DIR=/tmp/sentinel-next-steps-evidence uv run --script \
  scripts/spec-observe/frontend/next-steps-browser-check.py --case launch

The list case drives the actual built App at #/next-steps with normal startup
over the SENTINEL_NEXT_STEPS=1 fixture, controls only the HTTP transport, the
local token boundary and the browser clock, and never touches private
Solid/store state or dispatches a worker. It also starts a second fixture
without the opt-in flag to prove the default startup/control/scan path is
unchanged.

The launch case drives the built App through the Critique-filtered list
hand-off, cold critics/spec entries, observed Inputs facts, the origin return
and refused/unconfirmed launches over the same opt-in fixture, composed with
the real createDiscussionService save/preview/launch owner. Only the final
pi/tmux process boundary is fake: no operator storage is touched, every
resolver/store/authority fact is real, and no operator assignment starts.

The landing case drives the built App at empty and unknown hashes to prove
Next steps is the live All-workspaces landing, that the rail waiting badge
matches only a trustworthy scoped scan (invariant under filters/queries,
absent at zero/failure and after import), that import lands Specs with
polling stopped, and that every rail entry mounts only its own
adapter-owned region with fixture content. It derives its expected badge
count from raw fixture responses only; no worker is started and no operator
storage is touched.

Each case writes SENTINEL_EVIDENCE_DIR/report.json atomically with the
observed revision/dirty, elapsed seconds, errors, scenarios and capture
paths, even on failure, and stops every fixture/browser process in finally.
"""
import argparse
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from playwright.sync_api import expect, sync_playwright
from reference_screens import reference_screens

CASES = ("list", "landing", "launch")
QA_ROUTES = ("#/next-steps", "#/launch", "#/conversations", "#/specs", "#/agents", "#/epics", "#/files")
CASE_DEADLINE_SECONDS = 180
DEFAULT_MODE_DEADLINE_SECONDS = 60
REFERENCE_SCREENS = (
    "01-next-steps",
    "02-next-steps-epic",
    "03-next-steps-critique",
    "04-next-steps-proposal-direct",
    "05-next-steps-proposal-rejected",
    "06-next-steps-work-tour",
    "07-next-steps-running",
    "11-next-steps-empty",
    "12-next-steps-no-matches",
    "13-next-steps-loading",
    "14-next-steps-error",
    "15-next-steps-partial",
    "16-next-steps-denied",
    "17-next-steps-offline",
    "18-next-steps-stale",
)
LAUNCH_REFERENCE_SCREENS = ("08-critique-review", "09-critique-result", "10-spec-review")
# Reference height follows the design viewport; production captures use the
# same sizes for a like-for-like comparison.
WIDTH_HEIGHTS = ((1280, 800), (1600, 900))
# Independent literal tally derived from the known seeded slugs (landed is
# omitted by its snapshot-only recent completion; incompatible and running have
# no filter action).
EXPECTED_FILTER_COUNTS = {"All": 10, "Plan": 1, "Critique": 1, "Spec": 3, "Implement": 2, "Review": 1}
EXPECTED_STAGES = {
    "recommended": "proposal",
    "direct": "proposal",
    "incompatible": "proposal",
    "critiqued": "critique",
    "ready": "spec",
    "waiting": "spec",
    "tour": "work-tour",
    "running": "proposal",
    "markup": "proposal",
    "landed": "proposal",
    "new-epic": "epic",
}
ROOT = Path(__file__).resolve().parent
SCRIPT = Path(__file__).resolve()


def design_screens() -> Path | None:
    return reference_screens("new-files")


def spawn_fixture(env_extra: dict | None = None) -> subprocess.Popen:
    env = dict(os.environ)
    for key in ("SENTINEL_NEXT_STEPS", "SENTINEL_HANDOFF_INTEGRATION", "SENTINEL_PLANNED_LAUNCH",
                "SENTINEL_SPECS_READINESS", "SENTINEL_EPIC_PLANNING", "SENTINEL_REPOSITORY_FILES"):
        env.pop(key, None)
    if env_extra:
        env.update(env_extra)
    return subprocess.Popen(
        ["node", str(ROOT / "browser-fixture.mjs")],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        start_new_session=True,
    )


def fixture_receipt(fixture: subprocess.Popen, report: dict, label: str) -> dict:
    if not select.select([fixture.stdout], [], [], 30)[0]:
        raise RuntimeError(f"{label} fixture did not become ready within 30 seconds")
    line = fixture.stdout.readline()
    if not line:
        raise RuntimeError(f"{label} fixture exited before readiness: {fixture.stderr.read()}")
    return json.loads(line)


def stop_fixture(fixture: subprocess.Popen | None) -> None:
    if fixture is None:
        return
    try:
        os.killpg(fixture.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        fixture.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(fixture.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        fixture.wait()


def observed_revision() -> tuple[str | None, bool | None]:
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())
        return commit, dirty
    except Exception:
        return None, None


def atomic_report(report: dict, evidence: Path, name: str = "report.json") -> None:
    evidence.mkdir(parents=True, exist_ok=True)
    temporary = evidence / f".{name}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    os.replace(temporary, evidence / name)


def attach_console_evidence(page, label: str, report: dict, expected_statuses: tuple[str, ...] = ("503",)) -> None:
    """Record console.error/pageerror authority evidence. Intentional HTTP
    resource faults whose status the case deliberately drives (503 by default,
    409 for the stale-preview refusal) are expected and kept separate from
    unexpected runtime errors, which still fail the case."""
    def on_console(message):
        if message.type != "error":
            return
        entry = {"page": label, "text": message.text}
        if "Failed to load resource" in message.text and any(status in message.text for status in expected_statuses):
            report["expectedConsole"].append(entry)
        else:
            report["consoleErrors"].append(entry)

    page.on("console", on_console)


def write_qa(report: dict, evidence: Path, title: str = "Next steps list evidence walkthrough (EV-4)") -> None:
    """Atomic procedural walkthrough for evidence/qa.md. Results come
    from this run's report, never hand-copied timestamps or outcomes."""
    scenarios = report.get("scenarios", [])
    captures = sorted({Path(item).name for item in report.get("captures", [])})
    integration = (report.get("fixture") or {}).get("integration")
    integration_on = bool(integration.get("enabled")) if isinstance(integration, dict) else bool(integration)
    lines = [
        f"# {title}",
        "",
        "Execution metadata lives in `report.json` and in the owner's linked runtime verification artifact; no run-specific receipt id is embedded here.",
        "",
        "## Preconditions",
        "",
        "- Built dashboard from this checkout: `npm run build --prefix scripts/spec-observe/frontend`.",
        "- Opt-in fixture `SENTINEL_NEXT_STEPS=1` with isolated storage, HOME and owned process tree.",
        "- Checker controls only HTTP transport, the local assignment token and the browser clock.",
        *(["- The fixture also runs `SENTINEL_HANDOFF_INTEGRATION=1`: save/preview/launch compose through the real discussion service and only the final tmux/pi adapters are fake."] if integration_on else []),
        "",
        "## Routes",
        "",
        *[f"- `{route}`" for route in QA_ROUTES],
        "",
        "## Scenarios",
        "",
        *[f"- {item}" for item in scenarios],
        "",
        "## Evidence",
        "",
        "- `report.json` (this run, atomic) and `next-steps-list.json` (identical per-case copy).",
        f"- {len(captures)} captures, including `production-*.png` and `reference-*.png`.",
        *[f"- `{name}`" for name in captures[:40]],
        "",
        "## Status",
        "",
        f"- status: {report.get('status')}",
        f"- elapsedSeconds: {report.get('elapsedSeconds')}",
        f"- observedCommit: {report.get('observedCommit')}",
        f"- dirty: {report.get('dirty')}",
    ]
    temporary = evidence / ".qa.md.tmp"
    temporary.write_text("\n".join(lines) + "\n")
    os.replace(temporary, evidence / "qa.md")


def run_default_mode_assertion(report: dict) -> dict:
    """Without SENTINEL_NEXT_STEPS the default startup, control and real scan
    path stay unchanged and expose no opt-in metadata."""
    fixture = spawn_fixture()
    deadline = time.monotonic() + DEFAULT_MODE_DEADLINE_SECONDS
    result = {"optInAbsent": False, "stateOk": False, "scanOk": False, "controlClean": False}
    try:
        receipt = fixture_receipt(fixture, report, "default")
        assert "nextSteps" not in receipt, receipt
        state = request_json(fixture, receipt["url"], "/api/state")
        result["stateOk"] = bool(state.get("observers"))
        control = request_json(fixture, receipt["url"], "/__fixture/control")
        result["controlClean"] = "nextSteps" not in control
        scan = request_json(fixture, receipt["url"], "/api/next-steps")
        result["scanOk"] = isinstance(scan.get("rows"), list) and isinstance(scan.get("coverage"), dict)
        assert result["stateOk"] and result["controlClean"] and result["scanOk"], result
        assert time.monotonic() < deadline, "default-mode assertion exceeded its deadline"
        result["optInAbsent"] = True
        report["defaultMode"] = result
        report["scenarios"].append("Default mode (no SENTINEL_NEXT_STEPS) startup, control and real scan stay unchanged and expose no opt-in metadata")
        return result
    finally:
        stop_fixture(fixture)


def request_json(fixture: subprocess.Popen, base: str, path: str, **params) -> dict:
    url = base + path + ("?" + urlencode(params) if params else "")
    response = fixture_request(url)
    assert response.ok, f"{url} -> {response.status}"
    return response.json()


def fixture_request(url: str):
    # A tiny urllib-free JSON fetch keeps the checker free of extra deps.
    import http.client
    from urllib.parse import urlparse
    parsed = urlparse(url)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=20)
    connection.request("GET", parsed.path + (("?" + parsed.query) if parsed.query else ""))
    response = connection.getresponse()
    body = response.read()
    connection.close()

    class Response:
        def __init__(self, status, body):
            self.status = status
            self.ok = 200 <= status < 300
            self._body = body

        def json(self):
            return json.loads(self._body.decode("utf-8"))

    return Response(response.status, body)


def run_list_case(report: dict, fixture: subprocess.Popen, receipt: dict, evidence: Path, deadline: float) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=shutil.which("google-chrome"),
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        attach_console_evidence(page, "production", report)
        post_urls: list[str] = []
        workspace_reads: list[dict] = []
        page.on("request", lambda request: post_urls.append(request.url) if request.method == "POST" else None)

        def record_workspace_request(request):
            if "/api/workspace?" in request.url:
                workspace_reads.append({"url": request.url, "hash": urlparse(page.url).fragment, "at": time.monotonic()})

        page.on("request", record_workspace_request)

        def check_deadline(label: str) -> None:
            if time.monotonic() > deadline:
                raise RuntimeError(f"list case exceeded the {CASE_DEADLINE_SECONDS} second deadline at {label}")

        def control(action=None, value=None, **extra):
            params = {}
            if action is not None:
                params["action"] = action
                params["value"] = str(value).lower() if isinstance(value, bool) else str(value)
            params.update(extra)
            return request_json(fixture, receipt["url"], "/__fixture/control", **params)

        # Remote default exposes only a thread token; make the fixture local
        # before the built App starts so the ideal list is actionable.
        control("next-local", True)

        def goto_next_steps(query: str = "") -> None:
            page.goto(receipt["url"] + "/#/next-steps" + (("?" + query) if query else ""), wait_until="domcontentloaded")
            expect(page.locator("h1")).to_have_text("New files waiting for a next step")
            expect(page.locator("table.queue-table")).to_be_visible(timeout=20000)

        def row_key(workspace: str, kind: str, slug: str) -> str:
            return json.dumps([workspace, kind, slug], separators=(",", ":"))

        def row(slug: str, workspace: str = "fixture", kind: str = "package"):
            key = row_key(workspace, kind, slug)
            return page.locator(f"tr.queue-row[data-next-step-key={json.dumps(key)}]")

        def select_slug(slug: str, workspace: str = "fixture", kind: str = "package") -> None:
            row(slug, workspace, kind).locator("a.subject").click()
            expect(page.locator("#next-step-heading")).to_have_text(slug)

        def route_parts() -> tuple[str, dict]:
            fragment = urlparse(page.url).fragment
            path, _, query = fragment.partition("?")
            return path.lstrip("/"), {key: values[0] for key, values in parse_qs(query).items()}

        def record_action_diagnostics(label: str) -> None:
            # Shared diagnostics for any failed async wait: the inline action
            # error, the current body and the fixture posts/resolver facts.
            try:
                error_note = page.locator(".next-steps-action-error")
                if error_note.count():
                    report["errors"].append(f"{label} actionError: {error_note.first.inner_text()}")
            except Exception:
                pass
            try:
                report["errors"].append(f"{label} body: {page.locator('body').inner_text()[:800]}")
            except Exception:
                pass
            try:
                control_state = request_json(fixture, receipt["url"], "/__fixture/control")
                relevant = [item for item in control_state.get("posts", []) if item.get("name") in ("prepareSpecTarget", "dispatchSaveBrief", "dispatchPreview", "dispatchLaunch", "saveBrief", "create", "send")]
                report["errors"].append(f"{label} posts: {json.dumps(relevant[-6:])[:2000]}")
                report["errors"].append(f"{label} resolvers: {json.dumps(control_state.get('diagnostics', {}).get('resolvers', [])[-6:])}")
            except Exception:
                pass

        def wait_for_route(pattern: str, label: str) -> None:
            # Handoff and discussion clicks settle asynchronously (saved brief /
            # resolved workspace inventory) before the shell navigates. Wait for
            # the URL and record diagnosable facts instead of a bare timeout.
            try:
                expect(page).to_have_url(re.compile(pattern))
            except Exception:
                report["errors"].append(f"{label}: URL did not reach /{pattern}/; actual {page.url}")
                record_action_diagnostics(label)
                raise

        def wait_for_body_text(value: str, label: str) -> None:
            # Consumer surfaces (launch review) populate after the workspace and
            # catalog loads; wait on the rendered subject instead of racing.
            try:
                expect(page.locator("body")).to_contain_text(value)
            except Exception:
                report["errors"].append(f"{label}: body did not contain {value!r}; actual {page.url}")
                record_action_diagnostics(label)
                raise

        def primary_action():
            return page.locator(".detail-actions button.ds-btn--primary, .detail-actions a.ds-btn--primary").first

        def text_actions():
            return page.locator(".detail-actions button.text-link, .detail-actions a.text-link")

        def capture(name: str) -> None:
            for width, height in WIDTH_HEIGHTS:
                page.set_viewport_size({"width": width, "height": height})
                page.evaluate("() => { const pane = document.querySelector('.detail-pane .detail-body'); if (pane) pane.scrollTo(0, 0); }")
                path = evidence / f"production-{name}-{width}.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
                report["overflow"][f"{name}-{width}"] = page.evaluate(
                    """() => { const pane = document.querySelector('.detail-pane .detail-body'); return pane ? {scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight} : null; }"""
                )
            page.set_viewport_size({"width": 1280, "height": 900})

        def capture_scrolled(name: str) -> None:
            for width, height in WIDTH_HEIGHTS:
                page.set_viewport_size({"width": width, "height": height})
                metrics = page.evaluate(
                    """() => { const pane = document.querySelector('.detail-pane .detail-body'); if (!pane) return null; pane.scrollTo(0, pane.scrollHeight); return {scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight}; }"""
                )
                report["overflow"][f"{name}-{width}-scrolled"] = metrics
                page.wait_for_timeout(150)
                path = evidence / f"production-{name}-{width}-scrolled.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
            page.set_viewport_size({"width": 1280, "height": 900})

        def notice_titles() -> list[str]:
            return [item.inner_text().strip() for item in page.locator(".detail-body .ds-callout strong").all()]

        def assert_single_notice() -> None:
            count = page.locator(".detail-body .ds-callout").count()
            assert count <= 1, f"expected at most one regional notice, found {count}"

        # --- 1. Real scan, stages, filter tally and navigation -------------- #
        scan = request_json(fixture, receipt["url"], "/api/next-steps")
        assert scan["schema_version"] == 1, scan
        assert scan["coverage"]["state"] in ("complete", "partial"), scan["coverage"]
        scan_rows = {item["slug"]: item for item in scan["rows"]}
        for slug, stage in EXPECTED_STAGES.items():
            assert slug in scan_rows, f"{slug} missing from the real scan: {sorted(scan_rows)}"
            assert scan_rows[slug]["stage"] == stage, (slug, scan_rows[slug]["stage"])
            assert scan_rows[slug]["key"] == row_key("other" if slug == "incompatible" else "fixture", "epic" if slug == "new-epic" else "package", slug), scan_rows[slug]["key"]
        for slug, item in scan_rows.items():
            packaged = receipt["nextSteps"]["packages"].get(slug)
            if packaged is not None:
                assert item["package"] == packaged["dir"], (slug, item["package"], packaged["dir"])
        recommended_stat = receipt["nextSteps"]["packages"]["recommended"]["files"]["proposal.md"]
        assert recommended_stat["exists"] and recommended_stat["mtimeMs"], recommended_stat
        report["scan"] = {"coverage": scan["coverage"]["state"], "rows": sorted(scan_rows), "slugs": len(scan_rows), "recommendedMtime": recommended_stat["mtimeIso"]}
        report["scenarios"].append("Real GET /api/next-steps reports every seeded stage from owned files including the recent-completion row; the model/UI omits the landed package and fixture stat/paths match")

        goto_next_steps()
        tabs = {}
        for button in page.locator(".filter-strip button").all():
            label = button.inner_text().strip()
            name = label.rsplit(" ", 1)[0]
            tabs[name] = int(label.rsplit(" ", 1)[1])
        assert tabs == EXPECTED_FILTER_COUNTS, (tabs, EXPECTED_FILTER_COUNTS)
        expect(row("running").locator("button.step-link")).to_have_text("Open agent")
        assert row("landed").count() == 0
        report["scenarios"].append("Primary filter counts match the independent fixture tally; running opens an agent and landed is absent; the arrival capture shows the actual newest-first selection before reference-01 subject selection")
        capture("01-next-steps-arrival")
        select_slug("recommended")
        capture("01-next-steps")

        for slug, workspace, expected_primary, expected_status in (
            ("recommended", "fixture", "Critique proposal", "Critique recommended"),
            ("direct", "fixture", "Write spec", "Compatible"),
            ("critiqued", "fixture", "Write spec", "4 recommendations"),
            ("tour", "fixture", "Review work tour", "Merge evidence ready"),
            ("running", "fixture", "Open agent", "Running"),
            ("ready", "fixture", "Implement spec", "Spec"),
            ("waiting", "fixture", "Open spec", "Spec"),
            ("incompatible", "other", "Discuss proposal", "Incompatible"),
        ):
            select_slug(slug, workspace)
            expect(primary_action()).to_have_text(expected_primary)
            expect(page.locator(".object-top .status")).to_have_text(expected_status)
            if slug == "waiting":
                # spec.md alone supplies neither a prepared index nor report.
                expect(page.locator(".detail-body")).to_contain_text("Not planned")
                capture("waiting-readiness")
        report["scenarios"].append("Selecting each seeded subject shows its independently expected suggested action and exact observed status")

        # Epic subject with real member planning and the next-member launch route.
        select_slug("new-epic", kind="epic")
        expect(primary_action()).to_have_text("Plan members")
        expect(page.locator(".object-top .status")).to_have_text("Planned")
        members_fact = page.locator(".facts .fact").filter(has_text="Members")
        expect(members_fact.locator("strong")).to_have_text("2")
        expect(members_fact).to_contain_text("wave 1")
        epic_table = page.locator("table.epic-members")
        expect(epic_table).to_be_visible()
        expect(epic_table).to_contain_text("epic-first")
        expect(epic_table).to_contain_text("epic-second")
        report["scenarios"].append("The planned epic detail shows its observed member table with epic-first and epic-second")
        report["scenarios"].append("The planned epic row shows real member facts and the Plan members action")
        capture("02-next-steps-epic")
        published_before_plan = request_json(fixture, receipt["url"], "/__fixture/control")["launch"]["published"]
        primary_action().click()
        wait_for_route(r"#/launch\?", "plan members handoff")
        dest, query = route_parts()
        assert dest == "launch", (dest, query)
        assert query.get("package") == receipt["nextSteps"]["packages"]["epic-first"]["dir"], query
        assert query.get("skill") == "spec-architect-initial", query
        assert request_json(fixture, receipt["url"], "/__fixture/control")["launch"]["published"] == published_before_plan
        report["scenarios"].append("Plan members opens the exact epic-first launch package with the initial planning skill and no dispatch")
        goto_next_steps()
        select_slug("critiqued")
        capture("03-next-steps-critique")
        capture_scrolled("03-next-steps-critique")
        select_slug("direct")
        capture("04-next-steps-proposal-direct")
        select_slug("incompatible", "other")
        capture("05-next-steps-proposal-rejected")
        select_slug("tour")
        capture("06-next-steps-work-tour")
        pr_url = "https://github.com/adjacent-storage/agents/pull/10"
        context.route(pr_url, lambda route: route.fulfill(status=200, content_type="text/html", body="<!doctype html><html><body><h1>Isolated PR fixture</h1></body></html>"))
        with page.expect_popup() as popup_info:
            text_actions().filter(has_text="Open pull request").click()
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded")
        assert popup.url == pr_url, popup.url
        popup.close()
        context.unroute(pr_url)
        report["scenarios"].append("Open pull request opens the exact GitHub pull URL from an isolated route with no external network")
        select_slug("running")
        capture("07-next-steps-running")

        # Navigate secondary Open file to the Files path and rendered subject.
        select_slug("recommended")
        text_actions().filter(has_text="Open file").click()
        dest, query = route_parts()
        assert dest == "files" and query.get("ws") == "fixture" and query.get("source") == "workspace", (dest, query)
        assert query.get("path") == "specs/recommended/proposal.md", query
        expect(page.locator(".record.selected")).to_have_count(1)
        report["scenarios"].append("Open file reaches the exact Files route and selected path")

        # The critiqued proposal opens its own observed proposal file.
        goto_next_steps()
        select_slug("critiqued")
        text_actions().filter(has_text="Open proposal").click()
        dest, query = route_parts()
        assert dest == "files" and query.get("ws") == "fixture" and query.get("source") == "workspace", (dest, query)
        assert query.get("path") == "specs/critiqued/proposal.md", query
        expect(page.locator(".record.selected")).to_have_count(1)
        report["scenarios"].append("Open proposal reaches the exact critiqued proposal Files path and selected record")

        # Navigate the epic Open epic secondary to the exact Epics subject.
        goto_next_steps()
        select_slug("new-epic", kind="epic")
        text_actions().filter(has_text="Open epic").click()
        dest, query = route_parts()
        assert dest == "epics" and query.get("ws") == "fixture", (dest, query)
        assert query.get("id") == json.dumps(["fixture", "new-epic"], separators=(",", ":")), query
        expect(page.locator(".object-head h2")).to_have_text("New epic")
        report["scenarios"].append("Open epic reaches the exact Epics key and rendered epic subject")

        # Waiting Open spec reaches Specs Ready with the observed planned key.
        goto_next_steps()
        select_slug("waiting")
        primary_action().click()
        dest, query = route_parts()
        assert dest == "specs" and query.get("filter") == "ready", (dest, query)
        expected_spec_id = json.dumps(["fixture", receipt["nextSteps"]["packages"]["waiting"]["dir"], "planned-package", None], separators=(",", ":"))
        assert query.get("id") == expected_spec_id, (query.get("id"), expected_spec_id)
        expect(page.locator(".record.selected")).to_have_count(1)
        report["scenarios"].append("Open spec reaches the exact Specs Ready id and rendered selection")

        # Running Open agent reaches Agents with the observed assignment subject.
        goto_next_steps()
        select_slug("running")
        primary_action().click()
        dest, query = route_parts()
        assert dest == "agents" and query.get("ws") == "fixture", (dest, query)
        expected_agent_id = json.dumps(["fixture", "11111111-2222-4333-8444-555555555555"], separators=(",", ":"))
        assert query.get("id") == expected_agent_id, (query.get("id"), expected_agent_id)
        selected_agent = page.locator(":is(.record.selected, .run-row[aria-pressed='true'])")
        expect(selected_agent).to_have_count(1)
        expect(page.locator(".detail-pane")).to_contain_text("11111111-2222-4333-8444-555555555555")
        report["scenarios"].append("Open agent reaches the exact Agents key and rendered assignment subject")
        goto_next_steps()

        # Primary launch entries seed the real saved brief and route to launch
        # without any worker dispatch.
        published_before = request_json(fixture, receipt["url"], "/__fixture/control")["launch"]["published"]
        select_slug("recommended")
        primary_action().click()
        wait_for_route(r"#/launch\?", "critique handoff")
        dest, query = route_parts()
        assert dest == "launch", (dest, query)
        assert query.get("package") == receipt["nextSteps"]["packages"]["recommended"]["dir"], query
        assert query.get("skill") == "spec-architect-critics" and query.get("stop") == "critique", query
        wait_for_body_text("recommended", "critique launch subject")
        assert request_json(fixture, receipt["url"], "/__fixture/control")["launch"]["published"] == published_before
        report["scenarios"].append("Critique proposal saves the brief and routes to the exact launch package/skill/stop with no dispatch")
        goto_next_steps()
        select_slug("recommended")
        text_actions().filter(has_text="Write spec").click()
        wait_for_route(r"#/launch\?", "write spec handoff")
        dest, query = route_parts()
        assert dest == "launch", (dest, query)
        assert query.get("package") == receipt["nextSteps"]["packages"]["recommended"]["dir"], query
        assert query.get("skill") == "spec-write", query
        assert request_json(fixture, receipt["url"], "/__fixture/control")["launch"]["published"] == published_before
        report["scenarios"].append("Write spec on the critique-recommended proposal opens the exact recommended package with spec-write and no dispatch")
        goto_next_steps()
        select_slug("ready")
        primary_action().click()
        wait_for_route(r"#/launch\?", "implement handoff")
        dest, query = route_parts()
        assert dest == "launch" and query.get("tab") == "review", (dest, query)
        assert query.get("package") == receipt["nextSteps"]["packages"]["ready"]["dir"], query
        assert query.get("skill") == "spec-end-to-end", query
        wait_for_body_text("ready", "implement launch subject")
        assert request_json(fixture, receipt["url"], "/__fixture/control")["launch"]["published"] == published_before
        report["scenarios"].append("Implement spec routes to the exact launch review with the implementation skill and no dispatch")
        goto_next_steps()

        # Incompatible discuss: exactly one workspace read, canonical alias seed,
        # unsent conversations dialog, no create/send.
        workspace_reads.clear()
        creates_before = len([item for item in request_json(fixture, receipt["url"], "/__fixture/control")["posts"] if item["name"] == "create"])
        sends_before = len([item for item in request_json(fixture, receipt["url"], "/__fixture/control")["posts"] if item["name"] == "send"])
        # Bracket the action to the first hashchange so the explicit resolver
        # fetch is attributed to the next-steps phase while the normal
        # destination load is allowed and recorded separately.
        page.evaluate("""() => {
            window.__nextStepsFirstHash = null;
            window.__nextStepsFirstHashAt = null;
            window.addEventListener('hashchange', () => {
                if (window.__nextStepsFirstHash === null) {
                    window.__nextStepsFirstHash = location.hash;
                    window.__nextStepsFirstHashAt = Date.now();
                }
            }, {once: true});
        }""")
        select_slug("incompatible", "other")
        primary_action().click()
        wait_for_route(r"#/conversations\?", "discuss")
        first_hash = page.evaluate("() => ({ hash: window.__nextStepsFirstHash, at: window.__nextStepsFirstHashAt })")
        action_reads = [entry for entry in workspace_reads if (entry.get("hash") or "").startswith("/next-steps")]
        destination_reads = [entry for entry in workspace_reads if entry not in action_reads]
        report["discuss"] = {"actionReads": action_reads, "destinationReads": destination_reads, "firstHashChange": first_hash}
        dest, query = route_parts()
        assert dest == "conversations" and query.get("ws") == "other" and query.get("tab") == "new", (dest, query)
        assert "incompatible" not in page.url, page.url
        assert len(action_reads) == 1, workspace_reads
        assert "id=other" in action_reads[0]["url"], action_reads
        dialog = page.locator("#thread-new-dialog")
        expect(dialog).to_be_visible()
        prepared = page.locator("#thread-new-fields .thread-new-prepared")
        expect(prepared).to_contain_text("incompatible")
        expect(prepared).to_contain_text("Verdict: Incompatible")
        expect(page.locator("#thread-new-target")).to_have_value("other-alias")
        control_after = request_json(fixture, receipt["url"], "/__fixture/control")
        assert len([item for item in control_after["posts"] if item["name"] == "create"]) == creates_before
        assert len([item for item in control_after["posts"] if item["name"] == "send"]) == sends_before
        report["scenarios"].append("Discuss proposal reads /api/workspace once, seeds the canonical other-alias and opens the unsent dialog with no create or send")

        # Failed resolver via the existing detail-fail boundary: inline error,
        # unchanged route, no seed.
        page.goto(receipt["url"] + "/#/next-steps", wait_until="domcontentloaded")
        goto_next_steps()
        control("detail-fail", True)
        select_slug("incompatible", "other")
        primary_action().click()
        error_note = page.locator(".next-steps-action-error")
        expect(error_note).to_be_visible()
        expect(page).to_have_url(re.compile(r"#/next-steps"))
        expect(page.locator("#thread-new-dialog")).to_have_count(0)
        control("detail-fail", False)
        report["scenarios"].append("A failed workspace resolver stays inline with no seed and no navigation")
        goto_next_steps()

        # --- 2. Markup summary is literal text ------------------------------ #
        select_slug("markup")
        expect(page.locator(".object-top .status")).to_have_text("Compatible")
        excerpt = page.locator(".excerpt").first
        expect(excerpt).to_contain_text("<img src=x onerror=")
        assert page.locator('img[src="x"]').count() == 0
        assert page.evaluate("() => window.__fixtureInjected") is None
        report["scenarios"].append("Literal markup in an observed summary renders as text with no element or handler execution")

        # --- 3. Presentation freeze and continuity -------------------------- #
        # AC-13 boundaries missing from the original All-with-siblings case:
        # the sole Critique match changes stage; the last in-scope row leaves.
        for boundary in ("filtered-stage", "last-removal"):
            control("next-reset")
            held_page = context.new_page()
            held_page.clock.install()
            held_page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
            attach_console_evidence(held_page, boundary, report)
            if boundary == "last-removal":
                def sole_scan(route):
                    response = route.fetch()
                    payload = response.json()
                    payload["rows"] = [item for item in payload["rows"] if item["slug"] == "recommended"]
                    payload["coverage"] = {**payload["coverage"], "state": "complete", "reasons": [], "unread": []}
                    route.fulfill(response=response, json=payload)
                held_page.route("**/api/next-steps", sole_scan)
            suffix = "?filter=critique" if boundary == "filtered-stage" else ""
            held_page.goto(receipt["url"] + "/#/next-steps" + suffix, wait_until="domcontentloaded")
            held_row = held_page.locator('tr.queue-row').filter(has=held_page.locator('a.subject', has_text="recommended"))
            expect(held_row).to_be_visible(timeout=20000)
            held_row.locator("a.subject").click()
            button = held_row.locator("button.step-link")
            button.hover()
            button.evaluate("el => { el.focus(); window.__heldNode = el; }")
            before = held_row.bounding_box()["y"]
            mutation = control("next-critique") if boundary == "filtered-stage" else control("next-remove", slug="recommended")
            live_scan = request_json(fixture, receipt["url"], "/api/next-steps")
            if boundary == "filtered-stage":
                assert mutation["file"]["exists"]
                assert next(item for item in live_scan["rows"] if item["slug"] == "recommended")["stage"] == "critique"
            else:
                assert mutation["stats"][0]["exists"] is False
                assert not any(item["slug"] == "recommended" for item in live_scan["rows"])
            held_page.clock.run_for(31000)
            held_page.wait_for_timeout(400)
            expect(held_row).to_be_visible()
            assert held_page.evaluate("() => window.__heldNode === document.activeElement")
            assert abs(held_row.bounding_box()["y"] - before) < 1
            expect(held_page.locator("#next-step-heading")).to_have_text("recommended")
            if boundary == "filtered-stage":
                expect(button).to_have_text("Write spec")
                expect(button).to_be_enabled()
                expect(held_page.locator(".detail-actions button").first).to_have_text("Write spec")
            else:
                expect(held_row).to_have_class(re.compile("unavailable"))
                expect(button).to_be_disabled()
                expect(held_page.locator(".detail-actions button").first).to_be_disabled()
            shot = evidence / f"production-{boundary}-held.png"
            held_page.screenshot(path=str(shot))
            report["captures"].append(str(shot))
            if boundary == "last-removal":
                held_page.locator(".list-refresh button").evaluate("el => el.click()")
                held_page.wait_for_timeout(300)
                assert held_page.evaluate("() => window.__heldNode === document.activeElement")
            held_page.mouse.move(0, 0)
            held_page.evaluate("() => document.activeElement.blur()")
            expect(held_page.locator("tr.queue-row")).to_have_count(0)
            expect(held_page.get_by_text("No matching files" if boundary == "filtered-stage" else "No new planning or review files", exact=True)).to_be_visible()
            report["scenarios"].append(f"{boundary}: held active node/position/selection survives live empty classification, current action updates, exit flushes")
            held_page.close()
        control("next-reset")
        freeze_page = context.new_page()
        freeze_page.set_default_timeout(15000)
        freeze_page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        attach_console_evidence(freeze_page, "freeze", report)
        state_response_log: list[dict] = []

        def record_state_response(response):
            # Bounded authority diagnostics: token PRESENCE only, never the
            # secret value, plus generated_at and delivery timing.
            if "/api/state" in response.url:
                try:
                    payload = response.json()
                    state_response_log.append({
                        "status": response.status,
                        "hasActionToken": "action_token" in payload,
                        "hasThreadToken": "thread_action_token" in payload,
                        "generatedAt": payload.get("generated_at"),
                        "at": time.monotonic(),
                    })
                except Exception:
                    state_response_log.append({"status": response.status, "unparseable": True, "at": time.monotonic()})

        freeze_page.on("response", record_state_response)
        freeze_page.clock.install()
        freeze_page.goto(receipt["url"] + "/#/next-steps", wait_until="domcontentloaded")
        expect(freeze_page.locator("table.queue-table")).to_be_visible(timeout=20000)

        def freeze_row(slug, workspace="fixture", kind="package"):
            key = json.dumps([workspace, kind, slug], separators=(",", ":"))
            return freeze_page.locator(f"tr.queue-row[data-next-step-key={json.dumps(key)}]")

        def freeze_active_key():
            return freeze_page.evaluate("() => document.activeElement && document.activeElement.closest('[data-next-step-key]') ? document.activeElement.closest('[data-next-step-key]').dataset.nextStepKey : null")

        def freeze_active_same() -> bool:
            return bool(freeze_page.evaluate("() => window.__nextStepsActive === document.activeElement"))

        def freeze_geometry(label: str) -> dict:
            # Bounded geometry snapshot recorded before/after each freeze
            # mutation so a position failure names the boundary that moved.
            geometry = freeze_page.evaluate("""(label) => {
                const rows = [...document.querySelectorAll('tr.queue-row')].map(row => {
                    const box = row.getBoundingClientRect();
                    const step = row.querySelector('button.step-link');
                    return {
                        key: row.dataset.nextStepKey,
                        y: box.y,
                        height: box.height,
                        className: row.className,
                        action: step ? step.textContent.trim() : (row.querySelector('.step-text') ? row.querySelector('.step-text').textContent.trim() : null),
                        disabled: step ? step.disabled : null,
                        note: row.querySelector('.step-note') ? row.querySelector('.step-note').textContent.trim() : null,
                    };
                });
                const records = document.querySelector('.list-pane .records');
                const caption = document.querySelector('#next-steps-caption');
                const controls = document.querySelector('.list-controls');
                const active = document.activeElement;
                return {
                    label: label,
                    order: rows.map(row => row.key),
                    rows,
                    records: records ? { scrollTop: records.scrollTop, clientHeight: records.clientHeight } : null,
                    caption: caption ? { height: caption.getBoundingClientRect().height, text: caption.textContent } : null,
                    listControls: controls ? { height: controls.getBoundingClientRect().height } : null,
                    notices: [...document.querySelectorAll('.ds-callout')].map(item => item.querySelector('strong') ? item.querySelector('strong').textContent.trim() : ''),
                    active: active ? { tag: active.tagName, className: active.className, key: active.closest('[data-next-step-key]') ? active.closest('[data-next-step-key]').dataset.nextStepKey : null } : null,
                };
            }""", label)
            report.setdefault("freezeGeometry", {})[label] = geometry
            return geometry

        def assert_frozen_position(label: str, expected_y: float) -> None:
            geometry = freeze_geometry(label)
            actual = next((row["y"] for row in geometry["rows"] if row["key"] == recommended_key), None)
            if actual is None or abs(actual - expected_y) >= 1:
                screenshot = evidence / "production-freeze-failure.png"
                freeze_page.screenshot(path=str(screenshot), full_page=False)
                report["captures"].append(str(screenshot))
                raise AssertionError(f"{label}: recommended row y {actual} != {expected_y}; geometry={json.dumps(geometry)}; recorded={json.dumps(report.get('freezeGeometry'))}")

        recommended_key = json.dumps(["fixture", "package", "recommended"], separators=(",", ":"))
        # Freeze assertions require a real selected subject: the initial page
        # selects the newest row, so select recommended first and wait for its
        # detail/route identity before focusing the row.
        freeze_row("recommended").locator("a.subject").click()
        expect(freeze_page.locator("#next-step-heading")).to_have_text("recommended")
        freeze_fragment = urlparse(freeze_page.url).fragment
        _, _, freeze_query_raw = freeze_fragment.partition("?")
        freeze_query = {key: values[0] for key, values in parse_qs(freeze_query_raw).items()}
        assert freeze_query.get("id") == recommended_key, freeze_query
        recommended_step = freeze_row("recommended").locator("button.step-link")
        recommended_step.hover()
        recommended_step.focus()
        top_before = freeze_row("recommended").bounding_box()["y"]
        assert freeze_active_key() == recommended_key, freeze_active_key()
        freeze_geometry("baseline")
        arrive = control("next-arrive")
        assert arrive["slug"] == "arrive-1" and arrive["file"]["exists"] and arrive["file"]["mtimeMs"], arrive
        arrive_scan = request_json(fixture, receipt["url"], "/api/next-steps")
        assert any(item["slug"] == "arrive-1" for item in arrive_scan["rows"]), sorted(item["slug"] for item in arrive_scan["rows"])
        freeze_page.clock.run_for(31000)
        freeze_page.wait_for_timeout(400)
        assert freeze_row("arrive-1").count() == 0, "arrival must stay out while the table is frozen"
        assert_frozen_position("after-arrival", top_before)
        assert freeze_active_key() == recommended_key, freeze_active_key()
        critique = control("next-critique")
        assert critique["file"]["exists"] and critique["file"]["mtimeMs"], critique
        reviewed = request_json(fixture, receipt["url"], "/api/next-steps")
        reviewed_row = next(item for item in reviewed["rows"] if item["slug"] == "recommended")
        assert reviewed_row["stage"] == "critique", reviewed_row
        assert reviewed_row["key"] == recommended_key, reviewed_row
        assert reviewed_row["written_at"], reviewed_row
        assert "architecture is sound" in (reviewed_row["signal"].get("assessment") or ""), reviewed_row["signal"]
        freeze_page.clock.run_for(31000)
        freeze_page.wait_for_timeout(400)
        expect(recommended_step).to_have_text("Write spec")
        assert_frozen_position("after-critique", top_before)
        direct_height = freeze_row("direct").bounding_box()["height"]
        removed = control("next-remove", slug="direct")
        direct_stats = [item for item in removed["stats"] if item["path"].endswith("direct/proposal.md")]
        assert direct_stats and direct_stats[0]["exists"] is False, removed
        freeze_page.clock.run_for(31000)
        freeze_page.wait_for_timeout(400)
        assert "unavailable" in (freeze_row("direct").get_attribute("class") or "")
        assert freeze_row("direct").locator("button.step-link").is_disabled()
        assert abs(freeze_row("direct").bounding_box()["height"] - direct_height) < 2
        # Leaving both pointer and focus flushes order and membership.
        freeze_page.mouse.move(0, 0)
        freeze_page.evaluate("() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }")
        freeze_page.wait_for_timeout(300)
        assert freeze_row("arrive-1").count() == 1
        assert freeze_row("direct").count() == 0
        # Explicit refresh goes through the real button via a DOM click (no
        # pointer focus move) and keeps the same active node for a same-key row.
        recommended_step = freeze_row("recommended").locator("button.step-link")
        assert recommended_step.evaluate("el => { el.focus(); window.__nextStepsActive = el; return document.activeElement === el; }")
        control("next-arrive")
        freeze_page.clock.run_for(31000)
        freeze_page.wait_for_timeout(300)
        refresh_control = request_json(fixture, receipt["url"], "/__fixture/control")
        refresh_mutation = refresh_control["nextSteps"]["lastMutation"]
        assert refresh_mutation and refresh_mutation["action"] == "next-arrive", refresh_mutation
        freeze_page.locator(".list-refresh button", has_text="Refresh files").evaluate("el => el.click()")
        # Wait for the refreshed scan to land and render the current flushed
        # order before sending the next mutation; the visible first row must be
        # the known newest arrival.
        expected_arrival_key = json.dumps(["fixture", "package", refresh_mutation["slug"]], separators=(",", ":"))
        try:
            expect(freeze_page.locator("tr.queue-row").first).to_have_attribute("data-next-step-key", expected_arrival_key)
        except Exception:
            record_action_diagnostics("refresh flush")
            raise
        assert freeze_active_same(), "refresh must preserve the same focused node for a same-key row"
        # The explicit flush may legitimately reorder (AC13): assert the exact
        # active node, the selected subject and the current sorted order from
        # the known mutation instead of the pre-flush y.
        freeze_geometry("after-refresh")
        assert freeze_page.evaluate("() => document.querySelector('tr.queue-row') ? document.querySelector('tr.queue-row').dataset.nextStepKey : null") == expected_arrival_key
        assert freeze_page.evaluate("() => document.querySelector('tr.queue-row.selected') ? document.querySelector('tr.queue-row.selected').dataset.nextStepKey : null") == recommended_key
        # A new arrival while the table is frozen stays out of the frozen
        # membership; token removal then updates eligibility only.
        recommended_step = freeze_row("recommended").locator("button.step-link")
        assert recommended_step.evaluate("el => { el.focus(); window.__nextStepsActive = el; return document.activeElement === el; }")
        frozen_arrival = control("next-arrive")
        assert frozen_arrival["file"]["exists"], frozen_arrival
        freeze_page.clock.run_for(31000)
        freeze_page.wait_for_timeout(400)
        assert freeze_row(frozen_arrival["slug"]).count() == 0, "a new arrival stays out while frozen"
        # Drain any in-flight browser state request, then bracket the token
        # removal to the next real /api/state poll so the authority update is
        # observed from the browser itself (never private store state).
        freeze_page.clock.run_for(1000)
        freeze_page.wait_for_timeout(300)
        before_state_count = len(state_response_log)
        control("next-local", False)
        settled_via_response = True
        try:
            with freeze_page.expect_response(lambda response: "/api/state" in response.url, timeout=8000) as state_info:
                freeze_page.clock.run_for(6000)
                delivered = state_info.value.json()
                assert isinstance(delivered, dict), delivered
        except Exception:
            # Documented bounded fallback when the fake clock cannot settle the
            # interval through expect_response: drain the clock explicitly and
            # record the fallback instead of switching to the Shell refresh
            # (which would explicitly flush the frozen hold).
            settled_via_response = False
            report["errors"].append("token removal: state poll did not settle via expect_response; drained fake clock as documented fallback")
            freeze_page.clock.run_for(6000)
            freeze_page.wait_for_timeout(600)
        bracket_responses = state_response_log[before_state_count:]
        assert bracket_responses, "no /api/state response observed after token removal"
        if settled_via_response:
            assert len(bracket_responses) == 1, bracket_responses
        after_state = bracket_responses[-1]
        assert after_state.get("hasActionToken") is False, after_state
        assert after_state.get("hasThreadToken") is True, after_state
        report["tokenAuthority"] = {
            "beforeCount": before_state_count,
            "bracketResponses": bracket_responses,
            "settledViaResponse": settled_via_response,
            "generatedAt": after_state.get("generatedAt"),
        }
        try:
            expect(freeze_page.locator(".detail-body .ds-callout")).to_contain_text("Read only")
            expect(freeze_row("recommended").locator("button.step-link")).to_be_disabled()
        except Exception:
            record_action_diagnostics("token removal")
            report["errors"].append(f"token removal route: {freeze_page.url}")
            report["errors"].append(f"token removal state responses: {json.dumps(bracket_responses[-4:])}")
            freeze_geometry("token-removal-failed")
            screenshot = evidence / "production-token-failure.png"
            freeze_page.screenshot(path=str(screenshot), full_page=False)
            report["captures"].append(str(screenshot))
            raise
        # Explicit guard: a held/aria-disabled table action must not navigate or
        # write any post when activated by pointer or keyboard.
        guard_state = request_json(fixture, receipt["url"], "/__fixture/control")
        posts_before = len(guard_state["posts"])
        published_before = guard_state["launch"]["published"]
        route_before = freeze_page.url
        freeze_row("recommended").locator("button.step-link").evaluate("el => el.click()")
        freeze_page.wait_for_timeout(300)
        assert freeze_page.url == route_before, (freeze_page.url, route_before)
        guard_after = request_json(fixture, receipt["url"], "/__fixture/control")
        assert len(guard_after["posts"]) == posts_before, guard_after["posts"]
        assert guard_after["launch"]["published"] == published_before, guard_after["launch"]
        assert freeze_row(frozen_arrival["slug"]).count() == 0
        control("next-local", True)
        freeze_page.clock.run_for(6000)
        freeze_page.wait_for_timeout(400)
        assert freeze_active_same()
        freeze_geometry("token-frozen")
        # A focused removed key keeps its placeholder after an explicit refresh
        # until its focus exits.
        assert recommended_step.evaluate("el => { el.focus(); window.__nextStepsActive = el; return document.activeElement === el; }")
        removed_recommended = control("next-remove", slug="recommended")
        assert removed_recommended["stats"][0]["exists"] is False, removed_recommended
        freeze_page.clock.run_for(31000)
        freeze_page.wait_for_timeout(300)
        freeze_page.locator(".list-refresh button", has_text="Refresh files").evaluate("el => el.click()")
        freeze_page.wait_for_timeout(300)
        assert "unavailable" in (freeze_row("recommended").get_attribute("class") or ""), "focused removed key keeps its placeholder after explicit refresh"
        freeze_page.evaluate("() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }")
        freeze_page.wait_for_timeout(300)
        assert freeze_row("recommended").count() == 0
        report["scenarios"].append("Freeze holds membership/order across arrival, same-key critique and removal with stable bounding/focus, flushes when both pointer and focus leave, and explicit refresh preserves the same active node for a same-key row and the focused removed placeholder until blur; a new arrival while frozen stays withheld and token removal while frozen updates eligibility only")
        freeze_page.close()
        control("next-reset")

        # --- 4. Nine production states -------------------------------------- #
        state_page = context.new_page()
        state_page.set_default_timeout(15000)
        state_page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        attach_console_evidence(state_page, "states", report)
        state_page.clock.install()

        def raw_scan():
            return request_json(fixture, receipt["url"], "/api/next-steps")

        def assert_raw_rows(expected_slugs, label):
            scan = raw_scan()
            actual = sorted(item["slug"] for item in scan.get("rows", []))
            if actual != sorted(expected_slugs):
                report["errors"].append(f"{label}: raw scan rows {actual} != {sorted(expected_slugs)}; coverage={json.dumps(scan.get('coverage'))}")
            assert actual == sorted(expected_slugs), (label, actual, scan.get("coverage"))
            return scan

        def state_failure_diagnostics(label):
            try:
                caption = state_page.locator("#next-steps-caption").inner_text()
            except Exception:
                caption = None
            try:
                scan = raw_scan()
                rows = sorted(item["slug"] for item in scan.get("rows", []))
                coverage = scan.get("coverage")
            except Exception as error:
                rows, coverage = None, f"scan unavailable: {error}"
            report["errors"].append(f"{label}: caption={caption!r} rows={rows} coverage={json.dumps(coverage)}")

        def state_check(label, check):
            try:
                check()
            except Exception:
                state_failure_diagnostics(label)
                raise

        def assert_local_authority(label):
            control("next-local", True)
            payload = request_json(fixture, receipt["url"], "/api/state")
            if not payload.get("action_token"):
                receipt_local = request_json(fixture, receipt["url"], "/__fixture/control").get("local")
                report["errors"].append(f"{label}: raw /api/state lacks action_token; keys={sorted(payload.keys())}; fixtureLocal={receipt_local}")
            assert payload.get("action_token"), (label, sorted(payload.keys()))

        def goto_state(query=""):
            target = receipt["url"] + "/#/next-steps" + query
            if urlparse(state_page.url).fragment:
                # A same-path hash change is same-document and does not remount
                # the destination; force a real document reload so the current
                # fixture scan is observed through normal App startup.
                state_page.goto(target, wait_until="domcontentloaded")
                state_page.reload(wait_until="domcontentloaded")
            else:
                state_page.goto(target, wait_until="domcontentloaded")
            expect(state_page.locator("h1")).to_have_text("New files waiting for a next step")

        def state_notice():
            return state_page.locator(".detail-body .ds-callout")

        def assert_state_notice():
            assert state_notice().count() <= 1, state_notice().count()

        def capture_state(name):
            for width, height in WIDTH_HEIGHTS:
                state_page.set_viewport_size({"width": width, "height": height})
                path = evidence / f"production-{name}-{width}.png"
                state_page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
            state_page.set_viewport_size({"width": 1280, "height": 900})

        # complete empty
        control("next-empty")
        assert_raw_rows([], "complete empty")
        goto_state()
        state_check("complete empty", lambda: (
            expect(state_page.locator(".full-page .empty h2")).to_have_text("No new planning or review files"),
            expect(state_page.locator("table.queue-table")).to_have_count(0),
            expect(state_page.locator(".detail-body")).to_have_count(0),
        ))
        assert_state_notice()
        capture_state("11-next-steps-empty")

        # filtered empty
        control("next-reset")
        assert_raw_rows(list(EXPECTED_STAGES), "filtered empty reset")
        goto_state("?filter=review&q=no-such-file")
        state_check("filtered empty", lambda: expect(state_page.locator(".list-pane .empty h2")).to_have_text("No matching files"))
        capture_state("12-next-steps-no-matches")

        # partial with zero rows never claims there are no new files
        control("next-partial-zero")
        partial_scan = assert_raw_rows([], "partial zero")
        assert partial_scan["coverage"]["state"] == "partial", partial_scan["coverage"]
        goto_state()
        state_check("partial zero", lambda: (
            expect(state_notice()).to_contain_text("Some workspaces were not read"),
            expect(state_page.locator(".list-pane .empty h2", has_text="No new planning or review files")).to_have_count(0),
            expect(state_page.locator(".list-pane table.queue-table")).to_be_visible(),
            expect(state_page.locator(".detail-pane .empty h2")).to_have_text("No file selected"),
        ))
        assert_state_notice()
        capture_state("15-next-steps-partial")
        control("next-reset")
        assert_raw_rows(list(EXPECTED_STAGES), "loading reset")
        # Establish the local assignment authority before the ideal loading and
        # error states so the denied banner cannot outrank the scan-error notice.
        assert_local_authority("loading")

        # delayed loading on a fresh page
        control("next-scan-delay-ms", 2500)
        loading_page = context.new_page()
        loading_page.set_default_timeout(15000)
        loading_page.on("pageerror", lambda error: report["pageErrors"].append(f"loading: {error}"))
        attach_console_evidence(loading_page, "loading", report)
        loading_page.goto(receipt["url"] + "/#/next-steps", wait_until="domcontentloaded")
        expect(loading_page.locator("#next-steps-caption")).to_contain_text("Reading")
        assert loading_page.locator(".skeletons-table").count() == 0, "skeleton must be delayed"
        loading_page.wait_for_timeout(450)
        expect(loading_page.locator(".skeletons-table")).to_be_visible()
        for width, height in WIDTH_HEIGHTS:
            loading_page.set_viewport_size({"width": width, "height": height})
            path = evidence / f"production-13-next-steps-loading-{width}.png"
            loading_page.screenshot(path=str(path), full_page=False)
            report["captures"].append(str(path))
        control("next-scan-delay-ms", 0)
        # Let the delayed initial request settle into the real table before
        # closing the page so no Response.finished async noise is emitted.
        expect(loading_page.locator("table.queue-table")).to_be_visible(timeout=5000)
        loading_page.close()
        control("next-reset")
        assert_local_authority("error")

        # initial scan error on a fresh page, then live retry recovery
        control("next-scan-fail", True)
        fail_response = fixture_request(receipt["url"] + "/api/next-steps")
        assert fail_response.status == 503, fail_response.status
        error_page = context.new_page()
        error_page.set_default_timeout(15000)
        error_page.on("pageerror", lambda error: report["pageErrors"].append(f"error: {error}"))
        attach_console_evidence(error_page, "error", report)
        error_state_log: list[dict] = []

        def record_error_state_response(response):
            if "/api/state" in response.url:
                try:
                    payload = response.json()
                    error_state_log.append({
                        "status": response.status,
                        "hasActionToken": "action_token" in payload,
                        "hasThreadToken": "thread_action_token" in payload,
                        "generatedAt": payload.get("generated_at"),
                        "at": time.monotonic(),
                    })
                except Exception:
                    error_state_log.append({"status": response.status, "unparseable": True, "at": time.monotonic()})

        error_page.on("response", record_error_state_response)
        error_page.goto(receipt["url"] + "/#/next-steps", wait_until="domcontentloaded")
        expect(error_page.locator("#connection-status")).to_contain_text("Monitor connected")
        expect(error_page.locator(".full-page")).to_be_visible()
        expect(error_page.locator("#next-steps-caption")).to_contain_text("Scan unavailable")
        assert error_page.locator(".detail-body").count() == 0
        try:
            expect(error_page.locator(".full-page .ds-callout")).to_contain_text("Could not refresh next steps")
        except Exception:
            try:
                monitor = error_page.locator("#connection-status").inner_text()
            except Exception:
                monitor = None
            try:
                raw = request_json(fixture, receipt["url"], "/api/state")
                raw_action = "action_token" in raw
                raw_thread = "thread_action_token" in raw
            except Exception as error:
                raw_action, raw_thread = f"state unavailable: {error}", None
            receipt_local = request_json(fixture, receipt["url"], "/__fixture/control").get("local")
            report["errors"].append(f"error state: monitor={monitor!r} fixtureLocal={receipt_local} rawActionToken={raw_action} rawThreadToken={raw_thread} browserState={json.dumps(error_state_log[-4:])}")
            raise
        report["errorStateResponses"] = error_state_log
        for width, height in WIDTH_HEIGHTS:
            error_page.set_viewport_size({"width": width, "height": height})
            path = evidence / f"production-14-next-steps-error-{width}.png"
            error_page.screenshot(path=str(path), full_page=False)
            report["captures"].append(str(path))
        control("next-scan-fail", False)
        error_page.locator(".full-page .ds-callout button", has_text="Refresh files").click()
        expect(error_page.locator("table.queue-table")).to_be_visible(timeout=20000)
        error_page.close()
        report["scenarios"].append("Delayed loading shows the skeleton after 300ms; a failed initial scan shows the error notice and a live retry recovers")

        # denied: local boundary removes the local assignment token while the
        # thread token remains, held actions stay single-notice
        goto_state()
        control("next-local", False)
        state_page.clock.run_for(6000)
        state_page.wait_for_timeout(400)
        denied_payload = request_json(fixture, receipt["url"], "/api/state")
        assert "action_token" not in denied_payload, sorted(denied_payload.keys())
        assert denied_payload.get("thread_action_token"), sorted(denied_payload.keys())
        state_check("denied", lambda: expect(state_notice()).to_contain_text("Read only"))
        assert state_page.locator("#next-steps-caption").count() == 1
        denied_key = json.dumps(["fixture", "package", "recommended"], separators=(",", ":"))
        expect(state_page.locator(f"tr.queue-row[data-next-step-key={json.dumps(denied_key)}] button.step-link")).to_be_disabled()
        capture_state("16-next-steps-denied")
        control("next-local", True)

        # offline: state transport failure is the single notice with retry
        goto_state()
        control("state-fail", True)
        state_page.clock.run_for(6000)
        state_page.wait_for_timeout(400)
        offline_notice = state_notice()
        if offline_notice.count() == 0:
            state_page.reload(wait_until="domcontentloaded")
        state_check("offline", lambda: expect(state_notice()).to_contain_text("Reconnecting"))
        expect(state_notice().locator("button", has_text="Retry connection")).to_be_visible()
        assert_state_notice()
        assert state_page.locator("#notice").count() == 0
        capture_state("17-next-steps-offline")
        control("state-fail", False)
        state_notice().locator("button", has_text="Retry connection").click()
        state_page.wait_for_timeout(500)

        # stale: clock advance beyond the fresh-scan window with the scan retained
        control("next-scan-fail", True)
        control("state-clock-offset-ms", 130000)
        state_page.clock.run_for(31000)
        state_page.wait_for_timeout(500)
        state_check("stale", lambda: expect(state_notice()).to_contain_text("older than two minutes"))
        expect(state_notice().locator("button", has_text="Refresh files")).to_be_visible()
        assert_state_notice()
        assert state_page.locator("#notice").count() == 0
        capture_state("18-next-steps-stale")
        control("state-clock-offset-ms", 0)
        control("next-scan-fail", False)
        control("next-reset")
        state_page.close()
        report["scenarios"].append("Denied, offline and stale each render one regional notice with the recovery action; partial zero rows never claims No new files")

        browser.close()
    check_deadline("end")


def run_landing_case(report: dict, fixture: subprocess.Popen, receipt: dict, evidence: Path, deadline: float) -> None:
    """EV-8 landing/badge gate over the SENTINEL_NEXT_STEPS=1 fixture.

    Proves the live All-workspaces landing, the raw-derived rail waiting badge
    and its filter/query/scope invariances, scoped home, import without later
    scan polling and rail adapter traversal. The expected badge count is
    derived by this checker from raw fixture responses only: no production
    railCount/nextStepRows import, no private Solid/store state, no worker.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=shutil.which("google-chrome"),
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on("pageerror", lambda error: report["pageErrors"].append(f"landing: {error}"))
        attach_console_evidence(page, "landing", report)

        def check_deadline(label: str) -> None:
            if time.monotonic() > deadline:
                raise RuntimeError(f"landing case exceeded the {CASE_DEADLINE_SECONDS} second deadline at {label}")

        # Adapter-owned roots and fixture-content probes. The hash, rail entry
        # and h1 are produced by App/Shell from the route and registry label, so
        # they stay true even when a registry entry renders the wrong component.
        # Each root below is rendered only by its own destination adapter, and
        # each probe uses real fixture content, so a misbound registry entry (a
        # Specs/Epics render swap, for example) fails these assertions.
        adapter_roots = {
            "next-steps": ".next-steps-destination",
            "specs": ".specs-destination",
            "epics": ".epics-destination",
            "agents": ".agents-list",
            "conversations": ".conversations-destination",
            "files": ".files-destination",
            "designs": ".design-canvas",
            "workspaces": ".workspace-destination",
        }
        adapter_probes = {
            "specs": (".specs-destination .list-caption", "observed specs"),
            "epics": (".epics-destination .list-caption", "epic record"),
            "agents": (".agents-list", "11111111-2222-4333-8444-555555555555"),
            "conversations": (".conversations-destination .thread-row", "Discussion one"),
            "files": (".files-destination .file-record", "briefs/browser.md"),
            "designs": (".design-canvas", "Screen 1"),
            "workspaces": (".workspace-destination .record.selected", "Browser fixture"),
        }

        def control(action=None, value=None, **extra):
            params = {}
            if action is not None:
                params["action"] = action
                params["value"] = str(value).lower() if isinstance(value, bool) else str(value)
            params.update(extra)
            return request_json(fixture, receipt["url"], "/__fixture/control", **params)

        def badge():
            return page.locator('.nav-item[data-area="next-steps"] .nav-count')

        def scope_select():
            return page.locator('select[aria-label="Workspace scope"]')

        def route_hash() -> str:
            return urlparse(page.url).fragment

        def wait_for_hash(expected: str, label: str) -> None:
            try:
                page.wait_for_function("value => location.hash === value", arg=expected)
            except Exception:
                report["errors"].append(f"{label}: hash did not reach {expected}; actual {route_hash()}")
                raise
            assert route_hash() == expected, route_hash()

        def wait_for_hash_prefix(prefix: str, label: str) -> None:
            try:
                page.wait_for_function("value => location.hash.startsWith(value)", arg=prefix)
            except Exception:
                report["errors"].append(f"{label}: hash did not reach {prefix}*; actual {route_hash()}")
                raise

        def derived_badge_count(workspace_id: str | None = None) -> int:
            # Independent predicate: an ok-signal scan row counts unless a
            # running current-assignment run or a recently completed record
            # owns its slug/package identity. Never the production helpers.
            scan_payload = request_json(fixture, receipt["url"], "/api/next-steps")
            state_payload = request_json(fixture, receipt["url"], "/api/state")
            excluded: set[str] = set()
            for observer in state_payload.get("observers", []):
                snapshot = observer.get("snapshot") or {}
                for run in snapshot.get("runs") or []:
                    if run.get("execution") == "running" and run.get("is_current_assignment") is True:
                        excluded.update(str(run[field]) for field in ("package", "package_ref") if run.get(field))
                for run in snapshot.get("recently_completed") or []:
                    excluded.update(str(run[field]) for field in ("package", "package_ref") if run.get(field))
            count = 0
            for row in scan_payload.get("rows") or []:
                if (row.get("signal") or {}).get("state") != "ok":
                    continue
                if workspace_id is not None and row.get("workspace_id") != workspace_id:
                    continue
                identities = {str(row[field]) for field in ("slug", "package", "package_ref") if row.get(field)}
                if identities & excluded:
                    continue
                count += 1
            return count

        def assert_badge_count(count: int, label: str) -> None:
            if count > 0:
                expect(badge()).to_be_visible(timeout=20000)
                expect(badge()).to_have_text(str(count))
                actual = badge().get_attribute("aria-label")
                assert actual == f"{count} waiting", (label, count, actual)
            else:
                actual_zero = page.locator(".nav-count").count()
                assert actual_zero == 0, (label, actual_zero)

        def refresh_files() -> None:
            # A settled partial scan keeps its Refresh files action in the
            # selected row's detail callout, not only in .full-page, so accept
            # either notice location instead of depending on which scan
            # generation rendered last.
            button = page.locator(".list-refresh button, .ds-callout button").filter(has_text="Refresh files")
            expect(button.first).to_be_visible(timeout=20000)
            button.first.click()

        def wait_for_landing() -> None:
            expect(page.locator("table.queue-table")).to_be_visible(timeout=20000)
            expect(badge()).to_be_visible(timeout=20000)

        control("next-local", True)
        try:
            # --- A. Landing default and valid destinations ------------------ #
            check_deadline("landing-default")
            page.goto(receipt["url"] + "/", wait_until="domcontentloaded")
            wait_for_hash_prefix("#/next-steps", "empty hash")
            assert "ws=" not in route_hash(), route_hash()
            expect(page.locator("#main h1")).to_have_text("New files waiting for a next step")
            assert scope_select().input_value() == "", scope_select().input_value()
            primary_first = page.locator('nav[aria-label="Primary"] .nav-item').first
            expect(primary_first).to_have_attribute("data-area", "next-steps")
            expect(primary_first).to_have_attribute("aria-current", "page")
            report["scenarios"].append("An empty hash canonicalizes to #/next-steps with the Next steps h1, an All workspaces scope and the first primary rail entry current")

            page.goto(receipt["url"] + "/#/unknown?id=7&ws=fixture", wait_until="domcontentloaded")
            wait_for_hash_prefix("#/next-steps", "unknown hash")
            assert "ws=" not in route_hash(), route_hash()
            expect(page.locator("#main h1")).to_have_text("New files waiting for a next step")
            assert scope_select().input_value() == "", scope_select().input_value()
            report["scenarios"].append("An unknown hash with id/ws parameters canonicalizes to #/next-steps and drops the parameters")

            for dest, label in (("specs", "Specs"), ("epics", "Epics")):
                page.goto(receipt["url"] + f"/#/{dest}", wait_until="domcontentloaded")
                wait_for_hash_prefix(f"#/{dest}", f"{dest} hash visit")
                expect(page.locator(f'.nav-item[data-area="{dest}"]')).to_have_attribute("aria-current", "page")
                expect(page.locator(adapter_roots[dest])).to_be_visible(timeout=20000)
                expect(page.locator("#main h1")).to_have_text(label)
            report["scenarios"].append("Hash visits to #/specs and #/epics stay on those routes with their own rail entry current, the matching adapter root mounted and the Shell h1 naming the route")

            # --- B. Badge truth from raw responses --------------------------- #
            check_deadline("badge-truth")
            page.goto(receipt["url"] + "/#/next-steps", wait_until="domcontentloaded")
            wait_for_landing()
            all_count = derived_badge_count()
            assert all_count > 0, all_count
            assert_badge_count(all_count, "all workspaces")
            report["scenarios"].append(f"The live All-workspaces rail badge equals the raw-derived count {all_count} with aria-label {all_count} waiting; running and recently completed packages are excluded")

            # --- C. Filter/query invariance and non-subset ------------------- #
            check_deadline("invariance")
            page.locator(".filter-strip button", has_text="Critique").click()
            page.wait_for_function("count => document.querySelectorAll('tr.queue-row').length < count", arg=all_count)
            visible_after_filter = page.locator("tr.queue-row").count()
            assert_badge_count(all_count, "critique filter")
            page.locator(".filter-strip button", has_text="All").click()
            page.wait_for_function("count => document.querySelectorAll('tr.queue-row').length > count", arg=visible_after_filter)
            assert_badge_count(all_count, "all filter restore")
            page.locator("#next-steps-find").fill("markup")
            page.wait_for_function("count => document.querySelectorAll('tr.queue-row').length < count", arg=all_count)
            visible_after_query = page.locator("tr.queue-row").count()
            assert_badge_count(all_count, "markup query")
            page.locator("#next-steps-find").fill("")
            page.wait_for_function("count => document.querySelectorAll('tr.queue-row').length > count", arg=visible_after_query)
            assert_badge_count(all_count, "query restore")
            report["scenarios"].append(f"The badge stays at {all_count} while the Critique filter shrinks the visible rows to {visible_after_filter} and the markup query to {visible_after_query}, so it is neither the visible nor the searched subset")

            # --- D. Scope respect and scoped home ---------------------------- #
            check_deadline("scope-home")
            other_count = derived_badge_count("other")
            scope_select().select_option("other")
            page.wait_for_function("() => location.hash.includes('ws=other')")
            assert_badge_count(other_count, "other scope")
            report["scenarios"].append(f"Selecting the other workspace shows the raw-derived in-scope badge {other_count} ({other_count} waiting)")

            fixture_count = derived_badge_count("fixture")
            scope_select().select_option("fixture")
            page.wait_for_function("() => location.hash.includes('ws=fixture')")
            assert_badge_count(fixture_count, "fixture scope")
            page.locator(".brand").click()
            wait_for_hash_prefix("#/specs?ws=fixture", "scoped brand")
            assert "ws=fixture" in route_hash(), route_hash()
            expect(page.locator('.nav-item[data-area="specs"]')).to_have_attribute("aria-current", "page")
            assert page.locator("table.queue-table").count() == 0, "next-steps table must be absent on scoped Specs home"
            expect(page.locator(adapter_roots["specs"])).to_be_visible(timeout=20000)
            expect(page.locator(adapter_probes["specs"][0]).first).to_contain_text(adapter_probes["specs"][1])
            report["scenarios"].append("With workspace fixture the brand opens #/specs?ws=fixture, marks Specs current, mounts the Specs adapter with its observed-spec caption and unmounts the next-steps table")

            scope_select().select_option("")
            page.wait_for_timeout(300)
            page.locator(".brand").click()
            wait_for_hash_prefix("#/next-steps", "All-workspaces brand")
            assert "ws=" not in route_hash(), route_hash()
            expect(page.locator("#main h1")).to_have_text("New files waiting for a next step")
            report["scenarios"].append("Back at All workspaces the brand returns to #/next-steps")

            # --- E. Zero and unavailable badge ------------------------------- #
            check_deadline("zero-unavailable")
            control("next-empty")
            refresh_files()
            expect(page.locator(".full-page .empty h2")).to_have_text("No new planning or review files")
            assert page.locator(".nav-count").count() == 0, "zero rows must show no rail badge"
            report["scenarios"].append("An empty live scan shows the empty surface and zero rail badge elements")

            control("next-reset")
            page.reload(wait_until="domcontentloaded")
            wait_for_landing()
            assert_badge_count(all_count, "reset restore")
            report["scenarios"].append(f"Resetting the scan and reloading restores the {all_count} badge")

            control("next-scan-fail", True)
            page.reload(wait_until="domcontentloaded")
            expect(page.locator(".full-page .ds-callout")).to_contain_text("Could not refresh next steps")
            assert page.locator(".nav-count").count() == 0, "a failed scan must show no rail badge"
            control("next-scan-fail", False)
            page.locator(".full-page .ds-callout button", has_text="Refresh files").click()
            wait_for_landing()
            assert_badge_count(all_count, "scan-fail restore")
            report["scenarios"].append(f"A failed initial scan shows no badge; the notice Refresh files retry restores the {all_count} badge")

            # --- F. Import lands Specs and stops scanning -------------------- #
            check_deadline("import")
            import_page = context.new_page()
            import_page.set_default_timeout(15000)
            import_page.on("pageerror", lambda error: report["pageErrors"].append(f"import: {error}"))
            attach_console_evidence(import_page, "import", report)
            import_temp = evidence / f".landing-import-{os.getpid()}.json"
            next_steps_requests: list[str] = []
            import_page.on("request", lambda request: next_steps_requests.append(request.url) if "/api/next-steps" in request.url else None)
            try:
                import_page.clock.install()
                import_page.goto(receipt["url"] + "/#/next-steps", wait_until="domcontentloaded")
                expect(import_page.locator('.nav-item[data-area="next-steps"] .nav-count')).to_be_visible(timeout=20000)
                import_temp.write_text(json.dumps(request_json(fixture, receipt["url"], "/api/state")))
                import_page.locator("#import-file").set_input_files(str(import_temp))
                expect(import_page).to_have_url(re.compile(r"#/specs(\?|$)"))
                assert urlparse(import_page.url).fragment.startswith("/specs"), import_page.url
                expect(import_page.locator("#connection-status")).to_contain_text("Imported snapshot")
                requests_at_import = len(next_steps_requests)
                import_page.clock.run_for(35000)
                import_page.wait_for_timeout(300)
                assert len(next_steps_requests) == requests_at_import, next_steps_requests
                assert import_page.locator(".nav-count").count() == 0, "an imported snapshot must show no rail badge"
                report["scenarios"].append(f"Importing a real /api/state envelope lands #/specs with the Imported snapshot status; 35s of clock time produced no /api/next-steps request after import ({requests_at_import} total) and no rail badge")
            finally:
                import_page.close()
                import_temp.unlink(missing_ok=True)

            # --- G. Rail adapter traversal ----------------------------------- #
            check_deadline("rail")
            scope_select().select_option("fixture")
            page.wait_for_function("() => location.hash.includes('ws=fixture')")
            for dest, label in (("specs", "Specs"), ("epics", "Epics"), ("agents", "Agents"), ("conversations", "Conversations"), ("files", "Files"), ("designs", "Designs"), ("workspaces", "Workspaces")):
                page.locator(f'.nav-item[data-area="{dest}"]').click()
                wait_for_hash_prefix(f"#/{dest}", f"rail {dest}")
                expect(page.locator(f'.nav-item[data-area="{dest}"]')).to_have_attribute("aria-current", "page")
                expect(page.locator("#main h1")).to_have_text(label)
                expect(page.locator(adapter_roots[dest])).to_be_visible(timeout=20000)
                probe, expected = adapter_probes[dest]
                expect(page.locator(probe).first).to_contain_text(expected)
                # The route swaps bodies: no other adapter root may remain mounted.
                for other, other_root in adapter_roots.items():
                    if other != dest:
                        assert page.locator(other_root).count() == 0, (dest, other, f"{other_root} still mounted on #/{dest}")
                if dest in ("conversations", "files", "designs"):
                    assert "ws=fixture" in route_hash(), (dest, route_hash())
            report["scenarios"].append("Each rail entry renders its own adapter-owned region with fixture content (Specs observed-spec caption, Epics epic-record caption, Agents retained assignment row, Conversations thread, Files loaded filename, Designs screen canvas, Workspaces selected workspace record), leaves no other adapter body mounted and keeps ws=fixture on the scoped destinations")

            # --- H. Production captures -------------------------------------- #
            check_deadline("captures")
            scope_select().select_option("")
            page.wait_for_timeout(300)
            page.locator('.nav-item[data-area="next-steps"]').click()
            wait_for_landing()
            assert_badge_count(all_count, "capture landing")
            for width, height in WIDTH_HEIGHTS:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(150)
                path = evidence / f"production-01-next-steps-{width}.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
            page.set_viewport_size({"width": 1280, "height": 900})
            report["scenarios"].append("The live All-workspaces landing with its badge and table is captured at both production viewport sizes")
        finally:
            context.close()
            browser.close()
    check_deadline("end")


def run_launch_case(report: dict, fixture: subprocess.Popen, receipt: dict, evidence: Path, deadline: float) -> None:
    """EV-7 bound plan/implement review and result journey.

    Drives the actual built App through the Critique-filtered list hand-off,
    the cold critics/spec entries (including a catalog kit id that differs
    from the storage directory basename), observed Inputs facts, the origin
    return and refused/unconfirmed launches. The fixture runs
    SENTINEL_NEXT_STEPS=1 over SENTINEL_HANDOFF_INTEGRATION=1, so save,
    preview and launch compose through the real discussion service and only
    the final tmux/pi process adapters are fake. No worker starts, no operator
    storage is touched and no private Solid state is seeded.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=shutil.which("google-chrome"),
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        # The real stale-preview refusal is an intentional 409 response.
        attach_console_evidence(page, "launch", report, expected_statuses=("409", "503"))

        def check_deadline(label: str) -> None:
            if time.monotonic() > deadline:
                raise RuntimeError(f"launch case exceeded the {CASE_DEADLINE_SECONDS} second deadline at {label}")

        def control(action=None, value=None, **extra):
            params = {}
            if action is not None:
                params["action"] = action
                params["value"] = str(value).lower() if isinstance(value, bool) else str(value)
            params.update(extra)
            return request_json(fixture, receipt["url"], "/__fixture/control", **params)

        def control_state() -> dict:
            return request_json(fixture, receipt["url"], "/__fixture/control")

        def named_posts(name: str) -> list[dict]:
            return [entry for entry in control_state().get("posts", []) if entry.get("name") == name]

        def launch_posts() -> list[dict]:
            return named_posts("dispatchLaunch")

        def next_steps_meta() -> dict:
            meta = control_state().get("nextSteps")
            assert isinstance(meta, dict) and isinstance(meta.get("packages"), dict), meta
            return meta

        def package_dir(slug: str) -> str:
            entry = next_steps_meta()["packages"].get(slug)
            assert entry and entry.get("dir"), (slug, entry)
            return entry["dir"]

        def file_mtime_iso(slug: str, name: str) -> str:
            stat_entry = next_steps_meta()["packages"][slug]["files"].get(name)
            assert stat_entry and stat_entry.get("exists") and stat_entry.get("mtimeIso"), (slug, name, stat_entry)
            return stat_entry["mtimeIso"]

        def launch_url(package: str, skill: str, stop: str | None = None, tab: str | None = None, ws: str = "fixture") -> str:
            params = {"ws": ws, "package": package, "skill": skill}
            if stop is not None:
                params["stop"] = stop
            if tab is not None:
                params["tab"] = tab
            return receipt["url"] + "/#/launch?" + urlencode(params)

        def route_parts() -> tuple[str, dict]:
            fragment = urlparse(page.url).fragment
            path, _, query = fragment.partition("?")
            return path.lstrip("/"), {key: values[0] for key, values in parse_qs(query).items()}

        def wait_for_route(pattern: str, label: str) -> None:
            try:
                expect(page).to_have_url(re.compile(pattern))
            except Exception:
                report["errors"].append(f"{label}: URL did not reach /{pattern}/; actual {page.url}")
                raise

        def row_key(workspace: str, kind: str, slug: str) -> str:
            return json.dumps([workspace, kind, slug], separators=(",", ":"))

        def row(slug: str, workspace: str = "fixture", kind: str = "package"):
            return page.locator(f"tr.queue-row[data-next-step-key={json.dumps(row_key(workspace, kind, slug))}]")

        def select_slug(slug: str, workspace: str = "fixture", kind: str = "package") -> None:
            row(slug, workspace, kind).locator("a.subject").click()
            expect(page.locator("#next-step-heading")).to_have_text(slug)

        def primary_action():
            return page.locator(".detail-actions button.ds-btn--primary, .detail-actions a.ds-btn--primary").first

        def goto_next_steps(query: str = "") -> None:
            page.goto(receipt["url"] + "/#/next-steps" + (("?" + query) if query else ""), wait_until="domcontentloaded")
            expect(page.locator("h1")).to_have_text("New files waiting for a next step")
            expect(page.locator("table.queue-table")).to_be_visible(timeout=20000)

        def fact(key: str):
            return page.locator(f'#launch-review .launch-contract--package [data-fact={key}] dd')

        def result_fact(key: str):
            return page.locator(f'#launch-result-facts [data-fact={key}] dd')

        def wait_for_contract() -> None:
            expect(page.locator("#launch-review .launch-contract--package")).to_be_visible(timeout=20000)

        def submit_cold_review(package: str, skill: str, stop: str | None = None) -> None:
            page.goto(launch_url(package, skill, stop), wait_until="domcontentloaded")
            expect(page.locator("#launch-cold-bound")).to_have_count(0)
            expect(page.locator("#launch-brief-title")).not_to_have_value("")
            page.locator("#launch-save").click()
            wait_for_contract()

        def pane_metrics() -> dict:
            # The bound launch surface scrolls inside .full-page; window scroll
            # only moves the fixed-height shell and captures empty canvas.
            return page.evaluate(
                """() => { const pane = document.querySelector('.full-page'); if (!pane) return null; return {scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight, scrollTop: pane.scrollTop}; }"""
            )

        def capture(name: str, scroll_to: str | None = None) -> None:
            for width, height in WIDTH_HEIGHTS:
                page.set_viewport_size({"width": width, "height": height})
                if scroll_to:
                    page.locator(scroll_to).scroll_into_view_if_needed()
                    page.wait_for_timeout(150)
                else:
                    page.evaluate("() => { const pane = document.querySelector('.full-page'); if (pane) pane.scrollTo(0, 0); window.scrollTo(0, 0); }")
                    page.wait_for_timeout(100)
                path = evidence / f"production-{name}-{width}.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
                report["overflow"][f"{name}-{width}"] = pane_metrics()
            page.set_viewport_size({"width": 1280, "height": 900})

        def capture_scrolled(name: str) -> None:
            # Complementary lower capture at each viewport; the caller opens the
            # captured-input disclosures first so the image proves populated
            # content instead of a collapsed summary row.
            for width, height in WIDTH_HEIGHTS:
                page.set_viewport_size({"width": width, "height": height})
                page.evaluate("() => { const pane = document.querySelector('.full-page'); if (pane) pane.scrollTo(0, pane.scrollHeight); }")
                page.wait_for_timeout(150)
                path = evidence / f"production-{name}-{width}-scrolled.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
                report["overflow"][f"{name}-{width}-scrolled"] = pane_metrics()
            page.set_viewport_size({"width": 1280, "height": 900})

        def capture_review(name: str) -> None:
            # F5: the top capture preserves the review heading/package/execution
            # facts; the scrolled companion expands the captured-input
            # disclosure and preserves its populated content at both viewports.
            capture(name)
            expect(page.locator("#launch-what-pi")).to_be_visible()
            details = page.evaluate(
                """() => { const nodes = [...document.querySelectorAll('#launch-what-pi details')]; for (const node of nodes) node.open = true; return nodes.length; }"""
            )
            assert details > 0, "captured-input disclosure missing from the review"
            capture_scrolled(name)
            report["reviewCaptures"][name] = {"details": details, "open": details}

        def same_locale_time(iso: str) -> str:
            return page.evaluate("iso => new Date(iso).toLocaleString()", iso)

        control("next-local", True)
        recommended = package_dir("recommended")
        critiqued = package_dir("critiqued")
        direct = package_dir("direct")
        check_deadline("setup")

        # --- Cold critics-only contract, refusal and explicit spec entry ---- #
        submit_cold_review(recommended, "spec-architect-critics", "critique")
        expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
        expect(fact("stop")).to_have_text("critique.md")
        expect(fact("authority")).to_have_text("None")
        expected_critique_time = same_locale_time(file_mtime_iso("recommended", "proposal.md"))
        expect(fact("inputs")).to_contain_text("proposal.md")
        expect(fact("inputs")).to_contain_text("written")
        expect(fact("inputs")).to_contain_text(expected_critique_time)
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start critique")
        assert len(launch_posts()) == 0, launch_posts()
        report["scenarios"].append("Cold critics-only entry seeds Stops at critique.md with the observed proposal time, Start critique and no launch dispatch")
        check_deadline("cold-critique")

        saves_before = len(named_posts("dispatchSaveBrief"))
        page.goto(launch_url(critiqued, "spec-architect-critics", "critique"), wait_until="domcontentloaded")
        expect(page.locator("#launch-cold-bound")).to_have_attribute("data-cold-bound", "unavailable")
        expect(page.locator("#launch-cold-bound")).to_contain_text("A critique is already written")
        assert len(named_posts("dispatchSaveBrief")) == saves_before
        assert len(launch_posts()) == 0
        report["scenarios"].append("Cold critics entry on a package whose critique.md already exists refuses visibly with nothing saved or dispatched")
        check_deadline("cold-refusal")

        submit_cold_review(recommended, "spec-write", "prepared")
        expect(fact("stop")).to_have_text("Prepared spec")
        expect(fact("stages")).to_have_text("1 spec-write")
        expect(fact("inputs")).to_contain_text("proposal.md")
        expect(fact("inputs")).not_to_contain_text("critique.md")
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start spec")
        assert len(launch_posts()) == 0
        capture_review("10-spec-review")
        expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
        report["scenarios"].append("Cold explicit Write spec on the recommended proposal without a critique seeds the spec-write contract at the Prepared spec stop with proposal-only Inputs, Start spec and no dispatch")
        check_deadline("cold-spec")

        # --- Cold entry with a catalog kit id different from the directory --- #
        # EV-7 F4: the route carries kit id alpha while the storage directory
        # basename is physical; only the workspaceDirectory adapter plus the
        # basename comparison can join the route package to its snapshot row.
        alias = package_dir("kit-alias")
        alpha_workspace = request_json(fixture, receipt["url"], "/api/workspace", id="alpha")
        assert alpha_workspace["id"] == "alpha", alpha_workspace
        assert alpha_workspace["directory"].rstrip("/").rsplit("/", 1)[-1] == "physical", alpha_workspace
        alias_saves = len(named_posts("dispatchSaveBrief"))
        page.goto(launch_url(alias, "spec-architect-critics", "critique", ws="alpha"), wait_until="domcontentloaded")
        expect(page.locator("#launch-cold-bound")).to_have_count(0)
        expect(page.locator("#launch-brief-title")).not_to_have_value("")
        page.locator("#launch-save").click()
        wait_for_contract()
        expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
        expect(fact("target")).to_contain_text("fixture-repo")
        expect(fact("stop")).to_have_text("critique.md")
        expect(fact("authority")).to_have_text("None")
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start critique")
        assert len(named_posts("dispatchSaveBrief")) == alias_saves + 1, named_posts("dispatchSaveBrief")
        assert len(launch_posts()) == 0
        report["scenarios"].append("Cold entry for kit id alpha over directory physical seeds the offered critique-only contract and resolves its real target with nothing dispatched")
        check_deadline("cold-alias")

        # A conflicting identity (route workspace other) must refuse the same
        # package without saving, seeding a draft or dispatching. No private
        # store state is written by the checker.
        conflict_saves = len(named_posts("dispatchSaveBrief"))
        page.goto(launch_url(recommended, "spec-architect-critics", "critique", ws="other"), wait_until="domcontentloaded")
        expect(page.locator("#launch-cold-bound")).to_have_attribute("data-cold-bound", "unavailable")
        expect(page.locator("#launch-cold-bound")).to_contain_text("not observed in this workspace")
        assert len(named_posts("dispatchSaveBrief")) == conflict_saves, named_posts("dispatchSaveBrief")
        assert len(launch_posts()) == 0
        report["scenarios"].append("A cold route naming the wrong workspace for an observed package refuses visibly without saving, seeding a draft or dispatching")
        check_deadline("cold-identity-refusal")

        # --- Truthful derived facts and filename-only Inputs fallback ------- #
        submit_cold_review(recommended, "spec-architect-critics")
        expect(fact("stages")).to_have_text("1 spec-architect-critics → 2 spec-write")
        expect(fact("stop")).to_have_text("Prepared")
        expect(fact("model")).to_have_text("Host default")
        expect(fact("host")).to_have_text("Host not recorded for this assignment")
        report["scenarios"].append("Cold critics-resume review keeps the original derived stage sequence with the Prepared stop, Host default model and unrecorded host")
        check_deadline("truthful-plan")

        control("next-scan-fail", True)
        inputs_context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        inputs_page = inputs_context.new_page()
        inputs_page.set_default_timeout(15000)
        inputs_page.on("pageerror", lambda error: report["pageErrors"].append(f"inputs: {error}"))
        attach_console_evidence(inputs_page, "inputs", report)
        inputs_url = receipt["url"] + "/#/launch?" + urlencode({"ws": "fixture", "package": direct, "skill": "spec-architect-critics", "stop": "critique"})
        try:
            inputs_page.goto(inputs_url, wait_until="domcontentloaded")
            expect(inputs_page.locator("#launch-cold-bound")).to_have_count(0)
            expect(inputs_page.locator("#launch-brief-title")).not_to_have_value("")
            inputs_page.locator("#launch-save").click()
            expect(inputs_page.locator("#launch-review .launch-contract--package")).to_be_visible(timeout=20000)
            inputs_fact = inputs_page.locator('#launch-review .launch-contract--package [data-fact="inputs"] dd')
            expect(inputs_fact).to_have_text("proposal.md")
            assert "written" not in inputs_fact.inner_text()
            control("next-scan-fail", False)
            inputs_page.goto(receipt["url"] + "/#/next-steps", wait_until="domcontentloaded")
            # The refresh control renders either in the normal list toolbar or
            # in the regional StateNotice banner; wait for whichever state
            # settles instead of branching on a pre-ready count().
            refresh = inputs_page.locator(".list-refresh button, .full-page .ds-callout button").filter(has_text="Refresh files")
            expect(refresh.first).to_be_visible(timeout=20000)
            refresh.first.click()
            expect(inputs_page.locator("table.queue-table")).to_be_visible(timeout=20000)
            inputs_page.goto(inputs_url, wait_until="domcontentloaded")
            # The hash-only navigation retains the saved draft, so enter the
            # review tab explicitly; the brief's Save is correctly disabled.
            inputs_page.goto(inputs_url + "&tab=review", wait_until="domcontentloaded")
            expect(inputs_page.locator("#launch-review .launch-contract--package")).to_be_visible(timeout=20000)
            expected_direct_time = inputs_page.evaluate("iso => new Date(iso).toLocaleString()", file_mtime_iso("direct", "proposal.md"))
            expect(inputs_fact).to_contain_text("proposal.md")
            expect(inputs_fact).to_contain_text("written")
            expect(inputs_fact).to_contain_text(expected_direct_time)
            report["scenarios"].append("An unavailable scan shows filename-only Inputs; restoring it and refreshing shows the observed watched-file time")
        finally:
            inputs_context.close()
            control("next-scan-fail", False)
        check_deadline("inputs")

        # --- Click-through, origin return and the launched critique result -- #
        goto_next_steps()
        critique_tab = page.locator(".filter-strip button", has_text="Critique")
        expect(critique_tab).to_be_visible()
        critique_tab.click()
        expect(row("recommended")).to_be_visible(timeout=20000)
        select_slug("recommended")
        expect(primary_action()).to_have_text("Critique proposal")
        origin_dest, origin_query = route_parts()
        assert origin_dest == "next-steps", (origin_dest, origin_query)
        origin_ws = origin_query.get("ws")
        origin_filter = origin_query.get("filter")
        origin_id = origin_query.get("id")
        primary_action().click()
        wait_for_route(r"#/launch\?.*tab=review", "critique click-through")
        dest, query = route_parts()
        assert dest == "launch", (dest, query)
        assert query.get("tab") == "review", query
        assert query.get("package") == recommended, query
        assert query.get("skill") == "spec-architect-critics" and query.get("stop") == "critique", query
        wait_for_contract()
        expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
        expect(fact("stop")).to_have_text("critique.md")
        expect(fact("authority")).to_have_text("None")
        expect(fact("inputs")).to_contain_text("proposal.md")
        expect(fact("inputs")).to_contain_text(expected_critique_time)
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start critique")
        assert len(launch_posts()) == 0, launch_posts()
        capture_review("08-critique-review")
        assert page.locator("#launch-what-pi").is_visible()
        report["scenarios"].append("Clicking Critique proposal from the Critique-filtered list opens the resolved critic-only review with the observed Inputs time, critique.md stop, None authority and no launch dispatch")
        check_deadline("click-through")

        expect(page.locator("#launch-return-origin")).to_have_text("Return to next steps")
        page.locator("#launch-return-origin").click()
        wait_for_route(r"#/next-steps", "origin return")
        dest, query = route_parts()
        assert dest == "next-steps", (dest, query)
        assert query.get("ws") == origin_ws, (query, origin_ws)
        assert query.get("filter") == origin_filter, (query, origin_filter)
        assert query.get("id") == origin_id, (query, origin_id)
        expect(page.locator("#next-step-heading")).to_have_text("recommended")
        expect(page.locator("tr.queue-row.selected")).to_have_count(1)
        report["scenarios"].append("Return to next steps restores the workspace, critique filter and the selected recommended subject from the remembered origin route")
        check_deadline("return")

        select_slug("recommended")
        primary_action().click()
        wait_for_route(r"#/launch\?.*tab=review", "critique re-entry")
        wait_for_contract()
        expect(page.locator("#launch-assignment-launch")).to_be_enabled()
        page.locator("#launch-assignment-launch").click()
        expect(page.locator("#launch-result-package")).to_be_visible(timeout=20000)
        launches = launch_posts()
        assert len(launches) == 1, launches
        launch_entry = launches[0]["input"]
        assert launch_entry["skill"] == "spec-architect-critics", launch_entry
        launch_id = launch_entry["assignment_id"]
        expect(page.locator("#launch-result-package")).to_contain_text(launch_id)
        expect(page.locator("#launch-result-open-agent")).to_have_attribute("href", re.compile(re.escape(launch_id)))
        expect(page.locator("#launch-result-open-agent")).to_have_class(re.compile(r"ds-btn--primary"))
        expect(page.locator("#launch-result-open-epic")).not_to_have_class(re.compile(r"ds-btn--primary"))
        expect(page.locator("#launch-result-return")).to_be_visible()
        brief_save = next((entry for entry in named_posts("dispatchSaveBrief") if entry.get("input", {}).get("request_id") == launch_entry.get("request_id")), None)
        assert brief_save is not None, named_posts("dispatchSaveBrief")
        content = brief_save["input"].get("content", "")
        assert "Stop at Critique" in content and "This launch ends at the critique" in content, content[:400]
        # The composed dispatch ran through the real discussion service; only
        # the final tmux/pi boundary is fake. Verify the persisted owner facts,
        # not just the posted request.
        assert brief_save["result"] and brief_save["result"].get("brief"), brief_save
        saved_brief_path = Path(receipt["root"]) / "storage" / "projects" / "fixture" / brief_save["result"]["brief"]
        assert saved_brief_path.is_file(), saved_brief_path
        saved_brief_text = saved_brief_path.read_text()
        assert "This launch ends at the critique" in saved_brief_text, saved_brief_text[:400]
        launch_result = launches[0]
        assert launch_result.get("result"), launch_result
        assert launch_result["result"]["assignment"]["state"] == "live", launch_result["result"]["assignment"]
        preview_entry = next((entry for entry in named_posts("dispatchPreview") if entry.get("input", {}).get("request_id") == launch_entry.get("request_id")), None)
        assert preview_entry is not None and preview_entry.get("result"), named_posts("dispatchPreview")
        record_path = Path(receipt["root"]) / "storage" / "projects" / "fixture" / "assignments" / f"{launch_id}.json"
        record = json.loads(record_path.read_text())
        assert record["skill"] == "spec-architect-critics", record["skill"]
        assert record["package_ref"] == "fixture/recommended", record["package_ref"]
        assert record["spec_package"] == recommended, (record["spec_package"], recommended)
        assert record["publication_authority"] == "none", record["publication_authority"]
        assert record["contract_digest"] == launch_entry["expectedDigest"] == preview_entry["result"]["contractDigest"], record["contract_digest"]
        assert record["brief"] == brief_save["result"]["brief"], record["brief"]
        assert record["repository_id"] == "fixture-repo", record["repository_id"]
        assert record["execution_branch"] == "spec-recommended", record["execution_branch"]
        assert Path(record["execution_dir"]).is_dir(), record["execution_dir"]
        workbook = request_json(fixture, receipt["url"], "/__fixture/control")
        assert len(workbook["integration"]["sessions"]) == 1, workbook["integration"]
        report["scenarios"].append("Start critique composes save/preview/launch through the real discussion service: the persisted assignment names the exact package, skill, None authority and digest, the result names the exact assignment and Open agent is the planning result's primary action")
        capture("09-critique-result")
        check_deadline("critique-result")

        # --- Refused and unconfirmed launches keep the reviewed contract ---- #
        # Real stale refusal: the saved brief changes between review and
        # submission, so the real dispatch owner refuses on digest mismatch.
        assignments_dir = Path(receipt["root"]) / "storage" / "projects" / "fixture" / "assignments"
        records_before = sorted(assignments_dir.glob("*.json"))
        launches_before = len(launch_posts())
        submit_cold_review(critiqued, "spec-write", "prepared")
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start spec")
        stale_save = next(entry for entry in reversed(named_posts("dispatchSaveBrief")) if entry.get("input", {}).get("workspace_id") == "fixture")
        stale_brief = Path(receipt["root"]) / "storage" / "projects" / "fixture" / stale_save["result"]["brief"]
        assert stale_brief.is_file(), stale_brief
        stale_brief.write_text(stale_brief.read_text() + "\nChanged after review.\n")
        page.locator("#launch-assignment-launch").click()
        expect(page.locator("#launch-review-error")).to_contain_text("The reviewed contract changed")
        expect(page.locator("#launch-review-previous")).to_be_visible()
        expect(page.locator("#launch-result-package")).to_have_count(0)
        expect(page.locator("#launch-assignment-launch")).to_have_count(0)
        assert len(launch_posts()) == launches_before + 1, launch_posts()
        assert sorted(assignments_dir.glob("*.json")) == records_before, "a refused launch must publish no assignment record"
        report["scenarios"].append("A brief change between review and submission is refused by the real dispatch owner on digest mismatch; previous reviewed facts stay visible, no assignment is published and no second launch is offered")
        check_deadline("stale-launch")

        # Real spawn failure through the fake final tmux adapter: the service
        # still publishes and reconciles, and the unconfirmed presentation
        # keeps the recorded identity without offering a retry.
        control("integration-tmux-fail", True)
        records_before = sorted(assignments_dir.glob("*.json"))
        launches_before = len(launch_posts())
        submit_cold_review(direct, "spec-write", "prepared")
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start spec")
        page.locator("#launch-assignment-launch").click()
        expect(page.locator("#launch-heading")).to_have_text("Launch is unconfirmed")
        expect(page.locator("#launch-result-package")).to_have_count(0)
        launch_attempts = launch_posts()
        assert len(launch_attempts) == launches_before + 1, launch_attempts
        unconfirmed_id = launch_attempts[-1]["input"]["assignment_id"]
        expect(result_fact("assignment")).to_have_text(unconfirmed_id)
        expect(page.locator("#launch-result-open-agent")).to_have_attribute("href", re.compile(re.escape(unconfirmed_id)))
        expect(page.locator("#launch-result-correct")).to_have_count(0)
        expect(page.locator("#launch-assignment-launch")).to_have_count(0)
        unconfirmed_record = json.loads((assignments_dir / f"{unconfirmed_id}.json").read_text())
        assert unconfirmed_record["state"] == "launch_unknown", unconfirmed_record["state"]
        assert len(sorted(assignments_dir.glob("*.json"))) == len(records_before) + 1, sorted(assignments_dir.glob("*.json"))
        report["scenarios"].append("A refused fake pane start still publishes through the real service; the unconfirmed result keeps the exact assignment identity, records launch_unknown and offers no retry")
        check_deadline("unconfirmed-launch")
        control("integration-tmux-fail", False)
        browser.close()


def run_launch_reference_captures(browser, report: dict, evidence: Path) -> None:
    screens = design_screens()
    if screens is None:
        raise RuntimeError("reference screens unavailable at package locations; refusing to report ignored missing references")
    context = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    page = context.new_page()
    page.on("pageerror", lambda error: report["pageErrors"].append(f"reference: {error}"))
    attach_console_evidence(page, "reference", report)
    try:
        for name in LAUNCH_REFERENCE_SCREENS:
            target = screens / f"{name}.html"
            if not target.is_file():
                raise RuntimeError(f"reference screen missing: {target}")
            for width, height in WIDTH_HEIGHTS:
                page.set_viewport_size({"width": width, "height": height})
                page.goto(target.as_uri(), wait_until="domcontentloaded")
                path = evidence / f"reference-{name}-{width}.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
            page.set_viewport_size({"width": 1280, "height": 800})
            pane = page.locator(".detail-body")
            if pane.count():
                pane.first.evaluate("el => el.scrollTo(0, el.scrollHeight)")
                scrolled = evidence / f"reference-{name}-1280-scrolled.png"
                page.screenshot(path=str(scrolled), full_page=False)
                report["captures"].append(str(scrolled))
        report["scenarios"].append("Reference screens 8-10 captured at both production viewports with scrolled lower-input disclosure")
    finally:
        context.close()


def run_reference_captures(browser, report: dict, evidence: Path) -> None:
    screens = design_screens()
    if screens is None:
        raise RuntimeError("reference screens unavailable at package locations; refusing to report ignored missing references")
    context = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    page = context.new_page()
    page.on("pageerror", lambda error: report["pageErrors"].append(f"reference: {error}"))
    attach_console_evidence(page, "reference", report)
    try:
        for name in REFERENCE_SCREENS:
            target = screens / f"{name}.html"
            if not target.is_file():
                raise RuntimeError(f"reference screen missing: {target}")
            for width, height in WIDTH_HEIGHTS:
                page.set_viewport_size({"width": width, "height": height})
                page.goto(target.as_uri(), wait_until="domcontentloaded")
                path = evidence / f"reference-{name}-{width}.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
            # Scroll the actual detail pane only when the reference state is
            # populated; blank/error reference screens claim nothing.
            populated = page.evaluate("""() => {
                const pane = document.querySelector('.detail-body');
                if (!pane) return false;
                const text = (pane.textContent || '').trim();
                return text.length > 0 && !pane.querySelector('.empty, .ds-callout.error');
            }""")
            if populated:
                page.set_viewport_size({"width": 1280, "height": 800})
                page.evaluate("() => { const pane = document.querySelector('.detail-body'); if (pane) pane.scrollTo(0, pane.scrollHeight); }")
                scrolled = evidence / f"reference-{name}-1280-scrolled.png"
                page.screenshot(path=str(scrolled), full_page=False)
                report["captures"].append(str(scrolled))
        report["scenarios"].append("Reference screens 1-7/11-18 captured at viewport sizes matching production, with scrolled detail captures only for populated states")
    finally:
        context.close()


def run_landing_reference_captures(browser, report: dict, evidence: Path) -> None:
    """Capture only the 01-next-steps reference for the landing gate; skipped
    when the packaged design screens are unavailable."""
    screens = design_screens()
    if screens is None:
        report["scenarios"].append("Reference screen 01-next-steps was skipped because the packaged design screens are unavailable")
        return
    target = screens / "01-next-steps.html"
    if not target.is_file():
        raise RuntimeError(f"reference screen missing: {target}")
    context = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    page = context.new_page()
    page.on("pageerror", lambda error: report["pageErrors"].append(f"reference: {error}"))
    attach_console_evidence(page, "reference", report)
    try:
        for width, height in WIDTH_HEIGHTS:
            page.set_viewport_size({"width": width, "height": height})
            page.goto(target.as_uri(), wait_until="domcontentloaded")
            path = evidence / f"reference-01-next-steps-{width}.png"
            page.screenshot(path=str(path), full_page=False)
            report["captures"].append(str(path))
        report["scenarios"].append("Reference screen 01-next-steps captured at both production viewport sizes")
    finally:
        context.close()


parser = argparse.ArgumentParser()
parser.add_argument("--case", default="list")
arguments = parser.parse_args()
if arguments.case not in CASES:
    raise SystemExit(f"unsupported case: {arguments.case}")

evidence = Path(os.environ.get("SENTINEL_EVIDENCE_DIR", "/tmp/sentinel-next-steps-evidence"))
evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
deadline = started + CASE_DEADLINE_SECONDS
fixture = None
report = {
    "status": "failed",
    "case": arguments.case,
    "scenarios": [],
    "captures": [],
    "pageErrors": [],
    "consoleErrors": [],
    "expectedConsole": [],
    "errors": [],
    "overflow": {},
    "reviewCaptures": {},
    "observedCommit": None,
    "dirty": None,
}
watchdog_fired = threading.Event()


def watchdog() -> None:
    if watchdog_fired.wait(timeout=CASE_DEADLINE_SECONDS):
        return
    report["errors"].append(f"case exceeded the {CASE_DEADLINE_SECONDS} second process-tree deadline")
    stop_fixture(fixture)


guard = threading.Thread(target=watchdog, daemon=True)
guard.start()
try:
    report["observedCommit"], report["dirty"] = observed_revision()
    if arguments.case == "launch":
        fixture = spawn_fixture({"SENTINEL_NEXT_STEPS": "1", "SENTINEL_HANDOFF_INTEGRATION": "1", "SENTINEL_PLANNED_LAUNCH": "1"})
        receipt = fixture_receipt(fixture, report, "next-steps")
        report["fixture"] = receipt
        run_launch_case(report, fixture, receipt, evidence, deadline)
        # Reference captures run in a dedicated short-lived browser so cleanup
        # stays independent of a failing launch case.
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=shutil.which("google-chrome"),
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            try:
                run_launch_reference_captures(browser, report, evidence)
            finally:
                browser.close()
    elif arguments.case == "landing":
        fixture = spawn_fixture({"SENTINEL_NEXT_STEPS": "1"})
        receipt = fixture_receipt(fixture, report, "next-steps")
        report["fixture"] = receipt
        run_landing_case(report, fixture, receipt, evidence, deadline)
        # Reference captures run in a dedicated short-lived browser so cleanup
        # stays independent of a failing landing case.
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=shutil.which("google-chrome"),
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            try:
                run_landing_reference_captures(browser, report, evidence)
            finally:
                browser.close()
    else:
        run_default_mode_assertion(report)
        fixture = spawn_fixture({"SENTINEL_NEXT_STEPS": "1"})
        receipt = fixture_receipt(fixture, report, "next-steps")
        report["fixture"] = receipt
        run_list_case(report, fixture, receipt, evidence, deadline)
        # Reference captures use a browser owned by the same playwright run above;
        # they are produced by a dedicated short-lived run here to keep cleanup
        # independent of a failing case.
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=shutil.which("google-chrome"),
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            try:
                run_reference_captures(browser, report, evidence)
            finally:
                browser.close()
    assert not report["pageErrors"], report["pageErrors"]
    assert not report["consoleErrors"], report["consoleErrors"]
    report["status"] = "passed"
except BaseException:
    report["error"] = traceback.format_exc()
    report["errors"].append(report["error"])
finally:
    watchdog_fired.set()
    stop_fixture(fixture)
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    atomic_report(report, evidence)
    atomic_report(report, evidence, f"next-steps-{arguments.case}.json")
    write_qa(
        report,
        evidence,
        "Next steps launch evidence walkthrough (EV-7)" if arguments.case == "launch"
        else "Next steps landing evidence walkthrough (EV-8)" if arguments.case == "landing"
        else "Next steps list evidence walkthrough (EV-4)",
    )
    print(json.dumps({key: report[key] for key in ("status", "case", "elapsedSeconds", "observedCommit", "dirty", "errors")}, indent=2))

if report["status"] != "passed":
    raise SystemExit(f"--case {arguments.case} failed")
