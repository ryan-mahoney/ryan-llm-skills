// Pure embedding/index constants shared by BM25, cache, and compatibility code.
// This module intentionally has no runtime imports: it must never pull in
// @huggingface/transformers or any native inference dependency.

export const CODE_INDEX_MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
export const CODE_INDEX_DIMENSIONS = 768;

export const CODE_EMBEDDING_DTYPE = "q8";
export const CODE_EMBEDDING_POOLING = "mean";
export const CODE_EMBEDDING_NORMALIZE = true;
export const CODE_EMBEDDING_MAX_CHARS = 2000;
export const CODE_EMBEDDING_CONTEXTUALIZED_TEXT_VERSION =
  "code-contextualized-text-v1";
export const CODE_EMBEDDING_RUNTIME_VERSION = "code-embedding-runtime-v1";

export const CODE_SEARCH_FORMAT = "repo-search-v1";
export const CODE_SEARCH_POLICY_VERSION = "tracked-source-v1";
export const CODE_CHUNK_VERSION = "code-chunk-v1";

export type CodeSearchCompatibility = {
  format: typeof CODE_SEARCH_FORMAT;
  modelId: string;
  assetDigest: string;
  dimensions: typeof CODE_INDEX_DIMENSIONS;
  dtype: typeof CODE_EMBEDDING_DTYPE;
  pooling: typeof CODE_EMBEDDING_POOLING;
  normalize: typeof CODE_EMBEDDING_NORMALIZE;
  maxChars: typeof CODE_EMBEDDING_MAX_CHARS;
  runtimeVersion: string;
  chunkVersion: string;
  policyVersion: string;
};

export function createCodeSearchCompatibility(input: {
  modelId: string;
  assetDigest: string;
  runtimeVersion?: string;
  chunkVersion?: string;
  policyVersion?: string;
}): CodeSearchCompatibility {
  return {
    format: CODE_SEARCH_FORMAT,
    modelId: input.modelId,
    assetDigest: input.assetDigest,
    dimensions: CODE_INDEX_DIMENSIONS,
    dtype: CODE_EMBEDDING_DTYPE,
    pooling: CODE_EMBEDDING_POOLING,
    normalize: CODE_EMBEDDING_NORMALIZE,
    maxChars: CODE_EMBEDDING_MAX_CHARS,
    runtimeVersion: input.runtimeVersion ?? CODE_EMBEDDING_RUNTIME_VERSION,
    chunkVersion: input.chunkVersion ?? CODE_CHUNK_VERSION,
    policyVersion: input.policyVersion ?? CODE_SEARCH_POLICY_VERSION,
  };
}
