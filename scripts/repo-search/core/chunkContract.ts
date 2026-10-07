// chunkContract.ts
export type ChunkStrategy = "ast" | "lineWindow";
export type CodeChunk = {
  content: string;            // raw code shown to the agent
  contextualizedText: string; // breadcrumb-prepended text that is embedded + BM25-indexed
  path: string;               // repo-relative
  startLine: number;          // 1-based, original file
  endLine: number;            // 1-based, >= startLine
  symbol: string;             // "" when none
  scope: string;              // "" when none
  language: string;           // "" when unknown
  chunkIndex: number;         // 0-based, sequential within the file
};

export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
