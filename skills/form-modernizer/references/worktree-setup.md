# Phase 1 — Branch + Worktree + VSCode

Create an isolated worktree so the modernization work happens on a dedicated branch. Initial invocation only — the continuation session starts at Phase 2.

1. **Derive the branch name.** Use the pattern `modernize/{formNameKebab}` (e.g., `modernize/offer-form`).

2. **Extract the repository name** from `git remote get-url origin` (last path segment, strip `.git` suffix).

3. **Check for existing worktree/branch** (enables re-entry after a crashed run):
   - If `~/.worktrees/<repo-name>/modernize-{formNameKebab}` already exists, reuse it and skip to step 6.
   - If branch `modernize/{formNameKebab}` exists but no worktree, run:
     `git worktree add ~/.worktrees/<repo-name>/modernize-{formNameKebab} modernize/{formNameKebab}`
   - If neither exists, create both from the latest remote main:
     ```bash
     git fetch origin
     mkdir -p ~/.worktrees/<repo-name>
     git worktree add ~/.worktrees/<repo-name>/modernize-{formNameKebab} -b modernize/{formNameKebab} origin/main
     # CRITICAL: unset upstream so `git push` doesn't push to main
     git -C ~/.worktrees/<repo-name>/modernize-{formNameKebab} branch --unset-upstream
     ```

4. **Record the absolute worktree path.** All subsequent phases operate from this path. The `formPath` argument is relative to the repo root and remains valid in the worktree.

5. **Copy environment files** from the original repository root into the worktree:

   ```bash
   cp .env ~/.worktrees/<repo-name>/modernize-{formNameKebab}/.env
   ```

   If `.env` does not exist in the source repo, skip without failing.

6. **Color-code the VSCode window.** Use a consistent teal accent (`#0d7377`) for all form modernization worktrees. Write `.vscode/settings.json` in the worktree:
   - If no `.vscode/settings.json` exists, write:
     ```json
     {
       "workbench.colorCustomizations": {
         "titleBar.activeBackground": "#0d7377",
         "titleBar.activeForeground": "#ffffff",
         "statusBar.background": "#0d7377",
         "statusBar.foreground": "#ffffff"
       }
     }
     ```
   - If `.vscode/settings.json` already exists, merge via `jq`:
     ```bash
     jq --arg bg "#0d7377" \
       '.["workbench.colorCustomizations"] = {"titleBar.activeBackground": $bg, "titleBar.activeForeground": "#ffffff", "statusBar.background": $bg, "statusBar.foreground": "#ffffff"}' \
       .vscode/settings.json > /tmp/vscode-settings-tmp.json && mv /tmp/vscode-settings-tmp.json .vscode/settings.json
     ```
   - If `jq` is not available, write the file from scratch (color settings only).

7. **Write a continuation hook** so the new VSCode window's Claude Code session automatically picks up from Phase 2.

   Write `<worktree-path>/.claude/hooks/continue.sh`:

   ```bash
   #!/bin/bash
   cat <<'PROMPT'
   # Continue Form Modernization — {FormName}

   This worktree was created by the form-modernizer skill for `{formPath}`.
   The branch is `modernize/{formNameKebab}`.

   Pick up from Phase 2 of `~/.agents/skills/form-modernizer/SKILL.md`.
   The phase details live in `references/` beside that file — open
   `references/harness-setup.md`, `references/subagent-prompts.md`, and
   `references/screenshot-tests.md` when their phase begins.

   Before proceeding, load design rules:
   - `~/.agents/rules/form-design.md`
   - `~/.agents/rules/functionalist-design.md`
   - `~/.agents/rules/cta-design.md`
   - `docs/engineering-standards.md`

   Then execute Phase 2 (Playwright setup if needed), Phase 3 (parallel analysis), Phase 4 (design decisions), Phase 5 (implementation), Phase 6 (visual verification), and Phase 7 (final verification) in order.

   Arguments: {formPath} {any flags passed}
   PROMPT
   ```

   Make it executable: `chmod +x <worktree-path>/.claude/hooks/continue.sh`

   If `<worktree-path>/.claude/settings.json` exists, merge the block below into it. If it does not, write:

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "matcher": "startup",
           "hooks": [
             {
               "type": "command",
               "command": ".claude/hooks/continue.sh",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

8. **Open the worktree in a new VSCode window:**

   ```bash
   code --new-window ~/.worktrees/<repo-name>/modernize-{formNameKebab}
   ```

9. **STOP.** Report the worktree path, branch name, and form being modernized to the user. The new VSCode window's Claude Code session will receive the continuation prompt via the SessionStart hook — the user just needs to type "go".
