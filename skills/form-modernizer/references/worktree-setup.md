# Workspace Coordination

The invoking top-level agent owns branch and worktree strategy. Form modernization owns only the
analysis, implementation, and verification inside the checkout it receives.

1. Resolve the current repository root with `git rev-parse --show-toplevel` and record the current
   branch or detached HEAD.
2. Treat that root as the workspace for every later phase. Resolve `formPath` relative to it.
3. If the root is a linked worktree, use it normally. Do not infer that a different worktree should
   be created merely because `~/.worktrees/` exists.
4. If the top-level request requires isolation but the current checkout does not provide it, return
   control with `outcome: blocked` and `reason: workspace-not-prepared`. Do not create or switch a
   branch/worktree from this leaf skill.
5. Do not copy environment files, alter `.vscode` or other editor configuration, open an editor,
   install a session/continuation hook, or start another agent session.
6. Continue directly to Phase 2 in the same run after the workspace is confirmed.

When this skill is invoked directly without a parent orchestrator, use the current checkout. Do not
surprise the user with repository or editor side effects beyond the requested modernization.
