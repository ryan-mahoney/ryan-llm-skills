# Source provenance

Extracted from rearrange-writer `@ a8ed68577d7d559013b351e62faac3f89d3b28f1`
(`git@github.com:ryan-mahoney/rearrange-writer.git`).

The source project is marked `UNLICENSED`; this extraction records provenance
and does not claim a public license grant.

## Source → destination mapping

| Source | Destination |
| --- | --- |
| `server/code-index/chunkContract.ts` | `core/chunkContract.ts` |
| `server/code-index/chunk.ts` | `core/chunk.ts` |
| `server/code-index/route.ts` | `core/route.ts` |
| `server/code-index/fileManifest.ts` | `core/fileManifest.ts` |
| `server/code-index/codeIndexRuntime.ts` | `core/codeIndexRuntime.ts` |
| `server/code-index/codeEmbeddingCache.ts` | `core/codeEmbeddingCache.ts` |
| `server/code-index/codeEmbeddingRuntime.ts` | `core/codeEmbeddingRuntime.ts` |
| `server/code-index/codeModelAssets.ts` | `core/codeModelAssets.ts` |
| `server/transformersEnv.ts` | `core/transformersEnv.ts` |
| `shared/codeIndex.ts` (`CodeSearchHit`) | `core/codeIndexRuntime.ts` (local type) |
| — | `core/embeddingContract.ts` (new pure module) |

## Transformations applied

- **Legacy JSON restore removed.** Only the `orama-server-msgpack-v1` binary
  dump plus meta JSON remain; `@orama/plugin-data-persistence` is dropped.
- **Product imports removed.** `CodeSearchHit` is defined locally instead of
  importing `../../shared/codeIndex`.
- **Memory policy/trace removed.** `memoryHardeningPolicy` / `memoryTrace` usage
  is gone; remove batching uses the local
  `DEFAULT_CODE_INDEX_REMOVE_BATCH_SIZE = 10_000`.
- **CoreML/provisioning removed.** CPU-only execution
  (`executionProviders: ["cpu"]`), no `RESTORY_CODE_EP` profile, no asset
  provisioning or downloads.
- **Pure constants moved to `embeddingContract.ts`** so BM25/cache paths do not
  import `@huggingface/transformers`.
- **Pinned asset manifest added** with exact SHA256 values and an aggregate
  `assetDigest`; cache/index namespaces include it plus chunk/policy versions.

No model binaries were copied.
