import { env } from "@huggingface/transformers";

let configuredLocalModelPath: string | undefined;

function isTransformersPackageDefaultModelPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  // Development: the model path sits under node_modules.
  if (normalized.includes("node_modules/@huggingface/transformers/models")) {
    return true;
  }
  // Bun-bundled desktop builds: the default path resolves to <app>/models/
  // (Transformers.js resolves import.meta.url from the bundled file, which is
  // two `dirname()` hops from the package root, landing on the Resources/app/
  // directory — see @huggingface/transformers/src/env.js).
  // Bun's path.join(dirname, '/models/') concatenates instead of treating the
  // second arg as absolute (unlike Node), so the trailing slash is preserved.
  if (normalized.endsWith("/models/") || normalized.endsWith("/models")) {
    return true;
  }
  return false;
}

/**
 * The single writer of the Transformers.js global model-path singleton.
 *
 * Sets `env.allowRemoteModels = false` and `env.localModelPath = root` exactly
 * once. A second call with the same root is a no-op. A call with a different
 * root throws the collision error. If this helper has not configured a root yet
 * and `env.localModelPath` is the Transformers.js package default
 * (`node_modules/@huggingface/transformers/models`), the helper overwrites it.
 */
export function configureTransformersLocalModelPath(root: string): void {
  if (configuredLocalModelPath !== undefined) {
    if (configuredLocalModelPath === root) {
      return;
    }
    throw new Error(
      `Transformers.js local model path is already configured as ${configuredLocalModelPath}; cannot reconfigure to ${root}.`,
    );
  }

  const existingLocalModelPath =
    typeof env.localModelPath === "string" ? env.localModelPath : undefined;

  if (
    existingLocalModelPath !== undefined &&
    existingLocalModelPath !== root &&
    !isTransformersPackageDefaultModelPath(existingLocalModelPath)
  ) {
    throw new Error(
      `Transformers.js local model path is already configured as ${existingLocalModelPath}; cannot configure embeddings to ${root}.`,
    );
  }

  env.allowRemoteModels = false;
  env.localModelPath = root;
  configuredLocalModelPath = root;
}

/**
 * Test-only: clears the module's "configured" memo so a fresh test can
 * reconfigure. Does NOT touch `env`; tests must save/restore
 * `env.localModelPath` + `env.allowRemoteModels` themselves.
 */
export function resetTransformersLocalModelPathForTests(): void {
  configuredLocalModelPath = undefined;
}
