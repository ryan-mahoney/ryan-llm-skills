import { readFileSync, existsSync, mkdirSync, lstatSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { safePath } from '../../../scripts/changeset/workspace.mjs';
import { writeArtifact } from '../../../scripts/changeset/telemetry.mjs';
import { planStagePackets } from './wave-review-state.mjs';
import { parseReviewFindings } from '../../../skills/spec-branch-fix/scripts/fix-packets.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const git = (record, ...args) => execFileSync('git', ['-C', record.checkout, ...args], { encoding: 'utf8', timeout: 5000 }).trim();

export function reportPath(record) {
  const path = safePath(record.stage?.report_path);
  if (!/^reviews\/.+\.md$/.test(path)) throw new Error('Stage report must be a Markdown file under reviews/');
  let current = record.package;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symlink stage artifact refused');
  }
  return current;
}

export function serialFixContext(packageDir, reviewPath, fixPath, index = 1) {
  const source = reportPath({ package: packageDir, stage: { report_path: reviewPath } });
  const text = readFileSync(source, 'utf8'), review = parseReviewFindings(text), planned = planStagePackets(text);
  const packet = planned.packets.find(packet => packet.index === index);
  if (!packet || !/^[a-f0-9]{40}$/.test(review.commit)) throw new Error('Select a canonical pending fix packet from the committed review');
  const label = reviewPath.replace(/^reviews\//, '').replace(/-review\.md$/, '').replace(/\.md$/, '');
  const prior = [];
  for (const file of readdirSync(join(packageDir, 'runtime/runs')).filter(file => file.endsWith('-stage.json'))) {
    const receipt = JSON.parse(readFileSync(join(packageDir, 'runtime/runs', file), 'utf8'));
    if (!receipt.accepted || receipt.role !== 'fixer' || receipt.label !== label || receipt.head !== review.commit || receipt.artifact !== fixPath) continue;
    const run = JSON.parse(readFileSync(join(packageDir, 'runtime/runs', `${receipt.run_id}.json`), 'utf8'));
    prior.push({ index: run.stage?.packet?.index, triage: receipt.payload.triage });
  }
  for (let earlier = 1; earlier < index; earlier++) if (!prior.some(packet => packet.index === earlier))
    throw new Error(`Fix packet ${earlier} must complete before packet ${index}`);
  return { role: 'fixer', label, head: review.commit, packet,
    expected_ids: review.findings.filter(finding => finding.actionable === true).map(finding => finding.id),
    review_path: reviewPath, fix_path: fixPath, triage_summary: prior.find(packet => packet.index === 1)?.triage?.summary ?? null };
}

export function decisionPrompt(record) {
  return `Own the ${record.stage.kind} assignment under the supplied skill and authority.\n`
    + `PACKAGE: ${record.package}\nCHECKOUT: ${record.checkout}\nCANONICAL STEP (context, not a new implementation assignment): ${record.step}\n`
    + `REVIEW BASE: ${record.stage.base}\nSTARTING HEAD: ${record.stage.head}\nREPORT: ${reportPath(record)}\n`
    + `${record.stage.assignment}\n`
    + 'Inspect source and findings yourself. Use spec_editor for every code edit; STRONG_OWNER plans even when you own the assessment. '
    + (record.stage.kind === 'conflict-resolution'
      ? 'Use spec_verify for focused checks. Do not create a normal commit: submit a checkpoint report for the coordinator to continue the pending Git operation. '
      : 'Use spec_verify for focused checks and spec_commit for accepted changes. ')
    + 'No unrestricted editor, shell, or nested implementation worker is permitted. '
    + 'Writers never receive raw test output or the full review. After all authorized work, use spec_report to write your assigned canonical report. '
    + 'Preserve review budgets and publication limits. Push and rebase are coordinator operations, not authority granted to this worker.';
}

export function submitDecisionReport(record, { outcome, summary, unresolved = [], evidence_receipts = [] }) {
  if (record.stage?.role !== 'decision') throw new Error('Only the assigned stage owner can submit this report');
  if (!['complete', 'blocked', 'checkpoint'].includes(outcome) || typeof summary !== 'string' || !summary.trim() || summary.length > 24000)
    throw new Error('A bounded report and explicit outcome are required');
  if (!Array.isArray(unresolved) || unresolved.some(value => typeof value !== 'string')) throw new Error('Unresolved concerns must be strings');
  const head = git(record, 'rev-parse', 'HEAD');
  if (outcome === 'complete') {
    if (existsSync(join(record.package, 'runtime/runs', `${record.id}-commit-reconciliation.json`)))
      throw new Error('Commit publication requires reconciliation before stage completion');
    if (unresolved.length || git(record, 'status', '--porcelain')) throw new Error('Unresolved concerns or dirty source require a checkpoint');
    const latest = join(record.package, 'runtime/runs', `${record.id}-editor-outcome.json`);
    if (existsSync(latest) && JSON.parse(readFileSync(latest, 'utf8')).state === 'incomplete') throw new Error('Resolve the incomplete changeset before completing the stage');
  }
  const verificationFile = join(record.package, 'runtime/runs', `${record.id}-verification.json`);
  const receipts = existsSync(verificationFile) ? JSON.parse(readFileSync(verificationFile, 'utf8')).receipts : [];
  if (!Array.isArray(evidence_receipts) || evidence_receipts.some(id => !receipts.some(receipt => receipt.id === id))) throw new Error('Unknown verification receipt');
  const report = { schema_version: 1, run_id: record.id, kind: record.stage.kind, outcome,
    reviewed_base: record.stage.base, reviewed_head: record.stage.head, final_head: head,
    owner_model: record.owner_model, planner_model: record.planner_model, editor_model: record.editor_model,
    summary, unresolved, evidence: receipts.filter(receipt => evidence_receipts.includes(receipt.id)),
    observed_at: new Date().toISOString(), publication: 'Coordinator retains publication authority' };
  const markdown = `# ${record.stage.kind}\n\noutcome: ${outcome}\nreviewed-base: ${report.reviewed_base}\nreviewed-head: ${report.reviewed_head}\nfinal-head: ${head}\n\n`
    + `${summary}\n\n## Runtime observations\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
  const target = reportPath(record); mkdirSync(dirname(target), { recursive: true });
  writeArtifact(target, markdown);
  const receipt = { ...report, artifact: record.stage.report_path, artifact_sha256: digest(markdown) };
  writeArtifact(join(record.package, 'runtime/runs', `${record.id}-decision.json`), receipt);
  return receipt;
}

export function decisionCompletion(record, { checkHead = false } = {}) {
  try {
    const receipt = JSON.parse(readFileSync(join(record.package, 'runtime/runs', `${record.id}-decision.json`), 'utf8'));
    if (receipt.run_id !== record.id || digest(readFileSync(reportPath(record), 'utf8')) !== receipt.artifact_sha256) throw new Error('Report is missing, changed, or belongs to another assignment');
    if (checkHead && (receipt.final_head !== git(record, 'rev-parse', 'HEAD') || (receipt.outcome === 'complete' && git(record, 'status', '--porcelain'))))
      throw new Error('Source changed after the stage report');
    return { status: 'recorded', outcome: receipt.outcome, artifact: receipt.artifact, commit: receipt.final_head,
      missing: [], acceptance: 'Stage assessment only; publication and other required reviews retain their existing obligations' };
  } catch (error) { return { status: 'handoff_incomplete', missing: [error.message] }; }
}
