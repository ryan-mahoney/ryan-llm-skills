---
name: specops-index-agents
description: This skill should be used when the user asks to add, update, refresh, or repair the AGENTS.md table of contents/index for structured agent docs; link AGENTS.md to docs/specops/targets.json; or make per-target SpecOps agent docs discoverable from AGENTS.md.
disable-model-invocation: true
argument-hint: "[manifest-path-or-repo-root] [AGENTS.md optional]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Index Agents

Update the root `AGENTS.md` file with a generated index block that points agents at the structured
SpecOps docs. The root file stays compact; the per-target agent docs carry the detail.

This is a leaf utility. In the normal bootstrap flow, `specops-orchestrate-analysis` invokes it
after compressed docs are built. In the normal branch/PR flow, `specops-branch-refresh` invokes it
after affected target docs are refreshed. Run it directly only to repair or regenerate the index.

## Inputs

- Manifest path or repo root: `$ARGUMENTS` (or infer from current repository).
- Optional AGENTS path, defaulting to `AGENTS.md`.
- Default manifest path: `docs/specops/targets.json`.

## Procedure

1. Resolve the repo root, manifest path, and AGENTS path.
2. Confirm the manifest exists and contains a `targets` array.
3. Run the deterministic helper:

   ```bash
   node scripts/agent-docs.mjs write-index <repo-root> --manifest <manifest-path> --agents <AGENTS.md>
   ```

   If the target repo does not have `scripts/agent-docs.mjs`, use the shared suite script at
   `~/.agents/scripts/agent-docs.mjs`.
4. Inspect the resulting generated block.
5. Report:
   - AGENTS path updated.
   - Target count.
   - Any missing compressed agent docs.
   - Any missing deep analysis docs.

## Generated Block Contract

The helper writes only the block between:

```markdown
<!-- agents-docs:start -->
...
<!-- agents-docs:end -->
```

The block includes:

- the manifest path
- the system summary and external dependencies when present
- one row per target
- links to the compressed agent doc and deep analysis doc
- status showing whether each linked doc exists

## Guardrails

- Preserve every part of `AGENTS.md` outside the generated markers byte-for-byte.
- Do not embed full target docs in `AGENTS.md`.
- Do not edit analysis docs, compressed agent docs, source code, or manifest structural fields.
- If `AGENTS.md` does not exist, create it with only the generated block and report that no human
  guidance existed.
