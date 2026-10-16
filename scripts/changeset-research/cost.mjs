// User-selected economic comparison: Sol is subscription-backed, so price its
// token usage at the observed native DeepSeek tariff. Preserve original receipts.
export const costPolicy = Object.freeze({
  id: 'sol-at-deepseek-rates', observed_on: '2026-10-16',
  reference: 'deepseek/deepseek-flash',
  usd_per_million_tokens: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
  note: 'Comparison estimate only; subscription charges and quota are not measured.',
});
export function equivalentCost(receipts) {
  if (!Array.isArray(receipts) || !receipts.length) return null;
  let total = 0;
  for (const receipt of receipts) {
    const usage = receipt.usage;
    if (!usage) return null;
    if (/^(openai|openai-codex)\/gpt-6\.1-sol(?::|$)/.test(receipt.selector)) {
      if (!['input','output','cacheRead','cacheWrite'].some(key => usage[key] > 0)) return null;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const count = usage[key];
        if (!Number.isFinite(count) || count < 0) return null;
        total += count * costPolicy.usd_per_million_tokens[key] / 1e6;
      }
    } else {
      if (!Number.isFinite(usage.cost?.total) || usage.cost.total <= 0) return null;
      total += usage.cost.total;
    }
  }
  return total;
}
