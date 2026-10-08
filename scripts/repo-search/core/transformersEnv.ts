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
 * once. A second call with the same root reasserts local-only cache policy. A call with a different
 * root throws the collision error. If this helper has not configured a root yet
 * and `env.localModelPath` is the Transformers.js package default
 * (`node_modules/@huggingface/transformers/models`), the helper overwrites it.
 */
export function configureTransformersLocalModelPath(root: string): void {
  // Only the digest-verified local asset tree may supply model bytes. Library
  // caches have precedence over localModelPath and are outside that contract.
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.useCustomCache = false;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  if (configuredLocalModelPath !== undefined) {
    if (configuredLocalModelPath === root) {
      env.localModelPath = root;
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
 * all changed model-path/cache/remote settings themselves.
 */
export function resetTransformersLocalModelPathForTests(): void {
  configuredLocalModelPath = undefined;
}
