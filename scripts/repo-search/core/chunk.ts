import type { ChunkStrategy, CodeChunk } from "./chunkContract";

export type RawAstChunk = {
  text: string;
  contextualizedText?: string;
  lineRange: { start: number; end: number };
  index?: number;
  symbol?: string;
  scope?: string;
};

export type AstChunker = (input: {
  path: string;
  content: string;
  language: string;
}) => Promise<RawAstChunk[]>;

const LINE_WINDOW_SIZE = 60;
const LINE_WINDOW_OVERLAP = 10;
const LINE_WINDOW_STEP = LINE_WINDOW_SIZE - LINE_WINDOW_OVERLAP;

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isEmptyContent(content: string): boolean {
  return content.trim().length === 0;
}

function lineWindowChunks(path: string, content: string, language: string): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  let start = 0;
  let chunkIndex = 0;
  while (start < lines.length) {
    const endIdx = Math.min(start + LINE_WINDOW_SIZE, lines.length) - 1;
    const window = lines.slice(start, endIdx + 1);
    const windowContent = window.join("\n");
    // A trailing newline (or a window landing on only blank lines) yields an
    // empty window; embedding it is noise and the index runtime rejects empty
    // content. Skip it without consuming a chunkIndex so emitted ids stay
    // contiguous (path#0..count-1), which the file manifest relies on.
    if (isEmptyContent(windowContent)) {
      start += LINE_WINDOW_STEP;
      continue;
    }
    chunks.push({
      content: windowContent,
      contextualizedText: `// ${path}\n${windowContent}`,
      path,
      startLine: start + 1,
      endLine: endIdx + 1,
      symbol: "",
      scope: "",
      language,
      chunkIndex,
    });
    chunkIndex += 1;
    start += LINE_WINDOW_STEP;
  }
  return chunks;
}

function synthesizeContextualizedText(
  path: string,
  scope: string,
  symbol: string,
): string {
  const suffix = scope ? `${scope}.${symbol}` : symbol;
  return suffix ? `// ${path}\n${suffix}` : `// ${path}`;
}

function astChunks(
  path: string,
  content: string,
  language: string,
  raws: RawAstChunk[],
): CodeChunk[] {
  return raws.map((raw, i) => {
    const symbol = raw.symbol ?? "";
    const scope = raw.scope ?? "";
    const contextualizedText =
      raw.contextualizedText && raw.contextualizedText.length > 0
        ? raw.contextualizedText
        : synthesizeContextualizedText(path, scope, symbol);
    return {
      content: raw.text,
      contextualizedText,
      path,
      startLine: raw.lineRange.start + 1,
      endLine: raw.lineRange.end + 1,
      symbol,
      scope,
      language,
      chunkIndex: typeof raw.index === "number" ? raw.index : i,
    };
  });
}

async function defaultAstChunk(input: {
  path: string;
  content: string;
  language: string;
}): Promise<RawAstChunk[]> {
  const { chunk } = await import("code-chunk");
  const raws = await chunk(input.path, input.content, {
    contextMode: "full",
    siblingDetail: "signatures",
  });
  return raws.map((c) => {
    const scopeParts = c.context?.scope?.map((s) => s.name) ?? [];
    const symbol =
      scopeParts.length > 0 ? scopeParts[scopeParts.length - 1] : undefined;
    const scope = scopeParts.length > 1 ? scopeParts.slice(0, -1).join(".") : "";
    return {
      text: c.text,
      contextualizedText: c.contextualizedText,
      lineRange: c.lineRange,
      index: c.index,
      symbol,
      scope: scope || undefined,
    };
  });
}

export async function chunkFile(
  input: {
    path: string;
    content: string;
    strategy: ChunkStrategy;
    language: string;
  },
  deps?: { astChunk?: AstChunker },
): Promise<CodeChunk[]> {
  const normalized = normalizeContent(input.content);
  if (isEmptyContent(normalized)) return [];

  if (input.strategy === "lineWindow") {
    return lineWindowChunks(input.path, normalized, input.language);
  }

  if (input.language === "") {
    return lineWindowChunks(input.path, normalized, input.language);
  }

  const astChunk = deps?.astChunk ?? defaultAstChunk;
  try {
    const raws = await astChunk({
      path: input.path,
      content: normalized,
      language: input.language,
    });
    return astChunks(input.path, normalized, input.language, raws);
  } catch {
    return lineWindowChunks(input.path, normalized, input.language);
  }
}
