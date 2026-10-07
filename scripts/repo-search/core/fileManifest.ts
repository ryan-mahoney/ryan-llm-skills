import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type FileManifestEntry = {
  hash: string;
  chunkCount: number;
};

export type FileManifest = {
  version: string;
  modelId: string;
  dimensions: number;
  files: Record<string, FileManifestEntry>;
};

export type ManifestDiff = {
  changed: string[];
  deleted: string[];
  unchanged: string[];
};

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function resolveManifestPath(storeDir: string): string {
  return join(resolve(storeDir), "code-index-files.json");
}

export function diffManifest(
  prev: FileManifest | undefined,
  current: Array<{ path: string; hash: string }>,
): ManifestDiff {
  const currentHashByPath = new Map<string, string>();
  for (const entry of current) {
    currentHashByPath.set(entry.path, entry.hash);
  }

  const changed: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  if (prev === undefined) {
    for (const path of currentHashByPath.keys()) {
      changed.push(path);
    }
    changed.sort();
    return { changed, deleted, unchanged };
  }

  for (const [path, entry] of Object.entries(prev.files)) {
    const nextHash = currentHashByPath.get(path);
    if (nextHash === undefined) {
      deleted.push(path);
    } else if (nextHash === entry.hash) {
      unchanged.push(path);
    } else {
      changed.push(path);
    }
  }

  for (const path of currentHashByPath.keys()) {
    if (!Object.prototype.hasOwnProperty.call(prev.files, path)) {
      changed.push(path);
    }
  }

  changed.sort();
  deleted.sort();
  unchanged.sort();
  return { changed, deleted, unchanged };
}

export async function readFileManifest(path: string): Promise<FileManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  try {
    return parseManifestShape(parsed);
  } catch {
    return undefined;
  }
}

export async function writeFileManifest(path: string, manifest: FileManifest): Promise<void> {
  const sortedFiles: Record<string, FileManifestEntry> = {};
  for (const key of Object.keys(manifest.files).sort()) {
    sortedFiles[key] = manifest.files[key];
  }
  const serialized: FileManifest = {
    version: manifest.version,
    modelId: manifest.modelId,
    dimensions: manifest.dimensions,
    files: sortedFiles,
  };
  const text = JSON.stringify(serialized, null, 2);

  await mkdir(dirname(path), { recursive: true });

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, text);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function parseManifestShape(value: unknown): FileManifest {
  if (!isPlainObject(value)) {
    throw new Error("Invalid file manifest.");
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.includes("version") ||
    !keys.includes("modelId") ||
    !keys.includes("dimensions") ||
    !keys.includes("files")
  ) {
    throw new Error("Invalid file manifest.");
  }

  const { version, modelId, dimensions, files } = value as {
    version: unknown;
    modelId: unknown;
    dimensions: unknown;
    files: unknown;
  };

  if (!isNonEmptyString(version) || !isNonEmptyString(modelId)) {
    throw new Error("Invalid file manifest.");
  }
  if (!isNonNegativeInteger(dimensions)) {
    throw new Error("Invalid file manifest.");
  }
  if (!isPlainObject(files)) {
    throw new Error("Invalid file manifest.");
  }

  for (const entry of Object.values(files as Record<string, unknown>)) {
    if (!isPlainObject(entry)) {
      throw new Error("Invalid file manifest.");
    }
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== 2 || !entryKeys.includes("hash") || !entryKeys.includes("chunkCount")) {
      throw new Error("Invalid file manifest.");
    }
    const { hash, chunkCount } = entry as { hash: unknown; chunkCount: unknown };
    if (!isNonEmptyString(hash) || !isNonNegativeInteger(chunkCount)) {
      throw new Error("Invalid file manifest.");
    }
  }

  return {
    version,
    modelId,
    dimensions,
    files: files as Record<string, FileManifestEntry>,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
