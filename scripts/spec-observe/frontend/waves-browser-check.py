# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused browser acceptance for observed execution waves.

Run after `npm run build --prefix scripts/spec-observe/frontend` with the
uishot warm Chromium CDP endpoint on 127.0.0.1:9222:

  SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script \
    scripts/spec-observe/frontend/waves-browser-check.py

The real dashboard and browser fixture are used. Only the final /api/state
response is replaced with hand-derived envelopes; package paths come from the
fixture's real workspace. No live Sentinel state or write endpoint is used.
"""
import json
import os
import select
import signal
import subprocess
import time
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parent
EVIDENCE = Path(os.environ.get("SENTINEL_EVIDENCE_DIR", "/tmp/sentinel-wave-evidence"))
BROWSER_EVIDENCE = EVIDENCE / "browser"
BROWSER_EVIDENCE.mkdir(parents=True, exist_ok=True)
DEADLINE = time.monotonic() + 110
REPORT = {
    "status": "failed",
    "command": "uv run --script scripts/spec-observe/frontend/waves-browser-check.py",
    "scenarios": [],
    "captures": [],
    "pageErrors": [],
    "deadlineSeconds": 110,
    "proofLimits": [
        "Hand-derived observer snapshots replace only the final /api/state response; no live Sentinel or production state is read.",
        "The browser check covers rendered browser behavior and route stability, not wave-record production or scheduler authority.",
    ],
}
fixture = None
context = None
fixture_targets = []
fixture_sources = []


def check_deadline():
    if time.monotonic() >= DEADLINE:
        raise TimeoutError("Wave browser check exceeded its 110 second internal deadline")


def stop_fixture():
    if fixture is None or fixture.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(fixture.pid), signal.SIGTERM)
        fixture.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(os.getpgid(fixture.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            fixture.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass


def on_sigterm(signum, frame):
    raise TimeoutError("Wave browser check received SIGTERM")


signal.signal(signal.SIGTERM, on_sigterm)


def member(step, name, phase, run_id=None, queue_reason=None, blocking_reason=None, transitions=None, integrated=False):
    stamp = "2026-10-17T12:00:00Z"
    transitions = transitions or []
    transitions = [{"phase": item, "at": stamp} if isinstance(item, str) else item for item in transitions]
    return {
        "step": step,
        "name": name,
        "phase": phase,
        "run_id": run_id,
        "queue_reason": queue_reason,
        "blocking_reason": blocking_reason,
        "transitions": transitions or [],
        "integrated": integrated,
    }


def wave(wave_id, ordinal, state, members, requested=3, admitted=2, candidate=None, reason=None, transitions=None, observed=True):
    counts = {key: 0 for key in ("integrated", "active", "blocked", "queued", "unknown")}
    for item in members:
        phase = item["phase"]
        bucket = "integrated" if item.get("integrated") else "active" if phase in {"provisioning", "implementing", "reviewing", "fixing", "confirming"} else "blocked" if phase in {"blocked", "cancelled"} else "queued" if phase in {"queued", "waiting_dependencies"} else "unknown" if phase == "unknown" else None
        if bucket:
            counts[bucket] += 1
    stamp = "2026-10-17T12:00:00Z"
    transitions = transitions or []
    transitions = [{"phase": item, "at": stamp} if isinstance(item, str) else item for item in transitions]
    return {
        "wave_id": wave_id,
        "ordinal": ordinal,
        "state": state,
        "member_count": len(members),
        "requested_width": requested,
        "admitted_width": admitted,
        "counts": counts,
        "members": members,
        "candidate": candidate,
        "blocking_reason": reason,
        "transitions": transitions,
        "record_path": f"/fixture/runtime/waves/{wave_id}.json",
        "observed": observed,
    }


def execution(workspace, package, summary):
    return {
        "workspace": workspace,
        "package": package,
        "package_ref": f"{workspace}/{Path(package).name}",
        "targets": fixture_targets,
        "source_paths": fixture_sources,
        "execution_summary": summary,
    }


def summary(mode="waves", phase="running", waves=None, *, attention=False, state="complete", reasons=None, steps=None, counts=None):
    waves = waves or []
    counts = counts or {"integrated": 0, "active": 0, "blocked": 0, "queued": 0}
    if steps is None:
        steps = [
            {key: item.get(key) for key in ("step", "name", "phase", "integrated", "run_id")}
            | {"wave_id": row.get("wave_id")}
            for row in waves for item in row.get("members", [])
        ]
    return {
        "mode": mode,
        "phase": phase,
        "attention": attention,
        "step_count": len(steps) or sum(item["member_count"] for item in waves),
        "integrated_count": counts.get("integrated", 0),
        "active_count": counts.get("active", 0),
        "blocked_count": counts.get("blocked", 0),
        "queued_count": counts.get("queued", 0),
        "waves": waves,
        "steps": steps,
        "coverage": {"state": state, "reasons": reasons or [], "omitted": 0},
    }


try:
    dashboard = ROOT.parent / "dashboard.html"
    if not dashboard.is_file():
        raise RuntimeError(f"Built dashboard asset is missing: {dashboard}; run npm run build --prefix scripts/spec-observe/frontend")
    fixture = subprocess.Popen(
        ["node", str(ROOT / "browser-fixture.mjs")], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError("Fixture readiness exceeded 10 seconds")
    receipt_line = fixture.stdout.readline()
    if not receipt_line:
        raise RuntimeError(f"Fixture produced no receipt: {fixture.stderr.read()}")
    receipt = json.loads(receipt_line)
    REPORT["fixture"] = {"url": receipt["url"], "root": receipt.get("root")}

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
        context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(7000)
        page.on("pageerror", lambda error: REPORT["pageErrors"].append(str(error)))
        base = context.request.get(receipt["url"] + "/api/state")
        assert base.ok, f"Fixture /api/state returned {base.status}"
        real_state = base.json()
        assert isinstance(real_state, dict) and isinstance(real_state.get("observers"), list)
        original = next((item for item in real_state["observers"] if isinstance(item, dict)
                         and isinstance(item.get("snapshot"), dict)
                         and item["snapshot"].get("workspace") == "fixture"), None)
        assert original is not None, "Fixture has no observer snapshot to anchor workspace/package identity"
        real_snapshot = original["snapshot"]
        real_run = next((item for item in real_snapshot.get("runs", []) if isinstance(item, dict)
                         and isinstance(item.get("package"), str)
                         and item["package"].rstrip("/").endswith("/specs/browser")), None)
        if real_run:
            package_path = real_run["package"]
            workspace_id = str(real_run.get("workspace") or real_snapshot.get("workspace") or "fixture")
        else:
            identity = context.request.get(receipt["url"] + "/__fixture/control").json()
            package_path = identity.get("package")
            workspace_id = "fixture"
        assert isinstance(package_path, str) and Path(package_path).is_absolute(), f"Fixture package path is not absolute: {package_path!r}"
        fixture_targets = real_run.get("targets", []) if real_run else []
        fixture_sources = real_run.get("source_paths", []) if real_run else []
        second_package = receipt.get("otherPackage")
        if not isinstance(second_package, str) or not Path(second_package).is_absolute():
            second_package = str(Path(package_path).parent / "wave-browser-sibling")
        REPORT["fixture"].update({"workspace": workspace_id, "package": package_path})

        current = {"body": real_state}

        def state_handler(route):
            route.fulfill(json=current["body"])

        page.route("**/api/state**", state_handler)

        def envelope(executions, *, coverage="complete", reasons=None):
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            snap = {
                "workspace": workspace_id,
                "coverage": {"state": coverage, "observed_at": now, "reasons": reasons or []},
                "runs": [], "recently_completed": [], "assignments": [],
                "assignment_coverage": {"state": "complete", "reasons": []},
                "epics": [], "planned_packages": [], "package_executions": executions,
            }
            observer = {
                "schema_version": 1, "observer_id": "waves-browser-check",
                "state": "observing", "published_at": now, "snapshot": snap,
            }
            return {**real_state, "observers": [observer]}

        def set_state(executions, *, coverage="complete", reasons=None):
            current["body"] = envelope(executions, coverage=coverage, reasons=reasons)
            for record in executions:
                if record["package"] != package_path or record["execution_summary"].get("mode") != "waves":
                    continue
                members = [member for row in record["execution_summary"].get("waves", []) for member in row.get("members", []) if member.get("run_id")]
                current["body"]["observers"][0]["snapshot"]["runs"] = [{
                    "workspace": workspace_id,
                    "package": package_path,
                    "package_ref": record["package_ref"],
                    "run_id": member["run_id"],
                    "assignment_id": member["run_id"],
                    "execution": "running" if member["phase"] in {"provisioning", "implementing", "reviewing", "fixing", "confirming"} else member["phase"],
                    "workflow_state": member["phase"],
                    "is_current_assignment": member["phase"] in {"provisioning", "implementing", "reviewing", "fixing", "confirming"},
                    "observed_at": "2026-10-17T12:00:00Z",
                    "coverage": {"state": "complete", "reasons": []},
                } for member in members]
                break

        def open_specs(package=package_path, filter_value="active", execution_outline=True):
            check_deadline()
            key = json.dumps([workspace_id, package, "package-execution"], separators=(",", ":"))
            query = urlencode({"ws": workspace_id, "filter": filter_value, "id": key})
            page.goto(receipt["url"] + "/#/specs?" + query, wait_until="domcontentloaded")
            expect(page.locator("h1")).to_have_text("Specs")
            if execution_outline:
                expect(page.locator(".execution-outline")).to_be_visible()
            else:
                expect(page.locator(".execution-outline")).to_have_count(0)

        def doc_metrics():
            return page.evaluate("""() => ({
              width: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
              body: document.body.scrollWidth,
              bodyClient: document.body.clientWidth
            })""")

        def assert_no_overflow(label):
            values = doc_metrics()
            assert values["width"] <= values["client"] and values["body"] <= values["bodyClient"], f"{label}: horizontal document overflow {values}"

        def capture(name, width, height):
            check_deadline()
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(150)
            assert_no_overflow(name)
            path = BROWSER_EVIDENCE / name
            page.screenshot(path=str(path), full_page=True)
            REPORT["captures"].append(str(path))

        def passed(name):
            REPORT["scenarios"].append(name)

        def reset(executions, *, selected_package=package_path, filter_value="active", **kwargs):
            set_state(executions, **kwargs)
            page.goto("about:blank", wait_until="domcontentloaded")
            open_specs(selected_package, filter_value)

        mixed = wave("wave-mixed", 1, "running", [
            member(1, "Running implementation", "implementing", "run-running", transitions=["implementing"]),
            member(2, "Blocked review", "blocked", "run-blocked", blocking_reason="Waiting for reviewer", transitions=["blocked"]),
        ])
        mixed_summary = summary(waves=[mixed], attention=True, counts={"integrated": 0, "active": 1, "blocked": 1, "queued": 0})
        reset([execution(workspace_id, package_path, mixed_summary)])
        card = page.locator('.execution-wave[data-wave-id="wave-mixed"]')
        expect(card).to_be_visible()
        expect(card).to_contain_text("Running implementation")
        expect(card).to_contain_text("Blocked review")
        expect(card).to_contain_text("Waiting for reviewer")
        assert card.locator("[data-step]").count() == 2, "Mixed wave does not render both member rows"
        passed("mixed running and blocked members remain visible with their blocking reason")
        capture("waves-mixed-1280x900.png", 1280, 900)

        # Attention filtering must retain the blocked package while hiding a
        # healthy receipt-free package.
        no_receipt = summary(waves=[wave("wave-receipt-free", 1, "running", [member(3, "Receipt free candidate", "queued", queue_reason="No run receipt")])], attention=False, counts={"queued": 1})
        healthy = execution(workspace_id, second_package, no_receipt)
        reset([execution(workspace_id, package_path, mixed_summary), healthy], selected_package=package_path, filter_value="attention")
        expect(page.get_by_role("button", name="Needs attention", exact=True)).to_have_attribute("aria-pressed", "true")
        expect(page.locator('.execution-wave[data-wave-id="wave-mixed"]')).to_be_visible()
        expect(page.locator(".records .record").filter(has_text=Path(second_package).name)).to_have_count(0)
        passed("Needs attention filter retains the blocked wave and excludes the healthy receipt-free package")

        reset([healthy], selected_package=second_package)
        expect(page.locator('[data-wave-id="wave-receipt-free"]')).to_be_visible()
        expect(page.locator('[data-wave-id="wave-receipt-free"]')).to_contain_text("Receipt free candidate")
        expect(page.get_by_role("button", name="Mark complete", exact=True)).to_be_visible()
        passed("wave-only receipt-free candidate is visible from observation alone")
        capture("waves-receipt-free-1280x900.png", 1280, 900)

        integrating = wave("wave-integrating", 2, "integrating", [
            member(4, "Sealed member one", "sealed", transitions=["sealed"]),
            member(5, "Sealed member two", "sealed", transitions=["sealed"]),
        ], candidate={"phase": "integrating", "run_id": "integration-run"}, transitions=["integrating"])
        integration_summary = summary(waves=[integrating], phase="integrating", counts={})
        reset([execution(workspace_id, package_path, integration_summary)])
        integration_card = page.locator('.execution-wave[data-wave-id="wave-integrating"]')
        expect(integration_card).to_be_visible()
        expect(integration_card).to_contain_text("integrating")
        expect(integration_card).to_contain_text("Sealed member one")
        expect(integration_card).not_to_contain_text("Done")
        passed("all sealed members still render the wave as Integrating until integration completes")

        # Candidate checks have no member step. They must appear under the wave's
        # integration activity even when no candidate run id is stored in its journal.
        integrating["candidate"] = None
        set_state([execution(workspace_id, package_path, integration_summary)])
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        current["body"]["observers"][0]["snapshot"]["runs"] = [{
            "workspace": workspace_id, "package": package_path,
            "package_ref": f"{workspace_id}/{Path(package_path).name}",
            "assignment_id": "candidate-check", "execution": "running",
            "is_current_assignment": True, "observed_at": now,
            "coverage": {"state": "complete", "reasons": []},
            "timing": {"attempts": [{"run_id": "candidate-check", "assignment_id": "candidate-check",
                "wave_id": "wave-integrating", "subject_kind": "candidate", "step": None,
                "phase": "command", "state": "running", "started_at": now}]},
        }]
        page.goto("about:blank", wait_until="domcontentloaded")
        open_specs()
        page.get_by_role("button", name="Activity", exact=True).click()
        expect(page.locator('.wave-integration .execution-attempt')).to_have_count(1)
        expect(page.locator('.wave-integration .execution-attempt')).to_contain_text("command")
        expect(page.locator('.execution-outline')).not_to_contain_text("Step unknown")
        passed("candidate checks render once under integration activity without a member step or persisted candidate run id")

        future = wave("wave-future", 3, "waiting_dependencies", [member(6, "Future dependency step", "waiting_dependencies", queue_reason="Waiting for earlier wave")], observed=False)
        future_summary = summary(waves=[future], phase="waiting_dependencies", counts={"queued": 1})
        reset([execution(workspace_id, package_path, future_summary)])
        future_card = page.locator('.execution-wave[data-wave-id="wave-future"]')
        expect(future_card).to_be_visible()
        expect(future_card.locator("summary")).to_contain_text("waiting dependencies · Planned")
        expect(future_card.locator('[data-step="6"]')).to_be_hidden()
        future_card.locator("summary").click()
        expect(future_card).to_contain_text("Waiting for earlier wave")
        expect(future_card).to_contain_text("Future dependency step")
        passed("future wave remains visible while waiting on dependencies")

        # Keep the same wave identity through the periodic snapshot refresh and
        # verify that the route does not drop the selected package/wave.
        reset([execution(workspace_id, package_path, mixed_summary)])
        mixed_card = page.locator('.execution-wave[data-wave-id="wave-mixed"]')
        mixed_card.locator("summary").click()
        expect(mixed_card).not_to_have_attribute("open", "")
        initial_hash = page.evaluate("location.hash")
        changed = wave("wave-mixed", 1, "running", [
            member(1, "Running implementation updated", "implementing", "run-running", transitions=["implementing", "reviewing"]),
            member(2, "Blocked review", "blocked", "run-blocked", blocking_reason="Waiting for reviewer", transitions=["blocked"]),
        ])
        updated = summary(waves=[changed], attention=True, counts={"active": 1, "blocked": 1})
        current["body"] = envelope([execution(workspace_id, package_path, updated)])
        deadline = min(DEADLINE, time.monotonic() + 8)
        while time.monotonic() < deadline:
            check_deadline()
            if "Running implementation updated" in (page.locator('.execution-wave[data-wave-id="wave-mixed"]').text_content() or ""):
                break
            page.wait_for_timeout(200)
        assert page.evaluate("location.hash") == initial_hash, f"Route changed during wave update: {initial_hash} -> {page.evaluate('location.hash')}"
        updated_card = page.locator('.execution-wave[data-wave-id="wave-mixed"]')
        expect(updated_card).to_have_count(1)
        expect(updated_card).not_to_have_attribute("open", "")
        updated_card.locator("summary").click()
        expect(updated_card).to_contain_text("Running implementation updated")
        passed("same-wave collapse state survives the state poll, the updated member appears after reopening, and the package route remains stable")

        # Updating a stable keyed wave must also update the integration row.
        changed["state"] = "verifying"
        changed["candidate"] = None
        for item in changed["members"]:
            item["phase"] = "sealed"
            item["blocking_reason"] = None
        changed["counts"] = {"integrated": 0, "active": 0, "blocked": 0, "queued": 0, "unknown": 0}
        changed["sealed_count"] = 2
        updated["attention"] = False
        updated["active_count"] = 0
        updated["blocked_count"] = 0
        current["body"] = envelope([execution(workspace_id, package_path, updated)])
        expect(page.locator('[data-wave-id="wave-mixed"] .wave-integration')).to_have_attribute("data-integration-phase", "verifying", timeout=8000)
        expect(page.locator('[data-wave-id="wave-mixed"] .wave-integration')).to_contain_text("verifying")
        passed("same-wave polling advances integration state without a candidate record")
        capture("waves-verifying-1280x900.png", 1280, 900)
        capture("waves-verifying-390x844.png", 390, 844)
        page.set_viewport_size({"width": 1280, "height": 900})

        flat_steps = [
            member(7, "Serial legacy step one", "unknown", transitions=["sealed"]),
            member(8, "Serial legacy step two", "implementing", "serial-run", transitions=["implementing"]),
        ]
        flat = summary(mode="serial", phase="running", steps=flat_steps, state="partial", reasons=["serial-step-status-unavailable"], counts={"integrated": None, "active": 1})
        reset([execution(workspace_id, package_path, flat)])
        expect(page.locator('.execution-step[data-step="7"]')).to_contain_text("Serial legacy step one")
        expect(page.locator('.execution-step[data-step="8"]')).to_contain_text("Serial legacy step two")
        passed("flat serial/legacy execution remains readable when no wave rows exist")
        capture("waves-flat-1280x900.png", 1280, 900)

        set_state([])
        legacy_run = {
            "workspace": workspace_id,
            "package": package_path,
            "package_ref": f"{workspace_id}/{Path(package_path).name}",
            "assignment_id": "legacy-assignment",
            "execution": "running",
            "workflow_state": "waiting-worker",
            "is_current_assignment": True,
            "activity": "Legacy execution activity",
            "observed_at": "2026-10-17T12:00:00Z",
            "coverage": {"state": "complete", "reasons": []},
        }
        current["body"]["observers"][0]["snapshot"]["runs"] = [legacy_run]
        open_specs(package_path, execution_outline=False)
        expect(page.get_by_text("Legacy execution activity", exact=True)).to_be_visible()
        passed("legacy run-only snapshots retain the existing package detail without a wave outline")

        partial = summary(waves=[wave("wave-unknown", 4, "unknown", [member(9, "Partially observed member", "unknown", blocking_reason="Record missing")])], phase="unknown", state="partial", reasons=["wave record unavailable"], counts={"queued": 1})
        reset([execution(workspace_id, package_path, partial)], coverage="partial", reasons=["wave record unavailable"])
        unknown_card = page.locator('.execution-wave[data-wave-id="wave-unknown"]')
        expect(unknown_card).to_be_visible()
        expect(unknown_card).to_contain_text("Partially observed member")
        expect(page.locator('.execution-outline').get_by_text("wave record unavailable", exact=True)).to_be_visible()
        passed("partial or unknown wave remains visible with its uncertainty explanation")
        capture("waves-unknown-1280x900.png", 1280, 900)
        capture("waves-unknown-390x844.png", 390, 844)

        page.set_viewport_size({"width": 1280, "height": 900})
        unknown_summary = unknown_card.locator("summary")
        unknown_summary.focus()
        unknown_summary.press("Enter")
        expect(unknown_card).not_to_have_attribute("open", "")
        unknown_summary.press("Enter")
        expect(unknown_card).to_have_attribute("open", "")
        stats = page.locator('.detail-body .facts')
        stats.scroll_into_view_if_needed()
        stats_box = stats.bounding_box()
        action_box = page.locator('.detail-actions').bounding_box()
        assert stats_box and action_box and stats_box["y"] + stats_box["height"] <= action_box["y"] + 1, "Observation facts cannot scroll clear of the fixed action bar"
        last_fact = page.locator('.detail-body table tbody tr').last
        last_fact.scroll_into_view_if_needed()
        fact_box = last_fact.bounding_box()
        assert fact_box and action_box and fact_box["y"] + fact_box["height"] <= action_box["y"] + 1, "Last related-work row cannot scroll clear of the action bar"
        passed("wave disclosure supports keyboard toggling and lower facts scroll clear of the action bar")
        capture("waves-unknown-scrolled-1280x900.png", 1280, 900)

        # Imported snapshots stay on the local interpretation path and cannot
        # trigger live API traffic or package lifecycle writes.
        api_requests = []
        page.on("request", lambda request: api_requests.append({"method": request.method, "url": request.url}) if "/api/" in request.url else None)
        imported_body = envelope([execution(workspace_id, package_path, partial)], coverage="partial", reasons=["wave record unavailable"])
        page.locator("#import-file").set_input_files({
            "name": "waves-observation.json",
            "mimeType": "application/json",
            "buffer": json.dumps(imported_body).encode("utf-8"),
        })
        expect(page.get_by_text("Imported snapshot", exact=True)).to_be_visible()
        expect(page.locator(".execution-outline")).to_be_visible()
        expect(page.locator('.execution-wave[data-wave-id="wave-unknown"]')).to_be_visible()
        page.wait_for_timeout(350)
        live_mutations = [request for request in api_requests if request["method"] != "GET"]
        assert live_mutations == [], f"Imported snapshot attempted API writes: {live_mutations}"
        passed("imported partial wave snapshot remains readable and makes no API writes")

        assert REPORT["pageErrors"] == [], REPORT["pageErrors"]
        REPORT["status"] = "passed"
        print(json.dumps({"status": "passed", "scenarios": REPORT["scenarios"], "captures": REPORT["captures"]}))
except BaseException as error:
    REPORT["error"] = repr(error)
    raise
finally:
    if context is not None:
        try:
            context.close()
        except Exception:
            pass
    stop_fixture()
    target = EVIDENCE / "waves-browser-check.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(REPORT, indent=2) + "\n")
    os.replace(temporary, target)
