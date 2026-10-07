import type { GrowthCheck } from "./resources";
// Overlay manifest owner.
//
// An overlay manifest records the immutable base generation it overlays, the
// complete current worktree file manifest, and the sorted unique set of base
// paths whose chunks must be tombstoned. `baseId` is a generation UUID, never a
// store path. Missing/malformed reads return undefined; strict validation
// throws unavailable/corrupt-style errors.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  createFileManifestEntries,
  type FileManifestEntry,
} from "./fileManifest";

export const OVERLAY_MANIFEST_VERSION = "code-overlay-manifest-v1";

export type OverlayManifest = {
  version: typeof OVERLAY_MANIFEST_VERSION;
  baseId: string;
  modelId: string;
  dimensions: number;
  files: Record<string, FileManifestEntry>;
  tombstones: string[];
};

export function resolveOverlayManifestPath(storeDir: string): string {
  return join(resolve(storeDir), "code-index-overlay.json");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

const OVERLAY_MANIFEST_KEYS = [
  "version",
  "baseId",
  "modelId",
  "dimensions",
  "files",
  "tombstones",
] as const;

// Canonical lowercase UUID form produced by state's randomUUID.
const BASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Strict-shape validation; throws on malformed overlay metadata. */
export function validateOverlayManifest(value: unknown): OverlayManifest {
  if (!isPlainObject(value)) {
    throw new Error("Invalid overlay manifest.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== OVERLAY_MANIFEST_KEYS.length ||
    OVERLAY_MANIFEST_KEYS.some((key) => !keys.includes(key))
  ) {
    throw new Error("Invalid overlay manifest keys.");
  }
  if (value.version !== OVERLAY_MANIFEST_VERSION) {
    throw new Error("Invalid overlay manifest version.");
  }
  if (!isNonEmptyString(value.baseId) || !BASE_ID_PATTERN.test(value.baseId)) {
    throw new Error("Invalid overlay base generation id.");
  }
  if (!isNonEmptyString(value.modelId)) {
    throw new Error("Invalid overlay manifest identity.");
  }
  if (!isNonNegativeInteger(value.dimensions)) {
    throw new Error("Invalid overlay manifest dimensions.");
  }
  if (!isPlainObject(value.files)) {
    throw new Error("Invalid overlay manifest files.");
  }
  for (const entry of Object.values(value.files)) {
    if (!isPlainObject(entry)) {
      throw new Error("Invalid overlay manifest file entry.");
    }
    const entryKeys = Object.keys(entry);
    if (
      entryKeys.length !== 2 ||
      !entryKeys.includes("hash") ||
      !entryKeys.includes("chunkCount")
    ) {
      throw new Error("Invalid overlay manifest file entry.");
    }
    if (!isNonEmptyString(entry.hash) || !isNonNegativeInteger(entry.chunkCount)) {
      throw new Error("Invalid overlay manifest file entry.");
    }
  }
  if (!Array.isArray(value.tombstones)) {
    throw new Error("Invalid overlay manifest tombstones.");
  }
  const tombstones = value.tombstones as unknown[];
  for (let index = 0; index < tombstones.length; index += 1) {
    if (!isNonEmptyString(tombstones[index])) {
      throw new Error("Invalid overlay manifest tombstones.");
    }
    if (index > 0 && !((tombstones[index - 1] as string) < (tombstones[index] as string))) {
      throw new Error("Overlay tombstones must be strictly sorted and unique.");
    }
  }
  return {
    version: OVERLAY_MANIFEST_VERSION,
    baseId: value.baseId,
    modelId: value.modelId,
    dimensions: value.dimensions,
    files: value.files as Record<string, FileManifestEntry>,
    tombstones: tombstones as string[],
  };
}

/** Read an overlay manifest; missing or malformed returns undefined. */
export async function readOverlayManifest(storeDir: string): Promise<OverlayManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(resolveOverlayManifestPath(storeDir), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  try {
    return validateOverlayManifest(parsed);
  } catch {
    return undefined;
  }
}

/** Atomically write a canonical overlay manifest (sorted files and tombstones). */
export async function writeOverlayManifest(
  storeDir: string,
  manifest: OverlayManifest,
  beforeWrite?: GrowthCheck,
): Promise<void> {
  const sortedFiles = createFileManifestEntries();
  for (const key of Object.keys(manifest.files).sort()) sortedFiles[key] = manifest.files[key];
  const serialized: OverlayManifest = {
    version: OVERLAY_MANIFEST_VERSION,
    baseId: manifest.baseId,
    modelId: manifest.modelId,
    dimensions: manifest.dimensions,
    files: sortedFiles,
    tombstones: uniqueSorted(manifest.tombstones),
  };
  validateOverlayManifest(serialized);
  const path = resolveOverlayManifestPath(storeDir);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    const text = JSON.stringify(serialized, null, 2);
    beforeWrite?.(Buffer.byteLength(text));
    await writeFile(temp, text);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
