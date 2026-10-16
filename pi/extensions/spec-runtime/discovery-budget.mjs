// Bound an editor's discovery between useful edits or an explicit owner answer.
// This is a scope checkpoint, never permission to omit evidence or change models.
const ASK = 'Otherwise use spec_question with the exact unresolved question, paths already checked, facts found, and the smallest proposed additional search. Await the owner answer in this session; do not restart, use another tool to continue discovery, or invent a decision.';
// A parallel packet has no owner channel, so its checkpoint ends the packet with the question.
const RETURN = 'Otherwise stop and give your final answer: the exact unresolved question, paths already checked and facts found. The owner will resend the packet; do not invent a decision.';

export function installDiscoveryBudget(pi, { limit = 24, maxMs = 180000, now = Date.now, report = () => {}, parallel = false } = {}) {
  let reads = 0, started = now(), awaitingDecision = false;
  const discovery = new Set(['read', 'grep', 'find', 'ls', 'bash']);
  const reset = () => { reads = 0; started = now(); awaitingDecision = false; };
  pi.on('tool_call', event => {
    if (!discovery.has(event.toolName)) return;
    if (awaitingDecision || reads >= limit || now() - started >= maxMs) {
      if (!awaitingDecision) report('editor_discovery_checkpoint', { calls: reads, elapsed_ms: now() - started });
      awaitingDecision = true;
      return { block: true, reason: `Discovery checkpoint reached. Apply the bounded edit if its contract is known. ${parallel ? RETURN : ASK}` };
    }
    reads++;
  });
  pi.on('tool_result', event => {
    if (!event.isError && ['edit', 'write', 'spec_question'].includes(event.toolName)) reset();
  });
  // Compaction drops the source the editor read, so re-reading its edit anchors is
  // recovery, not exploration. Without a fresh allowance, a compaction near the limit
  // blocked every re-read and forced an owner question (twice in one step).
  pi.on('session_compact', reset);
}
