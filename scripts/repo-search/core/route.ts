import { extname } from "node:path";

import type { ChunkStrategy } from "./chunkContract";

export type CodeLanguage = "typescript" | "javascript" | "";

const AST_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
]);

const TS_EXTENSIONS: ReadonlySet<string> = new Set(["ts", "tsx"]);

const JS_EXTENSIONS: ReadonlySet<string> = new Set(["js", "jsx", "mjs", "cjs"]);

function extensionOf(path: string): string {
  const ext = extname(path);
  if (ext.length <= 1) return "";
  return ext.slice(1).toLowerCase();
}

export function routeStrategy(path: string): ChunkStrategy {
  const ext = extensionOf(path);
  if (AST_EXTENSIONS.has(ext)) return "ast";
  return "lineWindow";
}

export function languageForPath(path: string): CodeLanguage {
  const ext = extensionOf(path);
  if (TS_EXTENSIONS.has(ext)) return "typescript";
  if (JS_EXTENSIONS.has(ext)) return "javascript";
  return "";
}
