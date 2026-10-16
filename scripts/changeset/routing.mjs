// Consume the existing Jev prepared-step recommendation contract. The planner
// owns the floor; uncertainty never downgrades an executor or waives verification.
export function routeWithAdvice(plan, advice) {
  const routed = structuredClone(plan), decisions = [];
  for (const op of routed.operations) {
    const recommendation = advice?.recommendation?.steps?.find(s => s.id === op.id);
    const assessment = advice?.assessment?.find(s => s.id === op.id);
    const usable = recommendation?.source === 'advisory_with_planner_floor' && assessment?.uncertainty?.length === 0;
    if (op.executor === 'simple' && usable && recommendation.difficulty === 'hard') {
      op.executor = 'involved'; decisions.push({ id: op.id, from: 'simple', to: 'involved', reason: 'jev-raised-difficulty' });
    }
  }
  return { plan: routed, decisions, advice_status: advice?.status ?? 'not-supplied' };
}
