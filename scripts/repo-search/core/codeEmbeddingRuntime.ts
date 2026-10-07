import { pipeline } from "@huggingface/transformers";

import { configureTransformersLocalModelPath } from "./transformersEnv";
import {
  CODE_EMBEDDING_DTYPE,
  CODE_EMBEDDING_MAX_CHARS,
  CODE_EMBEDDING_NORMALIZE,
  CODE_EMBEDDING_POOLING,
  CODE_INDEX_DIMENSIONS,
} from "./embeddingContract";
import {
  CODE_MODEL_ID,
  verifyModel,
  type CodeModelManifest,
} from "./codeModelAssets";

export type CodeEmbeddingRuntime = {
  modelId: string;
  dimensions: typeof CODE_INDEX_DIMENSIONS;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dispose?(): Promise<void>;
};

export type CodeEmbeddingExtractor = (
  input: string | string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<{ data?: ArrayLike<unknown>; tolist?: () => unknown }>;

export type DisposableCodeEmbeddingExtractor = CodeEmbeddingExtractor & {
  dispose?: () => void | Promise<void>;
};

export type CodeEmbeddingExtractorOutput = {
  data?: ArrayLike<unknown>;
  tolist?: () => unknown;
};

export type CodeEmbeddingRuntimeOptions = {
  manifest?: CodeModelManifest;
  pipeline?: typeof pipeline;
};

const codeEmbeddingDimensions = CODE_INDEX_DIMENSIONS;

export const CPU_CODE_EMBED_BATCH_SIZE = 16;

const CPU_EXECUTION_PROVIDERS = ["cpu"] as const;

function assertNonEmptyText(text: string): void {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Invalid text: expected a non-empty string.");
  }
}

function capLength(text: string): string {
  return text.length > CODE_EMBEDDING_MAX_CHARS
    ? text.slice(0, CODE_EMBEDDING_MAX_CHARS)
    : text;
}

function flattenUnknownList(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [value];
  }

  return value.flatMap((item) => flattenUnknownList(item));
}

function valuesFromExtractorOutput(output: CodeEmbeddingExtractorOutput): number[] {
  const values =
    output.data !== undefined
      ? Array.from(output.data)
      : output.tolist !== undefined
        ? flattenUnknownList(output.tolist())
        : [];

  if (values.length !== codeEmbeddingDimensions) {
    throw new Error(
      `Invalid embedding vector: expected ${codeEmbeddingDimensions} values, got ${values.length}.`,
    );
  }

  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Invalid embedding vector: value at index ${index} is not a finite number.`,
      );
    }
  });

  return values.map((value) => value as number);
}

function vectorsFromBatchOutput(
  output: CodeEmbeddingExtractorOutput,
  count: number,
): number[][] {
  const flat =
    output.data !== undefined
      ? Array.from(output.data)
      : output.tolist !== undefined
        ? flattenUnknownList(output.tolist())
        : [];

  const expected = count * codeEmbeddingDimensions;
  if (flat.length !== expected) {
    throw new Error(
      `Invalid batch embedding: expected ${expected} values (${count}×${codeEmbeddingDimensions}), got ${flat.length}.`,
    );
  }

  const vectors: number[][] = [];
  for (let row = 0; row < count; row += 1) {
    const start = row * codeEmbeddingDimensions;
    const slice = flat.slice(start, start + codeEmbeddingDimensions);
    slice.forEach((value, index) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `Invalid embedding vector: value at index ${index} of row ${row} is not a finite number.`,
        );
      }
    });
    vectors.push(slice as number[]);
  }

  return vectors;
}

/**
 * @internal Exposed so unit tests can cover validation without loading the ONNX model.
 */
export function createCodeEmbeddingRuntimeFromExtractor(
  modelId: string,
  extractor: DisposableCodeEmbeddingExtractor,
): CodeEmbeddingRuntime {
  const runtime: CodeEmbeddingRuntime = {
    modelId,
    dimensions: codeEmbeddingDimensions,

    async embed(text) {
      assertNonEmptyText(text);

      const output = await extractor(capLength(text), {
        pooling: CODE_EMBEDDING_POOLING,
        normalize: CODE_EMBEDDING_NORMALIZE,
      });
      return valuesFromExtractorOutput(output);
    },

    async embedBatch(texts) {
      if (!Array.isArray(texts)) {
        throw new Error("Invalid batch: expected an array of strings.");
      }
      if (texts.length === 0) return [];
      texts.forEach(assertNonEmptyText);

      const output = await extractor(texts.map(capLength), {
        pooling: CODE_EMBEDDING_POOLING,
        normalize: CODE_EMBEDDING_NORMALIZE,
      });
      return vectorsFromBatchOutput(output, texts.length);
    },
  };

  if (typeof extractor.dispose === "function") {
    runtime.dispose = async () => {
      await extractor.dispose?.();
    };
  }

  return runtime;
}

export async function createCodeEmbeddingRuntime(
  options: CodeEmbeddingRuntimeOptions = {},
): Promise<CodeEmbeddingRuntime> {
  const manifest = options.manifest;
  if (manifest === undefined) {
    throw new Error(
      "createCodeEmbeddingRuntime requires options.manifest (resolve it via resolveCodeModelManifest).",
    );
  }
  const modelId = manifest.modelId ?? CODE_MODEL_ID;
  const pipelineImpl = options.pipeline ?? pipeline;

  // Verification gates pipeline creation; a missing or mismatched asset set
  // never reaches inference.
  const verified = await verifyModel(manifest.modelsRoot);

  configureTransformersLocalModelPath(verified.modelsRoot);

  const extractor = await pipelineImpl("feature-extraction", modelId, {
    dtype: CODE_EMBEDDING_DTYPE,
    local_files_only: true,
    session_options: {
      executionProviders: [...CPU_EXECUTION_PROVIDERS],
    },
  });

  return createCodeEmbeddingRuntimeFromExtractor(modelId, extractor);
}
