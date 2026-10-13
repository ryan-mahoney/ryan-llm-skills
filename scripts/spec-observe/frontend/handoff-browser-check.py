# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Bound plan/implement review browser case.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=/tmp/sentinel-handoff-evidence uv run --script \
  scripts/spec-observe/frontend/handoff-browser-check.py --case review

The fixture runs with SENTINEL_PLANNED_LAUNCH=1 so the real package resolver,
saved brief, skill lookup and contract digest drive the bound review while the
final worker process boundary stays fake. Reference captures load the design
screens over file:// and production captures drive the real route and actions;
no model, push or merge is exercised.
"""
import argparse
import json
import os
import select
import shutil
import subprocess
import time
import traceback
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright

BUSY_ASSIGNMENT = "b42f1903-9508-46c1-a4aa-a0842dbce617"
HOLDING_RUN = "7c2a91d4-3e58-4b06-a1f7-95d0e6b83c12"

parser = argparse.ArgumentParser()
parser.add_argument("--case", default="review")
arguments = parser.parse_args()
if arguments.case != "review":
    raise SystemExit(f"unsupported case: {arguments.case}")

root = Path(__file__).resolve().parent
evidence = Path(os.environ.get("SENTINEL_EVIDENCE_DIR", "/tmp/sentinel-handoff-evidence")) / "04-states"
evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
report = {"status": "failed", "case": arguments.case, "scenarios": [], "pageErrors": [], "captures": []}


def design_screens() -> Path | None:
    candidates = [
        Path(os.environ["SENTINEL_DESIGN_SCREENS"]) if os.environ.get("SENTINEL_DESIGN_SCREENS") else None,
        Path("/Users/ryanmahoney/Documents/adjacent-storage/projects/agent-tooling/designs/app-ui-plan-screens/screens"),
        Path("/home/ryanmahoney/Documents/adjacent-storage/projects/agent-tooling/designs/app-ui-plan-screens/screens"),
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_dir():
            return candidate
    return None


fixture_env = dict(os.environ)
fixture_env["SENTINEL_PLANNED_LAUNCH"] = "1"
fixture = subprocess.Popen(
    ["node", str(root / "browser-fixture.mjs")],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    env=fixture_env,
)
try:
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError("handoff fixture did not become ready within 10 seconds")
    receipt_line = fixture.stdout.readline()
    if not receipt_line:
        raise RuntimeError(f"handoff fixture exited before readiness: {fixture.stderr.read()}")
    receipt = json.loads(receipt_line)
    report["fixture"] = receipt
    report["observedCommit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    report["dirty"] = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip())

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=shutil.which("google-chrome"), headless=True, args=["--no-sandbox"])

        screens = design_screens()
        if screens:
            reference = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
            reference_page = reference.new_page()
            for name in ("04-plan-review", "05-plan-review-denied", "11-implement-review", "12-implement-review-denied"):
                for width in (1280, 1600):
                    reference_page.set_viewport_size({"width": width, "height": 900})
                    reference_page.goto((screens / f"{name}.html").as_uri(), wait_until="domcontentloaded")
                    screenshot = evidence / f"reference-{name}-{width}.png"
                    reference_page.screenshot(path=str(screenshot), full_page=True)
                    report["captures"].append(str(screenshot))
            reference.close()
        else:
            report["scenarios"].append("Reference screens unavailable; production captures only")

        context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        post_urls = []
        page.on("request", lambda request: post_urls.append(request.url) if request.method == "POST" else None)

        def control(action=None, value=None):
            if action is None:
                query = ""
            else:
                text = str(value).lower() if isinstance(value, bool) else str(value)
                query = "?" + urlencode({"action": action, "value": text})
            response = context.request.get(receipt["url"] + "/__fixture/control" + query)
            assert response.ok
            return response.json()

        def posts(name):
            return [post for post in control()["posts"] if post["name"] == name]

        def worker_starts():
            # Published assignments are the only observable process starts; the
            # final worker process itself is fake for every scenario.
            return list(control()["launch"]["published"])

        def fact(key):
            return page.locator(f"#launch-review .launch-contract--package [data-fact={key}] dd")

        def capture(name):
            for width in (1280, 1600):
                page.set_viewport_size({"width": width, "height": 900})
                path = evidence / f"production-{name}-{width}.png"
                page.screenshot(path=str(path), full_page=True)
                report["captures"].append(str(path))
            page.set_viewport_size({"width": 1280, "height": 900})

        def launch_route(package, skill):
            return receipt["url"] + "/#/launch?" + urlencode({
                "ws": "fixture", "tab": "brief", "package": package, "skill": skill, "target": "fixture-repo",
            })

        def open_review(package, skill, title, brief):
            page.goto(launch_route(package, skill), wait_until="domcontentloaded")
            expect(page.locator("#launch-heading")).to_have_text("Prepare assignment")
            page.locator("#launch-brief-title").fill(title)
            page.locator("#launch-brief-content").fill(brief)
            page.locator("#launch-save").click()
            expect(page.locator("#launch-review .launch-contract")).to_be_visible()

        def refresh_state():
            # The hidden launch destination has no header refresh control: refresh
            # from Agents and return to the exact launch URL so the review section
            # remounts against the refreshed snapshot records.
            saved_url = page.url
            page.goto(receipt["url"] + "/#/agents?ws=fixture", wait_until="domcontentloaded")
            with page.expect_response(lambda response: "/api/state" in response.url) as response:
                page.get_by_role("button", name="Refresh state", exact=True).click()
            assert response.value.status == 200
            page.goto(saved_url, wait_until="domcontentloaded")
            expect(page.locator("#launch-review")).to_be_visible()

        # Bound implementation review through the real route, brief save and
        # automatic resolution. Reviewing must not start a worker.
        open_review("fixture/browser", "spec-end-to-end", "Implement fixture/browser through draft PR", "/spec-end-to-end Resume prepared implementation for fixture/browser.")
        expect(page.locator("#launch-heading")).to_have_text("Review implementation assignment")
        expect(page.locator("#launch-review-heading")).to_have_text("Review implementation assignment")
        expect(fact("package")).to_have_text("fixture/browser")
        expect(fact("target")).to_have_text("fixture-repo")
        expect(fact("execution")).to_contain_text("checkout-browser")
        expect(fact("workflow")).to_have_text("spec-end-to-end")
        expect(fact("stop")).to_have_text("Draft pull request")
        expect(fact("authority")).to_have_text("Draft pull request only")
        expect(fact("model")).to_have_text("Host default")
        expect(page.locator("#launch-review .launch-contract--package")).to_contain_text("Merge stays with the operator")
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start implementation")
        expect(page.locator("#launch-assignment-edit")).to_have_text("Edit brief")
        # Sole commitment: one primary Start control, no save control, and no
        # dispatch or published worker on review.
        assert page.locator("#launch-review button.ds-btn--primary").count() == 1
        expect(page.locator("#launch-assignment-save")).to_have_count(0)
        assert posts("dispatchLaunch") == []
        assert worker_starts() == []
        report["scenarios"].append("Bound implementation review renders the resolved package contract with one Start implementation control and starts no worker")
        capture("implement-review")

        # Bound planning review: truthful planning-only stop, worktree
        # disclosure and no publication authority.
        open_review("fixture/browser", "spec-architect-initial", "Plan fixture/browser through preparation", "/spec-architect-initial Plan fixture/browser.")
        expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
        expect(page.locator("#launch-review-heading")).to_have_text("Review planning assignment")
        expect(fact("stages")).to_contain_text("spec-architect-initial")
        expect(fact("stages")).to_contain_text("spec-write")
        expect(fact("stop")).to_have_text("Prepared")
        expect(fact("authority")).to_have_text("None")
        expect(fact("execution")).to_contain_text("checkout-browser")
        expect(page.locator("#launch-review .launch-contract--package")).to_contain_text("Planning stops before implementation")
        expect(page.locator("#launch-assignment-launch")).to_have_text("Start planning")
        assert posts("dispatchLaunch") == []
        assert worker_starts() == []
        report["scenarios"].append("Bound planning review discloses the package worktree, canonical stages, prepared stop and None authority without starting a worker")
        capture("plan-review")

        # Target-busy conflict routes to the writer in Agents and leaves the
        # commitment and the process-start count unchanged.
        starts_before_conflicts = len(posts("dispatchLaunch"))
        control("review-preview-refusal", "target-busy")
        page.locator("#launch-assignment-review").click()
        expect(page.locator("#launch-package-open-agent")).to_be_visible()
        agent_href = page.locator("#launch-package-open-agent").get_attribute("href")
        assert agent_href and agent_href.startswith("#/agents?ws=fixture"), agent_href
        assert BUSY_ASSIGNMENT in agent_href, agent_href
        expect(page.locator("#launch-review-busy")).to_have_text(BUSY_ASSIGNMENT)
        expect(page.locator("#launch-assignment-launch")).to_have_count(0)
        assert len(posts("dispatchLaunch")) == starts_before_conflicts
        assert worker_starts() == []
        report["scenarios"].append("Target-busy removes the commitment, links the conflicting agent and keeps the process-start count unchanged")
        capture("target-busy-denied")

        # Run-active conflict routes to the exact holding spec run.
        control("review-preview-refusal", "run-active")
        control("review-holding-run", HOLDING_RUN)
        time.sleep(1.3)
        refresh_state()
        page.locator("#launch-assignment-review").click()
        expect(page.locator("#launch-package-open-spec")).to_be_visible()
        spec_href = page.locator("#launch-package-open-spec").get_attribute("href")
        assert spec_href and spec_href.startswith("#/specs?ws=fixture"), spec_href
        expect(page.locator("#launch-package-denied")).to_contain_text(HOLDING_RUN)
        expect(page.locator("#launch-assignment-launch")).to_have_count(0)
        assert len(posts("dispatchLaunch")) == starts_before_conflicts
        assert worker_starts() == []
        report["scenarios"].append("Run-active removes the commitment, names the holding run and routes to its spec without starting a process")
        capture("run-active-denied")

        # Stale digest: a refused launch never offers another commitment.
        control("review-preview-refusal", "none")
        control("review-holding-run", "")
        page.locator("#launch-assignment-review").click()
        expect(fact("digest")).to_be_visible()
        control("stale-launch", "true")
        page.locator("#launch-assignment-launch").click()
        expect(page.locator("#launch-review-error")).to_contain_text("reviewed contract changed")
        expect(page.locator("#launch-assignment-launch")).to_have_count(0)
        assert worker_starts() == []
        report["scenarios"].append("A stale digest removes the launch control and starts no worker")
        control("stale-launch", "false")
        capture("stale-digest")

        # Unconfirmed outcome: the result surface never offers another launch.
        control("dispatch-launch-outcome", "unknown")
        page.locator("#launch-assignment-review").click()
        expect(fact("digest")).to_be_visible()
        page.locator("#launch-assignment-launch").click()
        expect(page.locator("#launch-result-facts")).to_be_visible()
        expect(page.locator("#launch-result-facts")).to_contain_text("not observed")
        expect(page.locator("#launch-assignment-launch")).to_have_count(0)
        assert worker_starts() == []
        report["scenarios"].append("An unconfirmed result never offers a second launch")
        capture("unknown-result")
        control("dispatch-launch-outcome", "live")

        # Preview error in a fresh bound context: no contract, no launch.
        control("review-preview-refusal", "error")
        page.goto(launch_route("fixture/other-browser", "spec-write"), wait_until="domcontentloaded")
        expect(page.locator("#launch-heading")).to_have_text("Prepare assignment")
        page.locator("#launch-brief-title").fill("Plan fixture/other-browser")
        page.locator("#launch-brief-content").fill("/spec-write Plan fixture/other-browser.")
        page.locator("#launch-save").click()
        expect(page.locator("#launch-review-error")).to_contain_text("Contract could not be resolved")
        expect(page.locator("#launch-assignment-launch")).to_have_count(0)
        expect(page.locator("#launch-review .launch-contract--package")).to_have_count(0)
        assert worker_starts() == []
        report["scenarios"].append("A resolution error never claims a contract or offers a launch")
        capture("error")

        # Unbound generic package skill keeps the ordinary AssignmentContract.
        control("review-preview-refusal", "none")
        open_review("fixture/browser", "fixture-skill", "Generic package review", "/fixture-skill Review the fixture package.")
        expect(page.locator("#launch-review .launch-contract")).to_be_visible()
        expect(page.locator("#launch-review .launch-contract--package")).to_have_count(0)
        expect(page.locator("#launch-review [data-fact=package]")).to_have_count(0)
        expect(page.locator("#launch-review-heading")).to_have_text("Assignment review")
        expect(page.locator("#launch-assignment-launch")).to_have_text("Launch agent")
        expect(page.locator("#launch-assignment-edit")).to_have_text("Edit assignment")
        assert worker_starts() == []
        report["scenarios"].append("An unbound generic package skill keeps the ordinary AssignmentContract")
        capture("generic-unbound")

        assert not report["pageErrors"], report["pageErrors"]
        assert all(url.startswith(receipt["url"] + "/") for url in post_urls), post_urls
        report["postUrls"] = post_urls
        context.close()
        browser.close()
        report["status"] = "passed"
except BaseException:
    report["error"] = traceback.format_exc()
    raise
finally:
    fixture.terminate()
    try:
        fixture.wait(timeout=10)
    except subprocess.TimeoutExpired:
        fixture.kill()
        fixture.wait()
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    (evidence / "handoff-browser-review.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
