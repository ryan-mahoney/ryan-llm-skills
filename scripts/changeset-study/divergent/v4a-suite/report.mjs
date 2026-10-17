export function aggregate(manifest, rows) {
  const groups = [];
  for (const scheduled of manifest.schedule) {
    const key = [scheduled.track, scheduled.format, scheduled.selector, scheduled.repeat].join('|');
    if (groups.some(group => group.key === key)) continue;
    const planned = manifest.schedule.filter(cell => [cell.track, cell.format, cell.selector, cell.repeat].join('|') === key);
    const observed = rows.filter(row => planned.some(cell => cell.id === row.id));
    const edits = observed.filter(row => row.expected_outcome !== 'refusal'), refusals = observed.filter(row => row.expected_outcome === 'refusal');
    const gate = name => ({ passed: edits.filter(row => row.gates?.[name] === true).length, measured: edits.filter(row => typeof row.gates?.[name] === 'boolean').length, eligible: planned.filter(cell => cell.expected_outcome !== 'refusal').length });
    const receiptsKnown = observed.every(row => Number.isFinite(row.cost_usd));
    groups.push({ key, track: scheduled.track, format: scheduled.format, selector: scheduled.selector, repeat: scheduled.repeat,
      planned: planned.length, observed: observed.length, gates: Object.fromEntries(['stopped', 'parsed', 'paths', 'applied', 'unambiguous', 'syntax', 'correct'].map(gateName => [gateName, gate(gateName)])),
      refusal_correct: refusals.filter(row => row.refusal && row.gates?.correct === true).length,
      refusal_eligible: planned.filter(cell => cell.expected_outcome === 'refusal').length,
      unexpected_refusals: edits.filter(row => row.refusal).length,
      applied_incorrect: observed.filter(row => row.applied_incorrect).length,
      successful_cells: observed.filter(row => row.success).length,
      compiler_help_cases: observed.filter(row => row.compile_changes?.length).length,
      model_calls: observed.reduce((sum, row) => sum + (row.model_calls ?? 0), 0),
      generation_ms: observed.reduce((sum, row) => sum + (row.generation_ms ?? 0), 0),
      cost_usd: receiptsKnown ? observed.reduce((sum, row) => sum + row.cost_usd, 0) : null,
      output_bytes: observed.reduce((sum, row) => sum + (row.output_bytes ?? 0), 0),
      tokens: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'].map(name => [name, observed.every(row => Number.isFinite(row.usage?.[name])) ? observed.reduce((sum, row) => sum + row.usage[name], 0) : null])) });
  }
  return { protocol: manifest.protocol, revision: manifest.revision, fixture_corpus_hash: manifest.fixture_corpus_hash,
    planned_cells: manifest.schedule.length, completed_cells: rows.length,
    model_calls: rows.reduce((sum, row) => sum + (row.model_calls ?? 0), 0),
    known_receipt_cost_usd: rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    unknown_cost_cells: rows.filter(row => row.model_calls && !Number.isFinite(row.cost_usd)).length,
    ledger_exposure_usd: rows.every(row => Number.isFinite(row.ledger_exposure_usd)) ? rows.reduce((sum, row) => sum + row.ledger_exposure_usd, 0) : null,
    evidence_integrity_failures: rows.filter(row => row.evidence_integrity === false).map(row => row.id),
    applied_incorrect: rows.filter(row => row.applied_incorrect).map(row => row.id), groups,
    limitations: ['Synthetic small capability screen with two fixed repeats, not evidence of 95% reliability.', 'Encoding and implementation tracks have different questions and denominators.', 'Gold comparisons use exact bytes; no whitespace, comment, string or AST normalization.', 'Strict parsing is primary; V4A wrapper tolerance is a separate diagnostic.', 'V4A-compatible guarded adapter has documented departures from stock Codex.', 'Reported reasoning counts are a subset of output tokens, not additive usage.', 'Receipt costs use frozen model prices and are not independently verified invoices.'], rows };
}
export function markdown(report) {
  const lines = ['# V4A and executable JSON pilot', '', 'Two identical-input repeats are shown separately. This is a small capability screen; it cannot establish 95% reliability. Refusals are separate from edit-gate denominators. Applied-but-incorrect candidates remain visible.', '',
    '| Track | Format / model | Repeat | Observed | Parsed | Applied | Unambiguous | Syntax | Correct edits | Correct refusal | Applied incorrect | Calls | Generation s | Receipt USD |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const ratio = value => `${value.passed}/${value.eligible}`;
  for (const group of report.groups) lines.push(`| ${group.track} | ${group.format} / ${group.selector} | ${group.repeat} | ${group.observed}/${group.planned} | ${ratio(group.gates.parsed)} | ${ratio(group.gates.applied)} | ${ratio(group.gates.unambiguous)} | ${ratio(group.gates.syntax)} | ${ratio(group.gates.correct)} | ${group.refusal_correct}/${group.refusal_eligible} | ${group.applied_incorrect} | ${group.model_calls} | ${(group.generation_ms / 1000).toFixed(3)} | ${group.cost_usd === null ? 'unknown' : group.cost_usd.toFixed(9)} |`);
  lines.push('', `Actual calls: ${report.model_calls}; known receipt cost: $${report.known_receipt_cost_usd.toFixed(9)}; unknown-cost cells: ${report.unknown_cost_cells}.`, '', 'Gate JSON also records how many cells reached each measurement. Unmeasured gates are not passes. No model retry, tool lookup or behavioral-feedback loop ran. Exact gold/behavior checks were private. Full raw outputs, compiler additions and candidate bytes remain in adjacent cell artifacts.', '', '## Failed cells', '');
  for (const row of report.rows.filter(row => !row.success)) lines.push(`- ${row.id}: ${row.error?.code ?? 'gate-failure'} — ${row.error?.message ?? 'One or more required gates failed.'}`);
  lines.push('', '## Limits', '', ...report.limitations.map(value => `- ${value}`), '');
  return lines.join('\n');
}
