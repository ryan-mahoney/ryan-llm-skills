# EV-10: workspace CLI fresh-process journeys

- Scope: step 10 workspace CLI. The production adapter is store.mjs plus the unchanged kit planner; no library source is modified by this evidence write.
- Required focused command (exact card command): node --test --test-name-pattern='workspace CLI restart' scripts/workspaces/cli.test.mjs
- Final receipt metadata (after): /Users/ryanmahoney/.agents/.specs/adj3-workspace-storage/runtime/runs/975b2515-6880-4ab7-961c-ee21d5fba326-verification-1784127c-65b5-4c2e-855b-72232db99d03.md
- Intermediate continuation receipt: /Users/ryanmahoney/.agents/.specs/adj3-workspace-storage/runtime/runs/975b2515-6880-4ab7-961c-ee21d5fba326-verification-926a4885-28e0-44b8-8f7a-bbbf9d0076e4.md
- Before receipt: /Users/ryanmahoney/.agents/.specs/adj3-workspace-storage/runtime/runs/6f111f34-c361-4666-bacc-bc7e670e2f1d-verification-6cdbf537-dc5a-432d-bcdc-72cd40a6baf9.md
- Git facts receipt: /Users/ryanmahoney/.agents/.specs/adj3-workspace-storage/runtime/runs/975b2515-6880-4ab7-961c-ee21d5fba326-verification-e6d5d7e5-334e-43ca-813f-ad8f7ad85eb7.md
- Execution base: df6049594f6348988bcb1058f625bbf84eb07cd9 with the CLI source and test files untracked; the metadata dirty flag is false because it omits untracked files, and the git-facts receipt confirms 3 untracked files. Command, time and raw output facts live in the receipts; none are reconstructed here.

## Red and green provenance

- Before receipt: 6/6 cases failed at the missing CLI entry with MODULE_NOT_FOUND/setup failure. That is a setup failure, not behavioral test-first red, and no behavioral red claim is made.
- Continuation first green: 4/6 passed, 2 failed on fixture assumptions (quoted YAML expectations and the nonrecursive setup needing an existing Documents directory). The repair corrected semantic assertions and the default-root pure boundary without weakening the store or any assertion.
- Final receipt: 6/6 passing real subprocess journeys against disposable temp roots.

## What the focused cases establish

- Pre-apply planning: with --json and --apply the CLI prints exactly two NDJSON documents, the exact pre-apply plan first and then the {path,backup} result. Source inspection confirms human apply prints the same preview formatter before replacement and then the result; subprocess cases exercise human previews and JSON applies.
- Refusal shape: stderr remains one {error,path} object, and after a post-backup failure path names the retained recovery backup.
- Dry run: kit bytes and mtime are unchanged, with no lock and no prior copy.
- Held lock: the pre-created kit.yaml.lock sentinel is preserved and the contender's completed prior copy is retained and named on stderr.
- Material input: stdin is read only when --from is absent; with --from and stdin left open the file still wins and the child exits without waiting.
- Root precedence: explicit --root overrides ADJACENT_STORAGE_ROOT, env roots stay isolated, and the default resolver is exercised through resolveStorageRoot({}, injectedHome) plus read-only real status runs.
- Fresh show: one workspace's repository role, brief, repository artifact and external URL artifact are retrieved by a later process.
- No-write refusals: duplicate and unknown flags, missing option values, inherited command names, control-character names, and a relative add-repo path all leave the tree snapshot unchanged.

## Boundaries

- Bounded children are awaited and temp roots removed; there is no HTTP write, no operator store use, no rerun of the installed consumer, and no power-loss or live claim.
- EV-9 (kit replacement) and EV-2 (parser, planner and adjacent oracle) remain unchanged precedents, not new checks here.
- Jev availability check f0cbf324-6f02-45f8-bc88-44a1c3fe4974 was unavailable; the owner runs the focused gate and broad work stays operator-owned.
