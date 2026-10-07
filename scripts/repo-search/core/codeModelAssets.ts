import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type CodeModelAssetSpec = {
  path: string;
  sha256: string;
};

export const CODE_MODEL_ID = "jinaai/jina-embeddings-v2-base-code";

/**
 * Pinned model asset manifest. Digests are copied from the specification's
 * model file table. Changing a supported asset requires a new explicit package
 * manifest and an incompatible index namespace.
 */
export const PINNED_CODE_MODEL_ASSETS: readonly CodeModelAssetSpec[] = [
  {
    path: "config.json",
    sha256: "e426aa684c7f9a95c5f020aa855faf93a24f065f5fad0c9e17b124670cabdea6",
  },
  {
    path: "tokenizer.json",
    sha256: "b01c78a902aa4facb2f47f95449f48e2f7bbfea5d2472ee2f6ce92323c6f86e5",
  },
  {
    path: "tokenizer_config.json",
    sha256: "f477aeb15ff9f78d3c1ddf2361d2b0b8b20cf55220f839f29a37f3a18efddd89",
  },
  {
    path: "special_tokens_map.json",
    sha256: "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
  },
  {
    path: "vocab.json",
    sha256: "799ccbde8e1dfeda7cad79a81e5d6dfd4037f118e169185183885ec28119849c",
  },
  {
    path: "onnx/model_quantized.onnx",
    sha256: "ed45870251c9f0cf656e78aab0d37a23489066df8a222bb1c8caf8a45f2cb16d",
  },
];

export type CodeModelManifest = {
  modelId: string;
  modelsRoot: string;
  modelDir: string;
  requiredFiles: string[];
};

export function resolveCodeModelManifest(opts: {
  modelsRoot: string;
}): CodeModelManifest {
  const modelsRoot = opts.modelsRoot;
  const modelDir = join(modelsRoot, CODE_MODEL_ID);

  return {
    modelId: CODE_MODEL_ID,
    modelsRoot,
    modelDir,
    requiredFiles: PINNED_CODE_MODEL_ASSETS.map((asset) => asset.path),
  };
}

export type VerifiedModelFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type VerifiedModel = {
  modelId: string;
  modelsRoot: string;
  modelDir: string;
  assetDigest: string;
  files: VerifiedModelFile[];
};

export type CodeModelUnavailableReason = "missing" | "digest-mismatch";

export class CodeModelUnavailableError extends Error {
  readonly code = "code-model-unavailable";
  readonly reason: CodeModelUnavailableReason;
  readonly missing: string[];
  readonly mismatched: string[];

  constructor(input: {
    reason: CodeModelUnavailableReason;
    missing?: string[];
    mismatched?: string[];
    message: string;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "CodeModelUnavailableError";
    this.reason = input.reason;
    this.missing = input.missing ?? [];
    this.mismatched = input.mismatched ?? [];
    if (input.cause !== undefined) {
      (this as { cause?: unknown }).cause = input.cause;
    }
  }
}

function computeAssetDigest(assets: readonly CodeModelAssetSpec[]): string {
  const canonical = JSON.stringify(
    [...assets]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((asset) => [asset.path, asset.sha256]),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Verifies every pinned asset exists with size > 0 and a matching SHA256, then
 * returns a VerifiedModel carrying the aggregate assetDigest. Never downloads
 * or repairs assets.
 */
export async function verifyModel(
  modelsRoot: string,
  assets: readonly CodeModelAssetSpec[] = PINNED_CODE_MODEL_ASSETS,
): Promise<VerifiedModel> {
  const modelDir = join(modelsRoot, CODE_MODEL_ID);
  const missing: string[] = [];
  const mismatched: string[] = [];
  const files: VerifiedModelFile[] = [];

  for (const asset of assets) {
    const absPath = join(modelDir, asset.path);
    let bytes: Buffer;
    try {
      const info = await stat(absPath);
      if (!info.isFile() || info.size <= 0) {
        missing.push(asset.path);
        continue;
      }
      bytes = await readFile(absPath);
    } catch {
      missing.push(asset.path);
      continue;
    }

    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      mismatched.push(asset.path);
      continue;
    }

    files.push({ path: asset.path, bytes: bytes.byteLength, sha256: digest });
  }

  if (missing.length > 0) {
    throw new CodeModelUnavailableError({
      reason: "missing",
      missing,
      mismatched,
      message: `Code model assets missing: ${missing.join(", ")}.`,
    });
  }
  if (mismatched.length > 0) {
    throw new CodeModelUnavailableError({
      reason: "digest-mismatch",
      mismatched,
      message: `Code model asset digest mismatch: ${mismatched.join(", ")}.`,
    });
  }

  return {
    modelId: CODE_MODEL_ID,
    modelsRoot,
    modelDir,
    assetDigest: computeAssetDigest(assets),
    files,
  };
}
