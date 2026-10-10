# repo-search

Private, optional code-search core extracted from Restory. It owns the
deterministic chunking, vector-cache, and Orama persistence algorithms used by
the responsibility local search tooling.

The package never downloads models and never depends on Restory/Pi product
state. BM25 search, cache, and restore paths do not load native inference.

## Public entry points

- `core/codeIndexRuntime.ts` — `createCodeIndexRuntime(paths, { open })` builds an
  empty Orama runtime (`open: "new"`) or strictly restores a persisted one
  (`open: "restore"`); `CodeIndexUnavailableError` signals missing, corrupt, or
  incompatible state.
- `core/codeEmbeddingCache.ts` — `openCodeEmbeddingCache({ filePath })` opens the
  Bun SQLite embedding cache; `createCodeEmbeddingCacheNamespace(compatibility)`
  derives a cache namespace from the full compatibility identity.
- `core/codeModelAssets.ts` — `verifyModel(modelsRoot)` verifies the six pinned
  model assets and returns a `VerifiedModel` with an aggregate `assetDigest`.
- `core/chunk.ts` — `chunkFile(input, deps?)` produces `lineWindow` or real AST
  (`code-chunk`) chunks.

## Prerequisite: existing pinned model assets

Model acquisition is not implemented. Supply an existing local model root that
contains `jinaai/jina-embeddings-v2-base-code/` with the six files pinned in
`core/codeModelAssets.ts` (`PINNED_CODE_MODEL_ASSETS`). `verifyModel` checks each
file's byte digest; only all-matching assets produce an `assetDigest`, which the
cache and index compatibility identity include.

## Setup

For a first checkout index, `repo-search-setup` copies an existing pinned model
to `~/.local/share/agent-repo-search/models` outside Git, installs the locked
dependencies, builds the index, and can enable spec use. It does not download
model assets. The [setup and recovery guide](../../skills/repo-search-setup/references/setup-and-recovery.md)
shows the model directory, runnable command, storage and failure paths. The
lower-level commands below remain available for maintenance.

Explicitly install this package's locked dependencies and optionally register an
existing local model root:

```
node cli.mjs install [--models <existing-root>] [--state <root>]
```

- `install` runs `bun install --frozen-lockfile` in this package directory only.
- `--models` requires pre-existing local assets at
  `<models-root>/jinaai/jina-embeddings-v2-base-code/`. All six pinned digests in
  `core/codeModelAssets.ts` are verified before `<state>/settings.json` is
  written atomically (mode 0600).
- Repeated runs are idempotent: the same canonical root and digest report
  `alreadyConfigured` without rewriting settings.
- Invalid or truncated assets preserve the previous `settings.json` and return
  `model-unavailable`.
- Install never downloads model assets, enrolls a checkout, indexes source, or
  enables spec use.
- `build`, `update`, `reindex`, and vector `search` use `<state>/settings.json`
  when `--models` is omitted; an explicit `--models` always takes precedence,
  and the worker still verifies the assets before use.

## Focused tests

```
bun --no-install test scripts/repo-search/core/core.test.ts
```
