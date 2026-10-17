import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { safePath } from '../../../changeset/workspace.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const javascriptMode = path => /\.cjs$/i.test(path) ? 'commonjs' : /\.(?:mjs|js)$/i.test(path) ? 'module' : null;

export class ApplyWriterInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApplyWriterInputError';
  }
}

function validateInput({ path, source, sourceHash, allowedRegions, instruction, transport, maxOutputCharacters }) {
  try { safePath(path); }
  catch { throw new ApplyWriterInputError(`Invalid apply path: ${String(path)}`); }
  if (typeof source !== 'string' || !source.length) throw new ApplyWriterInputError('Apply source must be a nonempty string');
  if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash) || digest(source) !== sourceHash)
    throw new ApplyWriterInputError('Apply source hash does not match the current source');
  if (!Array.isArray(allowedRegions) || allowedRegions.length !== 1)
    throw new ApplyWriterInputError('Each apply call needs exactly one explicit planner-owned source range');
  const region = allowedRegions[0];
  if (!region || !Number.isInteger(region.start) || !Number.isInteger(region.end) ||
      region.start < 0 || region.end < region.start || region.end > source.length)
    throw new ApplyWriterInputError('Apply source range is invalid or ambiguous');
  if (typeof instruction !== 'string' || !instruction.trim()) throw new ApplyWriterInputError('Apply instruction must be nonempty');
  if (typeof transport !== 'function') throw new ApplyWriterInputError('An injected apply transport is required');
  if (!Number.isSafeInteger(maxOutputCharacters) || maxOutputCharacters < source.length)
    throw new ApplyWriterInputError('Output character limit must be an integer at least as large as the source');
  return region;
}

function syntaxFailure(path, text) {
  const mode = javascriptMode(path);
  if (!mode) return null;
  try {
    execFileSync(process.execPath, [`--input-type=${mode}`, '--check'], {
      input: text, timeout: 3000, maxBuffer: 16384, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (error) {
    return { code: 'syntax-invalid', summary: `Merged ${path} failed JavaScript syntax validation` };
  }
}

/**
 * Verify a complete replacement against one explicit planner-owned source range.
 * Source positions use JavaScript UTF-16 code units and are bound to sourceHash.
 */
export function verifyAppliedFile({ path, source, sourceHash, allowedRegions, merged, maxOutputCharacters = 1_000_000 }) {
  const region = validateInput({ path, source, sourceHash, allowedRegions, instruction: 'verify', transport: () => {}, maxOutputCharacters });
  if (typeof merged !== 'string') return { ok: false, code: 'invalid-output', summary: 'Apply transport did not return complete file text' };
  if (merged.length > maxOutputCharacters)
    return { ok: false, code: 'output-cap', summary: `Merged output exceeds ${maxOutputCharacters} characters` };
  const prefix = source.slice(0, region.start), suffix = source.slice(region.end);
  if (merged.length < prefix.length + suffix.length)
    return { ok: false, code: 'outside-region-changed', summary: 'Merged output is too short to preserve unchanged source outside the allowed range' };
  if (!merged.startsWith(prefix))
    return { ok: false, code: 'outside-region-prefix-changed', summary: 'Merged output changed or removed the exact source prefix outside the allowed range' };
  if (!merged.endsWith(suffix))
    return { ok: false, code: 'outside-region-suffix-changed', summary: 'Merged output changed or removed the exact source suffix outside the allowed range' };
  const syntaxError = syntaxFailure(path, merged);
  if (syntaxError) return { ok: false, syntax_checked: true, ...syntaxError };
  const syntax_checked = javascriptMode(path) !== null;
  return { ok: true, code: 'verified', syntax_checked,
    summary: syntax_checked
      ? 'Unchanged prefix and suffix are preserved; merged output passes syntax validation'
      : 'Unchanged prefix and suffix are preserved; syntax checking was skipped for this non-JavaScript file' };
}

/**
 * Apply a model-produced full file through an injected transport. It retries one
 * verifier rejection with a concise failure summary, then returns a loud failure.
 * No provider SDK, model registry, or network access is part of this prototype.
 */
export async function applyWriter({
  path, source, sourceHash, allowedRegions, instruction, transport, maxOutputCharacters = 1_000_000,
}) {
  const region = validateInput({ path, source, sourceHash, allowedRegions, instruction, transport, maxOutputCharacters });
  const request = {
    path,
    instruction,
    source,
    source_hash: sourceHash,
    allowed_regions: [{ ...region, original_text: source.slice(region.start, region.end) }],
  };
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response;
    try {
      response = await transport({ ...request, retry_summary: failures.at(-1)?.summary ?? null, attempt });
    } catch (error) {
      return { ok: false, status: 'transport-failed', path, attempts: attempt,
        failures: [...failures, { code: 'transport-error', summary: String(error?.message ?? error) }] };
    }
    const merged = typeof response === 'string' ? response : response?.text;
    const verdict = verifyAppliedFile({ path, source, sourceHash, allowedRegions, merged, maxOutputCharacters });
    if (verdict.ok) return { ok: true, status: 'applied', path, text: merged, attempts: attempt,
      syntax_checked: verdict.syntax_checked,
      source_hash: sourceHash, output_hash: digest(merged), failures };
    failures.push(verdict);
  }
  return { ok: false, status: 'rejected', path, attempts: 2, source_hash: sourceHash, failures };
}
