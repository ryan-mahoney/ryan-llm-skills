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

## Focused tests

```
bun --no-install test scripts/repo-search/core/core.test.ts
```
