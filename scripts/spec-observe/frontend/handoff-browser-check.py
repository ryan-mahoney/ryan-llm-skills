# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Bound plan/implement review and result browser cases.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=/tmp/sentinel-handoff-evidence uv run --script \
  scripts/spec-observe/frontend/handoff-browser-check.py --case review
SENTINEL_EVIDENCE_DIR=/tmp/sentinel-handoff-evidence uv run --script \
  scripts/spec-observe/frontend/handoff-browser-check.py --case result

SENTINEL_EVIDENCE_DIR=/tmp/sentinel-handoff-evidence uv run --script \
  scripts/spec-observe/frontend/handoff-browser-check.py --case specs

SENTINEL_EVIDENCE_DIR=/tmp/sentinel-handoff-evidence uv run --script \
  scripts/spec-observe/frontend/handoff-browser-check.py --case epic

The fixture runs with SENTINEL_PLANNED_LAUNCH=1 so the real package resolver,
saved brief, skill lookup and contract digest drive the bound review and result
while the final worker process boundary stays fake. Reference captures load the
design screens over file:// and production captures drive the real route and
actions; no model, push or merge is exercised.
"""
import argparse
import json
import os
import re
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
if arguments.case not in ("review", "result", "specs", "epic"):
    raise SystemExit(f"unsupported case: {arguments.case}")

root = Path(__file__).resolve().parent
evidence = Path(os.environ.get("SENTINEL_EVIDENCE_DIR", "/tmp/sentinel-handoff-evidence")) / ("07-states" if arguments.case == "specs" else "06-states" if arguments.case == "result" else "01-states" if arguments.case == "epic" else "04-states")
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
if arguments.case == "specs":
    fixture_env["SENTINEL_SPECS_READINESS"] = "1"
if arguments.case == "epic":
    fixture_env["SENTINEL_EPIC_PLANNING"] = "1"
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
            reference_screens = ("06-plan-result", "13-implement-result") if arguments.case == "result" else ("07-specs-ready", "08-spec-ready-waiting", "09-spec-ready-unverified", "10-specs-ready-empty") if arguments.case == "specs" else ("01-epic-planning-incomplete", "02-epic-planning-active") if arguments.case == "epic" else ("04-plan-review", "05-plan-review-denied", "11-implement-review", "12-implement-review-denied")
            for name in reference_screens:
                for width in (1280, 1600):
                    reference_page.set_viewport_size({"width": width, "height": 900})
                    reference_page.goto((screens / f"{name}.html").as_uri(), wait_until="domcontentloaded")
                    screenshot = evidence / f"reference-{name}-{width}.png"
                    reference_page.screenshot(path=str(screenshot), full_page=True)
                    report["captures"].append(str(screenshot))
                    if arguments.case in ("result", "specs", "epic"):
                        # Scrolled lower-pane evidence: full-page captures clip
                        # the lower inner content, so scroll to the populated
                        # lower content and capture the viewport as well.
                        reference_page.evaluate("""() => {
                            const pane = document.querySelector('.detail-body');
                            if (pane) pane.scrollTo(0, pane.scrollHeight);
                            window.scrollTo(0, document.body.scrollHeight);
                        }""")
                        reference_page.wait_for_timeout(300)
                        scrolled = evidence / f"reference-{name}-{width}-scrolled.png"
                        reference_page.screenshot(path=str(scrolled), full_page=False)
                        report["captures"].append(str(scrolled))
            reference.close()
        else:
            report["scenarios"].append("Reference screens unavailable; production captures only")

        context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        post_urls = []
        page.on("request", lambda request: post_urls.append(request.url) if request.method == "POST" else None)

        def control(action=None, value=None, **extra):
            params = {}
            if action is not None:
                params["action"] = action
                params["value"] = str(value).lower() if isinstance(value, bool) else str(value)
            params.update(extra)
            query = "?" + urlencode(params) if params else ""
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

        def result_fact(key):
            return page.locator(f"#launch-result-facts [data-fact={key}] dd")

        def capture(name):
            for width in (1280, 1600):
                page.set_viewport_size({"width": width, "height": 900})
                # Normal state captures start from the pane top: the live detail
                # keeps the previous scroll when the selected record changes.
                page.evaluate("() => { const pane = document.querySelector('.detail-pane .detail-body'); if (pane) pane.scrollTo(0, 0); }")
                path = evidence / f"production-{name}-{width}.png"
                page.screenshot(path=str(path), full_page=True)
                report["captures"].append(str(path))
            page.set_viewport_size({"width": 1280, "height": 900})

        def capture_scrolled(name):
            # Scrolled lower-pane evidence: full-page captures clip inner
            # overflow panes, so scroll the actual pane (launch flow or spec
            # detail) to its lower content and capture the viewport at both
            # widths.
            for width in (1280, 1600):
                page.set_viewport_size({"width": width, "height": 900})
                page.evaluate("""() => {
                    const target = document.querySelector('#launch-review') || document.querySelector('.flow');
                    if (target) target.scrollIntoView({block: 'end'});
                    const pane = document.querySelector('.full-page') || document.querySelector('.detail-pane .detail-body');
                    if (pane) pane.scrollTo(0, pane.scrollHeight);
                    window.scrollTo(0, document.body.scrollHeight);
                }""")
                page.wait_for_timeout(300)
                path = evidence / f"production-{name}-scrolled-{width}.png"
                page.screenshot(path=str(path), full_page=False)
                report["captures"].append(str(path))
            page.set_viewport_size({"width": 1280, "height": 900})

        def launch_route(package, skill):
            return receipt["url"] + "/#/launch?" + urlencode({
                "ws": "fixture", "tab": "brief", "package": package, "skill": skill, "target": "fixture-repo",
            })

        def result_route(package, skill, assignment):
            return receipt["url"] + "/#/launch?" + urlencode({
                "ws": "fixture", "tab": "result", "id": assignment, "package": package, "skill": skill, "target": "fixture-repo",
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

        def run_review():
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
            expect(fact("prerequisite")).to_contain_text("base")
            expect(fact("prerequisite")).to_contain_text("Ready to implement")
            expect(fact("preparation")).to_contain_text("Prepared")
            expect(fact("preparation")).to_contain_text("3 steps")
            expect(fact("preparation")).to_contain_text("prepared")
            expect(page.locator("#launch-review .launch-contract--package")).to_contain_text("Merge stays with the operator")
            expect(page.locator("#launch-what-pi")).to_be_visible()
            expect(page.locator("#launch-what-pi")).to_contain_text("What Pi will receive")
            expect(page.locator("#launch-what-pi")).to_contain_text("Complete brief and context")
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
            expect(fact("stages")).to_contain_text("stops at Proposal if critique is recommended")
            expect(fact("stop")).to_contain_text("Prepared, or Proposal if critique is recommended")
            expect(fact("authority")).to_have_text("None")
            expect(fact("execution")).to_contain_text("checkout-browser")
            expect(fact("prerequisite")).to_contain_text("base")
            expect(fact("prerequisite")).to_contain_text("Ready to implement")
            expect(fact("preparation")).to_contain_text("Prepared")
            expect(fact("preparation")).to_contain_text("3 steps")
            expect(page.locator("#launch-review .launch-contract--package")).to_contain_text("or at Proposal when architecture recommends critique")
            expect(page.locator("#launch-what-pi")).to_be_visible()
            expect(page.locator("#launch-what-pi")).to_contain_text("What Pi will receive")
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
            capture_scrolled("target-busy-denied")

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
            capture_scrolled("run-active-denied")

            # Implementation-denied (reference 12): a run-active refusal on the
            # implement hand-off keeps the holding run identity and routes to
            # its spec without starting a process. The implement draft from
            # the first scenario is reused; navigate to its review surface
            # instead of seeding a second brief.
            page.goto(receipt["url"] + "/#/launch?" + urlencode({
                "ws": "fixture", "tab": "review", "package": "fixture/browser", "skill": "spec-end-to-end", "target": "fixture-repo",
            }), wait_until="domcontentloaded")
            expect(page.locator("#launch-heading")).to_have_text("Review implementation assignment")
            control("review-preview-refusal", "run-active")
            control("review-holding-run", HOLDING_RUN)
            time.sleep(1.3)
            refresh_state()
            page.locator("#launch-assignment-review").click()
            expect(page.locator("#launch-package-open-spec")).to_be_visible()
            implement_spec_href = page.locator("#launch-package-open-spec").get_attribute("href")
            assert implement_spec_href and implement_spec_href.startswith("#/specs?ws=fixture"), implement_spec_href
            expect(page.locator("#launch-package-denied")).to_contain_text(HOLDING_RUN)
            expect(page.locator("#launch-package-denied")).to_have_attribute("data-denied-reason", "run-active")
            expect(page.locator("#launch-assignment-launch")).to_have_count(0)
            assert len(posts("dispatchLaunch")) == starts_before_conflicts
            assert worker_starts() == []
            report["scenarios"].append("Implementation run-active removes the commitment, names the holding run and routes to its spec without starting a process")
            capture("implement-denied")
            capture_scrolled("implement-denied")

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
            capture_scrolled("stale-digest")

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
            expect(page.locator("#launch-what-pi")).to_be_visible()
            expect(page.locator("#launch-what-pi")).to_contain_text("What Pi will receive")
            assert worker_starts() == []
            report["scenarios"].append("An unbound generic package skill keeps the ordinary AssignmentContract")
            capture("generic-unbound")
            capture_scrolled("generic-unbound")

        def run_result():
            # Confirmed planning launch: same-epic return, Planning outcomes and
            # the next independent member offered from the epic inventory.
            control("dispatch-launch-outcome", "live")
            open_review("fixture/browser", "spec-architect-initial", "Plan fixture/browser through preparation", "/spec-architect-initial Plan fixture/browser.")
            expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
            page.locator("#launch-assignment-launch").click()
            expect(page.locator("#launch-result-package")).to_be_visible()
            expect(page.locator("#launch-heading")).to_have_text("Planning is live")
            expect(page.locator("#launch-result-package")).to_have_attribute("data-package-kind", "plan")
            planning_input = posts("dispatchLaunch")[-1]["input"]
            planning_assignment = planning_input["assignment_id"]
            assert re.fullmatch(r"[0-9a-f]{64}", planning_input["expectedDigest"])
            launches = [entry for entry in control()["diagnostics"]["resolvers"] if entry["name"] == "dispatchLaunch"]
            assert launches and launches[-1]["matched"] is True, launches[-1:]
            expect(result_fact("assignment")).to_have_text(planning_assignment)
            expect(result_fact("package")).to_have_text("fixture/browser")
            expect(result_fact("worktree")).to_contain_text("checkout-browser")
            expect(result_fact("stages")).to_contain_text("spec-architect-initial")
            expect(result_fact("stages")).to_contain_text("spec-write")
            expect(result_fact("stop")).to_contain_text("Prepared")
            expect(result_fact("stop")).to_contain_text("Planning only")
            expect(result_fact("stop")).not_to_contain_text("No branch")
            expect(result_fact("started")).not_to_have_text("Not recorded")
            expect(result_fact("host")).to_have_text("Host not recorded for this assignment")
            epic_href = page.locator("#launch-result-open-epic").get_attribute("href")
            assert epic_href and epic_href.startswith("#/epics?ws=fixture") and "id=" in epic_href, epic_href
            agent_href = page.locator("#launch-result-open-agent").get_attribute("href")
            assert agent_href and planning_assignment in agent_href, agent_href
            expect(page.locator("#launch-result-package [data-fact=next-member] dd")).to_contain_text("other-browser")
            expect(page.locator("#launch-result-package")).to_contain_text("Planning")
            expect(page.locator("#launch-result-package")).to_contain_text("Ready to implement")
            expect(page.locator("#launch-result-package")).to_contain_text("Decision needed")
            report["scenarios"].append("Confirmed planning launch returns to the same epic with Planning, Open agent and the next independent member offered")
            capture("plan-result")
            capture_scrolled("plan-result")
            # Open epic returns to the same epic that carries the member.
            page.locator("#launch-result-open-epic").click()
            expect(page).to_have_url(re.compile(r"#/epics\?ws=fixture&id="))
            expect(page.locator(".object-head h2")).to_have_text("Demo epic")
            page.go_back()
            expect(page.locator("#launch-result-package")).to_be_visible()

            # Confirmed implementation launch: draft-PR stop, same-package
            # return, and the package leaves Ready for Active before a run
            # receipt exists.
            control("dispatch-launch-outcome", "live")
            open_review("fixture/browser", "spec-end-to-end", "Implement fixture/browser through draft PR", "/spec-end-to-end Resume prepared implementation for fixture/browser.")
            expect(page.locator("#launch-heading")).to_have_text("Review implementation assignment")
            page.locator("#launch-assignment-launch").click()
            expect(page.locator("#launch-result-package")).to_be_visible()
            expect(page.locator("#launch-heading")).to_have_text("Implementation is live")
            expect(page.locator("#launch-result-package")).to_have_attribute("data-package-kind", "implement")
            implement_input = posts("dispatchLaunch")[-1]["input"]
            implement_assignment = implement_input["assignment_id"]
            assert re.fullmatch(r"[0-9a-f]{64}", implement_input["expectedDigest"])
            launches = [entry for entry in control()["diagnostics"]["resolvers"] if entry["name"] == "dispatchLaunch"]
            assert launches and launches[-1]["matched"] is True, launches[-1:]
            expect(result_fact("assignment")).to_have_text(implement_assignment)
            expect(result_fact("package")).to_have_text("fixture/browser")
            expect(result_fact("stop")).to_have_text("Draft pull request")
            expect(result_fact("branch")).to_have_text("spec-browser")
            expect(result_fact("host")).to_have_text("Host not recorded for this assignment")
            expect(result_fact("started")).not_to_have_text("Not recorded")
            spec_href = page.locator("#launch-result-open-spec").get_attribute("href")
            assert spec_href and spec_href.startswith("#/specs?ws=fixture") and "id=" in spec_href, spec_href
            expect(page.locator("#launch-result-package")).to_contain_text("leaves Ready")
            expect(page.locator("#launch-result-package")).to_contain_text("draft pull request")
            report["scenarios"].append("Confirmed implementation launch returns to the same package, leaves Ready for Active starting before receipt and shows the recorded draft-pr stop")
            capture("implement-result")
            capture_scrolled("implement-result")
            # Publish the launched implementation; the receipt-free package is
            # projected as Active starting before any run receipt exists. The
            # canonical package path mirrors a real observer assignment record.
            control("publish-assignment", implement_assignment, skill="spec-end-to-end", package=receipt["package"])
            time.sleep(1.3)
            page.goto(receipt["url"] + "/#/agents?ws=fixture", wait_until="domcontentloaded")
            with page.expect_response(lambda response: "/api/state" in response.url) as response:
                page.get_by_role("button", name="Refresh state", exact=True).click()
            assert response.value.status == 200
            page.goto(receipt["url"] + "/#/specs?ws=fixture&filter=planned", wait_until="domcontentloaded")
            planned_titles = page.locator(".records .run-title")
            expect(planned_titles).to_have_count(1)
            expect(planned_titles.first).to_have_text("other-browser")
            page.goto(receipt["url"] + "/#/specs?ws=fixture&filter=active", wait_until="domcontentloaded")
            active_titles = page.locator(".records .run-title")
            expect(active_titles).to_have_count(1)
            expect(active_titles.first).to_have_text("browser")
            # Same-package return: the spec detail is the observed package, no
            # longer the planned Ready summary.
            page.goto(receipt["url"] + spec_href, wait_until="domcontentloaded")
            expect(page.locator(".records button.record.selected .run-title")).to_have_text("browser")
            expect(page.locator(".planned-spec-summary")).to_have_count(0)

            # Lost acknowledgement: unconfirmed stays generic, never claims a
            # package result and never offers a retry submission.
            control("dispatch-launch-outcome", "unknown")
            open_review("fixture/browser", "spec-architect-critics", "Plan fixture/browser critique", "/spec-architect-critics Plan fixture/browser.")
            expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
            launches_before = len(posts("dispatchLaunch"))
            starts_before = worker_starts()
            page.locator("#launch-assignment-launch").click()
            expect(page.locator("#launch-heading")).to_have_text("Launch is unconfirmed")
            expect(page.locator("#launch-result-package")).to_have_count(0)
            expect(page.locator("#launch-result-facts")).to_contain_text("not observed")
            expect(page.locator("#launch-assignment-launch")).to_have_count(0)
            unconfirmed_assignment = posts("dispatchLaunch")[-1]["input"]["assignment_id"]
            assert len(posts("dispatchLaunch")) == launches_before + 1
            agent_href = page.locator("#launch-result-open-agent").get_attribute("href")
            assert agent_href and unconfirmed_assignment in agent_href, agent_href
            assert worker_starts() == starts_before
            report["scenarios"].append("A lost acknowledgement stays unconfirmed with no retry submission, no package result and no observed worker")
            capture("unknown-result")

            # Confirmed failure keeps the exact identity and correction
            # transition; mismatched and cold result links stay exact
            # inspections and never fabricate success.
            control("dispatch-launch-outcome", "failed")
            open_review("fixture/browser", "spec-write", "Plan fixture/browser specification", "/spec-write Plan fixture/browser.")
            expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
            page.locator("#launch-assignment-launch").click()
            expect(page.locator("#launch-heading")).to_have_text("Agent could not start")
            expect(page.locator("#launch-result-package")).to_have_count(0)
            failed_assignment = posts("dispatchLaunch")[-1]["input"]["assignment_id"]
            expect(result_fact("assignment")).to_have_text(failed_assignment)
            expect(page.locator("#launch-result-correct")).to_be_visible()
            report["scenarios"].append("A confirmed failure keeps the exact assignment identity and the correction transition")
            capture("failed-result")
            # A result id that does not match the retained local result keeps
            # the exact requested and local identities in the same session.
            cold_uuid = "0f6a6c6e-3f0e-4a4a-9a6a-1f6a6c6e3f0e"
            page.goto(result_route("fixture/browser", "spec-write", cold_uuid), wait_until="domcontentloaded")
            expect(page.locator("#launch-result-inspection")).to_be_visible()
            expect(page.locator("[data-fact=requested-result] dd")).to_have_text(cold_uuid)
            expect(page.locator("[data-fact=local-result] dd")).to_have_text(failed_assignment)
            # A cold context carries no local record at all: the requested
            # identity is shown and nothing is fabricated.
            cold_context = browser.new_context(viewport={"width": 1280, "height": 900})
            cold_page = cold_context.new_page()
            cold_page.goto(result_route("fixture/browser", "spec-end-to-end", cold_uuid), wait_until="domcontentloaded")
            expect(cold_page.locator("#launch-result-inspection")).to_be_visible()
            expect(cold_page.locator("[data-fact=requested-result] dd")).to_have_text(cold_uuid)
            expect(cold_page.locator("[data-fact=local-result] dd")).to_have_text("Not recorded")
            cold_href = cold_page.get_by_role("link", name="Open agents").get_attribute("href")
            assert cold_href and cold_uuid in cold_href, cold_href
            for width in (1280, 1600):
                cold_page.set_viewport_size({"width": width, "height": 900})
                path = evidence / f"production-cold-result-{width}.png"
                cold_page.screenshot(path=str(path), full_page=True)
                report["captures"].append(str(path))
            cold_context.close()
            report["scenarios"].append("Failed and cold result links preserve the exact requested and local inspection identity without fabricating success")

        def run_specs():
            # Ready spec states through the real route and hand-off: readiness
            # facts, per-state primaries, cold planned alias normalization and
            # the legacy relaunch protection, all with no thread creation.
            deadline = started + 180

            def check_deadline(label):
                if time.monotonic() > deadline:
                    raise RuntimeError(f"specs case exceeded the 180 second deadline at {label}")

            def specs_route(**params):
                return receipt["url"] + "/#/specs?" + urlencode({"ws": "fixture", **params})

            def readiness_fact(key):
                return page.locator(f"#spec-readiness [data-fact={key}]")

            check_deadline("start")
            page.goto(specs_route(filter="ready"), wait_until="domcontentloaded")
            expect(page.get_by_role("button", name="Ready", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(page.locator(".list-caption")).to_contain_text("Prepared, not started")
            rows = page.locator(".records button.record[data-key]")
            expect(rows).to_have_count(6)
            expect(rows.nth(0).locator(".run-title")).to_have_text("browser")
            expect(rows.nth(1).locator(".run-title")).to_have_text("decision-browser")
            expect(rows.nth(2).locator(".run-title")).to_have_text("waiting-browser")
            expect(rows.nth(3).locator(".run-title")).to_have_text("incomplete-browser")
            report["scenarios"].append("Ready lists the scoped inventory in readiness order ahead of unplanned and legacy rows")

            rows.nth(0).click()
            expect(page.locator(".object-head h2")).to_have_text("browser")
            expect(page.locator("#spec-readiness")).to_have_attribute("data-state", "ready")
            expect(readiness_fact("prepared-steps")).to_contain_text("3")
            expect(readiness_fact("preparation-report")).to_contain_text("Prepared")
            expect(readiness_fact("execution-history")).to_contain_text("None")
            expect(readiness_fact("prerequisites")).to_contain_text("All landed")
            expect(page.locator("#spec-readiness-actions .ds-btn--primary")).to_have_count(1)
            implement = page.get_by_role("button", name="Implement spec", exact=True)
            expect(implement).to_be_enabled()
            expect(page.locator("#planned-assignment")).to_have_count(0)
            report["scenarios"].append("Ready detail renders the four observed facts with exactly one enabled Implement spec primary and no legacy launch form")
            capture("ready")
            capture_scrolled("ready")

            # Implement spec uses the step-8 hand-off: the canonical target
            # resolves from the recorded inventory and no thread is created.
            implement.click()
            expect(page.locator("#launch-heading")).to_have_text("Review implementation assignment")
            expect(fact("target")).to_contain_text("fixture-repo")
            expect(fact("target")).not_to_contain_text("main")
            assert len(posts("dispatchSaveBrief")) == 1
            assert posts("create") == []
            report["scenarios"].append("Implement spec opens the bound review with the canonical target alias and no thread creation")
            capture("implement-review")
            check_deadline("implement-review")

            # Waiting cannot submit; its single primary is the named
            # prerequisite and the disabled Implement keeps its reason.
            page.goto(specs_route(filter="ready"), wait_until="domcontentloaded")
            page.locator(".records button.record").filter(has_text="waiting-browser").click()
            expect(page.locator("#spec-readiness")).to_have_attribute("data-state", "waiting")
            expect(readiness_fact("prerequisites")).to_contain_text("other-browser")
            saves_before_waiting = len(posts("dispatchSaveBrief"))
            disabled_implement = page.get_by_role("button", name="Implement spec", exact=True)
            expect(disabled_implement).to_be_disabled()
            expect(page.locator("#spec-readiness-actions [data-action-note=implement]")).to_contain_text("Waiting on other-browser")
            primary = page.locator("#spec-readiness-actions .ds-btn--primary")
            expect(primary).to_have_count(1)
            expect(primary).to_have_text("Open prerequisite")
            capture("waiting")
            capture_scrolled("waiting")
            primary.click()
            expect(page.locator(".object-head h2")).to_have_text("other-browser")
            assert len(posts("dispatchSaveBrief")) == saves_before_waiting
            assert posts("create") == []
            report["scenarios"].append("Waiting keeps one Open prerequisite primary, disables Implement with its reason and opens the named prerequisite without a submission")

            # Resume planning derives its stage from the intact proposal facts;
            # no architecture stage is re-run and no thread is created.
            page.locator(".records button.record").filter(has_text="incomplete-browser").click()
            expect(page.locator("#spec-readiness")).to_have_attribute("data-state", "incomplete")
            expect(readiness_fact("prepared-steps")).to_contain_text("4")
            expect(page.locator("#spec-readiness-actions .ds-btn--primary")).to_have_count(1)
            capture("incomplete")
            capture_scrolled("incomplete")
            resume = page.get_by_role("button", name="Resume planning", exact=True)
            expect(resume).to_be_enabled()
            resume.click()
            expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
            expect(fact("stages")).to_contain_text("spec-write")
            expect(fact("stages")).not_to_contain_text("spec-architect-initial")
            expect(fact("stop")).to_contain_text("Prepared")
            assert posts("create") == []
            report["scenarios"].append("Resume planning derives the intact spec-write stage without re-architecture and creates no thread")
            capture("resume-planning")
            check_deadline("resume-planning")

            # An unresolved decision stays a discuss/read-files action.
            page.goto(specs_route(filter="ready"), wait_until="domcontentloaded")
            page.locator(".records button.record").filter(has_text="decision-browser").click()
            expect(page.locator("#spec-readiness")).to_have_attribute("data-state", "decision")
            expect(page.locator("#spec-readiness-actions .ds-btn--primary")).to_have_count(1)
            expect(page.locator("#spec-readiness-actions .ds-btn--primary")).to_have_text("Open preparation report")
            expect(page.get_by_role("button", name="Resume planning", exact=True)).to_have_count(0)
            report["scenarios"].append("A recorded decision keeps a discuss/read-files primary instead of resume planning")

            # Cold planned link normalizes to Ready; imported older fields stay
            # unknown with no launch and the observed reason.
            page.goto(specs_route(filter="planned"), wait_until="domcontentloaded")
            expect(page.get_by_role("button", name="Ready", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(page.locator(".list-caption")).to_contain_text("Prepared, not started")
            page.locator(".records button.record").filter(has_text="legacy-browser").click()
            expect(page.locator("#spec-readiness")).to_have_attribute("data-state", "unknown")
            expect(page.get_by_role("button", name="Implement spec", exact=True)).to_be_disabled()
            expect(page.locator("#spec-readiness-actions [data-action-note=implement]")).to_contain_text("New preparation facts are unavailable")
            report["scenarios"].append("Cold planned links normalize to Ready and imported older fields show unknown with no launch")

            # Search-empty and Ready-empty stay distinct.
            page.locator("#find-record").fill("no-such-spec")
            expect(page.get_by_role("heading", name="No matching specs", exact=True)).to_be_visible()
            expect(page.get_by_role("button", name="Clear filters", exact=True)).to_be_visible()
            page.locator("#find-record").fill("")
            page.goto(receipt["url"] + "/#/specs?" + urlencode({"ws": "other", "filter": "ready"}), wait_until="domcontentloaded")
            expect(page.get_by_role("heading", name="No specs are ready to implement", exact=True)).to_be_visible()
            expect(page.locator(".list-hint")).to_contain_text("started appear under Active")
            expect(page.get_by_role("button", name="Open epics", exact=True)).to_be_visible()
            report["scenarios"].append("Ready-empty explains unplanned epic work with a list hint and Open epics while search-empty keeps Clear filters")
            capture("ready-empty")

            # Legacy relaunch protection: a published end-to-end assignment
            # keeps the RelaunchAssignment review entry beside the starting
            # projection, still with no thread creation.
            control("publish-assignment", "a1b2c3d4-0000-4000-8000-000000000011", skill="spec-end-to-end", package=receipt["package"])
            time.sleep(1.3)
            page.goto(receipt["url"] + "/#/agents?ws=fixture", wait_until="domcontentloaded")
            with page.expect_response(lambda response: "/api/state" in response.url) as response:
                page.locator("header").get_by_role("button", name="Refresh state", exact=True).click()
            assert response.value.status == 200
            page.goto(receipt["url"] + "/#/specs?" + urlencode({"ws": "fixture", "filter": "active"}), wait_until="domcontentloaded")
            page.locator(".records button.record").filter(has_text="browser").first.click()
            expect(page.get_by_role("heading", name="Run spec again", exact=True)).to_be_visible()
            expect(page.get_by_role("button", name="Preview relaunch", exact=True)).to_be_visible()
            expect(page.locator("#spec-readiness")).to_have_attribute("data-state", "starting")
            expect(readiness_fact("prerequisites")).to_contain_text("All landed")
            footer_primary = page.locator(".detail-actions .ds-btn--primary")
            expect(footer_primary).to_have_count(1)
            expect(footer_primary).to_have_text("Open agent")
            assert posts("create") == []
            report["scenarios"].append("A published assignment keeps the starting projection and the legacy relaunch entry with no thread creation")
            capture("starting-relaunch")
            control("clear-launch-publications")
            check_deadline("end")

        def run_epic():
            # Epic planning actions through the real route and fixture: record
            # order and prepared-prerequisite truth, live-planning Open agent,
            # missing-directory honesty and no POST without a commitment.
            deadline = started + 180

            def check_deadline(label):
                if time.monotonic() > deadline:
                    raise RuntimeError(f"epic case exceeded the 180 second deadline at {label}")

            def member_row(slug):
                return page.locator("table.epic-members tbody tr").filter(has=page.get_by_role("button", name=slug, exact=True))

            def member_row_text(slug):
                return page.locator("table.epic-members tbody tr").filter(has_text=slug)

            def epic_facts():
                return page.locator(".facts .fact")

            def capture_epic_scrolled(name):
                for width in (1280, 1600):
                    page.set_viewport_size({"width": width, "height": 900})
                    page.evaluate("""() => {
                        const pane = document.querySelector('.detail-pane .detail-body');
                        if (pane) pane.scrollTo(0, pane.scrollHeight);
                        window.scrollTo(0, document.body.scrollHeight);
                    }""")
                    page.wait_for_timeout(300)
                    path = evidence / f"production-{name}-scrolled-{width}.png"
                    page.screenshot(path=str(path), full_page=False)
                    report["captures"].append(str(path))
                page.set_viewport_size({"width": 1280, "height": 900})

            def capture_epic_table(name):
                # Dependency-order evidence: scroll the real detail pane so the
                # table heading and the browser row with Open agent are visible
                # without clipping the action column.
                for width in (1280, 1600):
                    page.set_viewport_size({"width": width, "height": 900})
                    page.evaluate("""() => {
                        const pane = document.querySelector('.detail-pane .detail-body');
                        const heading = [...document.querySelectorAll('.detail-pane .section-heading h3')]
                          .find(el => el.textContent.trim() === 'Dependency order');
                        if (pane && heading) {
                          const paneRect = pane.getBoundingClientRect();
                          const headingRect = heading.getBoundingClientRect();
                          pane.scrollTop += headingRect.top - paneRect.top - 12;
                        }
                    }""")
                    page.wait_for_timeout(300)
                    path = evidence / f"production-{name}-table-{width}.png"
                    page.screenshot(path=str(path), full_page=False)
                    report["captures"].append(str(path))
                page.set_viewport_size({"width": 1280, "height": 900})

            check_deadline("start")
            page.goto(receipt["url"] + "/#/epics?ws=fixture", wait_until="domcontentloaded")
            expect(page.locator(".list-caption")).to_contain_text("epic record")
            # Opening an epic is read-only: rendering and the disabled action
            # below must create no POST before an explicit commitment.
            assert posts("dispatchSaveBrief") == [], posts("dispatchSaveBrief")
            assert posts("dispatchLaunch") == []
            page.locator(".records a.record").filter(has_text="Demo epic").click()
            expect(page.locator(".object-head h2")).to_have_text("Demo epic")
            expect(page.locator(".object-head")).to_contain_text("Planning incomplete")
            epic_url = page.url
            expect(epic_facts()).to_have_count(4)
            expect(epic_facts().nth(0)).to_contain_text("Recorded epic state")
            expect(epic_facts().nth(1)).to_contain_text("Members prepared")
            expect(epic_facts().nth(1)).to_contain_text("2 of 7")
            expect(epic_facts().nth(2)).to_contain_text("Members landed")
            expect(epic_facts().nth(2)).to_contain_text("0 of 7")
            expect(epic_facts().nth(3)).to_contain_text("Next to plan")
            expect(epic_facts().nth(3)).to_contain_text("other-browser")

            # First eligible in record order, an independent member behind a
            # positively prepared (not landed) prerequisite stays plannable,
            # and an index-only prerequisite keeps its Plan disabled.
            other = member_row("other-browser")
            expect(other.locator('[data-action="plan"]')).to_be_enabled()
            prepared_prereq = member_row("prepared-prereq-browser")
            expect(prepared_prereq.locator("td").first).to_have_text("base")
            expect(prepared_prereq.locator('[data-action="plan"]')).to_be_enabled()
            blocked = member_row("blocked-browser")
            expect(blocked.locator('[data-action="plan"]')).to_be_disabled()
            expect(blocked.locator(".action-note")).to_contain_text("Waiting on index-browser")
            index = member_row("index-browser")
            expect(index).to_contain_text("In progress")
            expect(index.locator('[data-action="plan"]')).to_have_count(0)
            report["scenarios"].append("Epic first eligible member follows record order with prepared-prerequisite truth enabled and an index-only blocked prerequisite without a Plan commitment")
            capture("epic-planning-incomplete")
            capture_epic_scrolled("epic-planning-incomplete")

            # Plan member seeds the step-8 planning review for the first
            # eligible member and dispatches nothing.
            expect(page.locator('[data-action-note="plan-target"]')).to_contain_text("Plans other-browser")
            page.locator('[data-action="plan-member"]').click()
            expect(page.locator("#launch-heading")).to_have_text("Review planning assignment")
            expect(page.locator("#launch-review .launch-contract")).to_be_visible()
            assert len(posts("dispatchSaveBrief")) == 1, posts("dispatchSaveBrief")
            assert posts("dispatchLaunch") == []
            assert worker_starts() == []
            report["scenarios"].append("Plan member opens the bound planning review for the first eligible member and starts no worker")
            page.goto(epic_url, wait_until="domcontentloaded")
            expect(page.locator(".object-head h2")).to_have_text("Demo epic")
            check_deadline("plan-member")

            # Live planning changes its row to Open agent without blocking the
            # independent member, and prepared members never count as landed.
            control("publish-assignment", "f00dfeed-0000-4000-8000-000000000012", skill="spec-architect-initial", package=receipt["package"])
            time.sleep(1.3)
            with page.expect_response(lambda response: "/api/state" in response.url) as response:
                page.locator("header").get_by_role("button", name="Refresh state", exact=True).click()
            assert response.value.status == 200
            expect(page.locator(".object-head h2")).to_have_text("Demo epic")
            browser_row = member_row("browser")
            expect(browser_row).to_contain_text("Planning")
            agent_link = browser_row.locator('a[data-action="open-agent"]')
            expect(agent_link).to_be_visible()
            agent_href = agent_link.get_attribute("href") or ""
            assert "f00dfeed-0000-4000-8000-000000000012" in agent_href, agent_href
            expect(member_row("other-browser").locator('[data-action="plan"]')).to_be_enabled()
            expect(page.locator('[data-action="plan-member"]')).to_be_enabled()
            expect(page.locator('[data-action-note="plan-target"]')).to_contain_text("Plans other-browser")
            expect(epic_facts().nth(2)).to_contain_text("0 of 7")
            report["scenarios"].append("Live planning row becomes Open agent without blocking the independent member and prepared members keep the landed count at zero")
            capture("epic-planning-active")
            capture_epic_scrolled("epic-planning-active")
            capture_epic_table("epic-planning-active")

            # Missing directory explains why Plan cannot launch and produces
            # no POST even when the disabled control is activated directly.
            missing = member_row_text("missing-browser")
            missing_plan = missing.locator('[data-action="plan"]')
            expect(missing).to_contain_text("No package")
            expect(missing).to_contain_text("Listed in the record; no package directory")
            expect(missing_plan).to_be_disabled()
            expect(missing.locator(".action-note")).to_contain_text("package directory is missing")
            saves = len(posts("dispatchSaveBrief"))
            launches = len(posts("dispatchLaunch"))
            missing_plan.dispatch_event("click")
            time.sleep(0.2)
            assert len(posts("dispatchSaveBrief")) == saves
            assert len(posts("dispatchLaunch")) == launches
            assert posts("dispatchLaunch") == []
            report["scenarios"].append("Missing directory disables Plan with its create-package reason and never posts")
            check_deadline("end")

        if arguments.case == "review":
            run_review()
        elif arguments.case == "result":
            run_result()
        elif arguments.case == "epic":
            run_epic()
        else:
            run_specs()

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
    (evidence / f"handoff-browser-{arguments.case}.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
