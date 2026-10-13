# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Exercise the planned-package launch preview through the real resolver.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=/tmp/sentinel-planned-launch-evidence uv run --script \
  scripts/spec-observe/frontend/planned-launch-browser-check.py
Only the final launch process boundary is fake; package resolution, the saved
brief, skill lookup, context construction, and Pi argv come from production code.
"""
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

root = Path(__file__).resolve().parent
evidence = Path(os.environ.get("SENTINEL_EVIDENCE_DIR", "/tmp/sentinel-planned-launch-evidence"))
evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
report = {"status": "failed", "scenarios": [], "pageErrors": []}
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
        raise RuntimeError("Planned launch fixture did not become ready within 10 seconds")
    receipt_line = fixture.stdout.readline()
    if not receipt_line:
        raise RuntimeError(f"Planned launch fixture exited before readiness: {fixture.stderr.read()}")
    receipt = json.loads(receipt_line)
    report["fixture"] = receipt
    report["observedCommit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    report["dirty"] = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip())

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=shutil.which("google-chrome"), headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1360, "height": 980}, device_scale_factor=1)
        page = context.new_page()
        single_target_mode = {"enabled": False, "filtered": 0}
        def filter_to_single_target(route):
            upstream = route.fetch()
            payload = upstream.json()
            if single_target_mode["enabled"]:
                def filter_packages(value):
                    if isinstance(value, dict):
                        planned = value.get("planned_packages")
                        if isinstance(planned, list):
                            for package in planned:
                                if isinstance(package, dict) and isinstance(package.get("targets"), list):
                                    package["targets"] = [item for item in package["targets"] if item.get("id") == "main"]
                                    single_target_mode["filtered"] += 1
                        for child in value.values(): filter_packages(child)
                    elif isinstance(value, list):
                        for child in value: filter_packages(child)
                filter_packages(payload)
            route.fulfill(response=upstream, json=payload)
        page.route("**/api/state**", filter_to_single_target)
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        post_urls = []
        page.on("request", lambda request: post_urls.append(request.url) if request.method == "POST" else None)
        page.goto(receipt["url"] + "/#/specs?ws=fixture&filter=planned", wait_until="domcontentloaded")
        expect(page.locator("h1")).to_have_text("Specs")
        rows = page.locator(".records button.record[data-key]")
        expect(rows).to_have_count(2)
        expect(rows.first.locator(".run-title")).to_have_text("browser")
        report["scenarios"].append("Planned packages sort by workspace/package")
        main_row = rows.filter(has=page.get_by_text("browser", exact=True))
        expect(main_row.locator(".run-title")).to_have_text("browser")
        expect(page.locator("main")).not_to_contain_text("Building the dashboard")
        main_row.click()

        form = page.locator("#planned-assignment")
        expect(form).to_be_visible()
        target = page.locator("#planned-assignment-target")
        expect(target).to_be_visible()
        expect(form).to_contain_text("fixture/browser · spec-end-to-end · PR access · deepseek / deepseek-flash:high")
        expect(page.locator("#planned-assignment-title")).to_have_value("Resume fixture/browser through PR publication")
        expect(page.locator("#planned-assignment-preview")).to_be_disabled()
        expect(page.locator("#planned-assignment-launch")).to_have_count(0)
        target.select_option(label=f"main · {receipt['checkout']}")
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()
        selected_target_key = target.input_value()

        brief = (
            "/spec-end-to-end Resume after spec-write for fixture/browser.\n"
            "Continue through PR publication.\n\n"
            "DEFAULT_OWNER: meta/muse-spark-1.3-contributor:xhigh from openrouter\n"
            "STRONG_OWNER: gpt-6.1-sol:medium from openai-codex\n"
            "EDITOR_AGENT: deepseek-flash:max from deepseek\n"
            "REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex\n"
            "SCOUT_AGENT: gpt-6-luna:low from openai-codex\n"
            "FINAL_REVIEWER: gpt-6.1-sol:xhigh from openai-codex\n"
            "PACKAGE: fixture/browser"
        )
        expect(page.locator("#planned-assignment-brief")).to_have_value(brief)

        def control(action=None, value=None):
            query = "" if action is None else "?" + urlencode({"action": action, "value": str(value).lower()})
            response = context.request.get(receipt["url"] + "/__fixture/control" + query)
            assert response.ok
            return response.json()

        def posts(name):
            return [post for post in control()["posts"] if post["name"] == name]

        def refresh_state():
            with page.expect_response(lambda response: response.url.startswith(receipt["url"] + "/api/state")) as response:
                page.get_by_role("button", name="Refresh state", exact=True).click()
            assert response.value.status == 200

        def assert_selected_target():
            expect(page.locator("#planned-assignment-target")).to_have_value(selected_target_key)

        def preview():
            page.locator("#planned-assignment-preview").click()
            expect(page.locator("#planned-assignment-preview-result")).to_be_visible()
            expect(page.locator("#planned-assignment-launch")).to_be_enabled()
            assert_selected_target()

        # Both package records share this one canonical primary. Switching
        # package identity without changing the target topology must auto-select
        # the target and preserve it through a state refresh.
        single_target_mode["enabled"] = True
        refresh_state()
        assert single_target_mode["filtered"] >= 2, single_target_mode
        expect(page.locator("#planned-assignment-target-summary")).to_contain_text(receipt["checkout"])
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()
        page.locator(".records button.record[data-key]").filter(has_text="other-browser").click()
        expect(page.locator(".object-head h2")).to_have_text("other-browser")
        expect(page.locator("#planned-assignment-target-summary")).to_contain_text(receipt["checkout"])
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()
        refresh_state()
        expect(page.locator("#planned-assignment-target-summary")).to_contain_text(receipt["checkout"])
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()
        report["scenarios"].append("Switching between packages with the same single canonical target keeps it selected across refresh")
        single_target_mode["enabled"] = False
        refresh_state()
        target = page.locator("#planned-assignment-target")
        expect(target).to_be_visible()
        target.select_option(label=f"main · {receipt['checkout']}")
        selected_target_key = target.input_value()
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()
        page.locator(".records button.record[data-key]").filter(has=page.get_by_text("browser", exact=True)).click()
        expect(page.locator(".object-head h2")).to_have_text("browser")
        target = page.locator("#planned-assignment-target")
        target.select_option(label=f"main · {receipt['checkout']}")
        selected_target_key = target.input_value()
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()

        # Switching planned packages during a delayed save must clear the old
        # request state and keep its eventual response from previewing stale work.
        control("delay-brief", True)
        page.locator("#planned-assignment-brief").fill(brief + "\nWait for target switch.")
        page.locator("#planned-assignment-preview").click()
        expect(page.locator("#planned-assignment-status")).to_contain_text("Preparing")
        page.locator(".records button.record[data-key]").filter(has_text="other-browser").click()
        expect(page.locator(".object-head h2")).to_have_text("other-browser")
        expect(page.locator("#planned-assignment-title")).to_have_value("Resume fixture/other-browser through PR publication")
        page.locator("#planned-assignment-target").select_option(label=f"main · {receipt['checkout']}")
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()
        expect(page.locator("#planned-assignment-launch")).to_have_count(0)
        expect(page.locator("#planned-assignment-status")).to_have_count(0)
        page.wait_for_function(
            "async () => { const response = await fetch('/__fixture/control'); return (await response.json()).completedBriefWrites >= 1; }",
            timeout=5000,
        )
        expect(page.locator("#planned-assignment-preview-result")).to_have_count(0)
        expect(page.locator("#planned-assignment-status")).to_have_count(0)
        assert len(posts("previewAssignment")) == 0
        assert len(posts("send")) == 0
        control("delay-brief", False)
        page.locator(".records button.record[data-key]").filter(has=page.get_by_text("browser", exact=True)).click()
        expect(page.locator(".object-head h2")).to_have_text("browser")
        expect(page.locator("#planned-assignment-brief")).to_have_value(brief)
        target = page.locator("#planned-assignment-target")
        target.select_option(label=f"main · {receipt['checkout']}")
        selected_target_key = target.input_value()

        draft_before_refresh = brief + "\nDraft survives state refresh."
        page.locator("#planned-assignment-brief").fill(draft_before_refresh)
        refresh_state()
        assert_selected_target()
        expect(page.locator("#planned-assignment-brief")).to_have_value(draft_before_refresh)
        page.locator("#planned-assignment-brief").fill(brief)
        report["scenarios"].append("An edited Planned brief survives a live snapshot refresh before preview")
        page.locator("#planned-assignment-target").select_option(label=f"main · {receipt['checkout']}")
        report["scenarios"].append("Switching planned packages during a delayed save resets pending state and discards the old result")

        preview()
        expect(page.locator("#planned-assignment-status")).to_contain_text("Preview")
        assert len(posts("create")) == 1
        assert len(posts("previewAssignment")) == 1
        assert len(posts("launchAssignment")) == 0
        assert len(posts("send")) == 0
        state = control()
        create_input = posts("create")[0]["input"]
        assert create_input["workspace_id"] == "fixture"
        assert create_input["target"] == {"kind": "worktree", "path": receipt["checkout"]}
        assert create_input["specPackage"] == "fixture/browser"
        save_input = posts("saveBrief")[-1]["input"]
        assert save_input["content"] == brief
        assert save_input["title"] == "Resume fixture/browser through PR publication"
        preview_input = posts("previewAssignment")[0]["input"]
        assert preview_input["specPackage"] == "fixture/browser"
        assert preview_input["skill"] == "spec-end-to-end"
        assert preview_input["publication_authority"] == "pr"
        assert preview_input["provider"] == "deepseek"
        assert preview_input["model"] == "deepseek-flash"
        assert preview_input["thinking"] == "high"
        resolved = state["launchResolutions"][preview_input["request_id"]]
        record = resolved["record"]
        assert record["spec_package"] == receipt["package"]
        assert record["package_ref"] == "fixture/browser"
        prepared = posts("prepareSpecTarget")[-1]["input"]
        assert prepared["spec_package"] == "fixture/browser"
        assert prepared["thread_id"] == preview_input["thread_id"]
        expected_worktree = str(Path(receipt["checkout"]).with_name("checkout-browser"))
        assert record["execution_dir"] == expected_worktree
        assert record["execution_branch"] == "spec-browser"
        assert subprocess.check_output(["git", "-C", expected_worktree, "branch", "--show-current"], text=True).strip() == record["execution_branch"]
        assert subprocess.check_output(["git", "-C", expected_worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True).strip() == str(Path(receipt["checkout"]) / ".git")
        assert record["repository_id"] == "fixture-repo"
        assert record["publication_authority"] == "pr"
        assert record["skill"] == "spec-end-to-end"
        assert record["skill_path"] == str(Path(receipt["root"]) / ".agents/skills/spec-end-to-end/SKILL.md")
        assert record["provider"] == "deepseek"
        assert record["model"] == "deepseek-flash"
        assert record["thinking"] == "high"
        prompt = resolved["inputPreview"]["instruction"]
        assert prompt.startswith("Assignment context\n")
        assert "node " + str(Path(receipt["root"]) / ".agents/scripts/spec-location/cli.mjs check fixture/browser") in prompt
        assert "- Publication authority: pr. You may push the branch and open a pull request ready for review." in prompt
        assert "Read the skill at " + record["skill_path"] in prompt
        assert "Perform the attached assignment brief." in prompt
        argv = resolved["piArgs"]
        assert argv[argv.index("--provider") + 1] == "deepseek"
        assert argv[argv.index("--model") + 1] == "deepseek-flash"
        assert argv[argv.index("--thinking") + 1] == "high"
        assert argv[-1] == prompt
        assert "fixture/browser" in resolved["inputPreview"]["brief"]
        assignment_id = preview_input["assignment_id"]
        digest = resolved["contractDigest"]
        refresh_state()
        assert_selected_target()
        expect(page.locator("#planned-assignment-preview-result")).to_be_visible()
        expect(page.locator("#planned-assignment-preview-result")).to_contain_text(assignment_id)
        expect(page.locator("#planned-assignment-launch")).to_be_enabled()
        report["scenarios"].append("Refreshing the planned inventory preserves the reviewed assignment id and explicit Launch control; launch later must match the captured resolver digest")
        report["scenarios"].append(
            "Planned inventory prepares and resolves its separate canonical spec worktree and branch, fake-home skill, exact resume brief, PR-authority prompt and Pi argv"
        )

        for capture_width in (1280, 1600):
            page.set_viewport_size({"width": capture_width, "height": 800})
            screenshot = evidence / f"planned-launch-ready-before-explicit-launch-{capture_width}.png"
            page.screenshot(path=str(screenshot), full_page=True)
            report.setdefault("captures", []).append(str(screenshot))

        # Editing the brief invalidates the reviewed contract. Only a new
        # preview of the current saved draft can expose Launch again.
        edited_brief = brief + "\nOperator update."
        page.locator("#planned-assignment-brief").fill(edited_brief)
        expect(page.locator("#planned-assignment-launch")).to_have_count(0)
        expect(page.locator("#planned-assignment-preview")).to_be_enabled()
        refresh_state()
        assert_selected_target()
        expect(page.locator("#planned-assignment-brief")).to_have_value(edited_brief)
        expect(page.locator("#planned-assignment-launch")).to_have_count(0)
        assert len(posts("launchAssignment")) == 0
        preview()
        assert len(posts("previewAssignment")) == 2
        assert posts("saveBrief")[-1]["input"]["content"] == edited_brief
        assert len(posts("send")) == 0
        edited_preview = posts("previewAssignment")[-1]["input"]
        edited_resolution = control()["launchResolutions"][edited_preview["request_id"]]
        assert "Operator update." in edited_resolution["inputPreview"]["brief"]
        report["scenarios"].append("Editing the brief removes Launch and requires a new resolver preview for the edited draft")

        current_preview = posts("previewAssignment")[-1]["input"]
        current_resolution = control()["launchResolutions"][current_preview["request_id"]]
        page.locator("#planned-assignment-launch").click()
        expect(page.locator("#planned-assignment-result")).to_be_visible()
        expect(page.locator("#planned-assignment-result")).to_contain_text("live")
        launch_input = posts("launchAssignment")[-1]["input"]
        assert launch_input["expectedDigest"] == current_resolution["contractDigest"]
        assert launch_input["specPackage"] == "fixture/browser"
        assert launch_input["publication_authority"] == "pr"
        assert len(posts("send")) == 0
        assert page.url.startswith(receipt["url"] + "/#/")
        report["scenarios"].append("Launch occurs only after the explicit button and uses the fresh resolver digest without sending a discussion message")

        # The same planned package remains browseable when the trusted action
        # token is absent, while preview and launch stay unavailable.
        readonly_context = browser.new_context(viewport={"width": 1360, "height": 980})
        readonly_page = readonly_context.new_page()
        def strip_action_token(route):
            upstream = route.fetch()
            payload = upstream.json()
            payload.pop("action_token", None)
            payload.pop("thread_action_token", None)
            route.fulfill(response=upstream, json=payload)
        readonly_page.route("**/api/state**", strip_action_token)
        readonly_page.goto(receipt["url"] + "/#/specs?ws=fixture&filter=planned", wait_until="domcontentloaded")
        readonly_page.locator(".records button.record[data-key]").first.click()
        readonly_form = readonly_page.locator("#planned-assignment")
        expect(readonly_form).to_be_visible()
        readonly_page.locator("#planned-assignment-target").select_option(label=f"main · {receipt['checkout']}")
        expect(readonly_page.locator("#planned-assignment-preview")).to_be_disabled()
        expect(readonly_page.locator("#planned-assignment-launch")).to_have_count(0)
        assert len(posts("previewAssignment")) == 2
        report["scenarios"].append("Missing action token keeps the planned package readable and prevents assignment preview")
        readonly_context.close()

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
    (evidence / "planned-launch-browser.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
