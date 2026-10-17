// Frozen public metadata for a selected model missing from the installed Pi catalog.
// Source: https://openrouter.ai/api/v1/models, observed 2026-10-16.
// Only this study runtime is extended; global configuration and credentials are untouched.
export const nemotron = Object.freeze({
  id: 'nvidia/nemotron-3.5-super-vl', name: 'NVIDIA: Nemotron 3.5 Super VL',
  api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: true, input: ['text', 'image'],
  // Use the advertised top-provider context ceiling rather than the broader catalog ceiling.
  contextWindow: 262144, maxTokens: 235929,
  cost: { input: 0.15, output: 0.5, cacheRead: 0.02, cacheWrite: 0 },
});

export async function registerStudyModel(runtime, selector) {
  if (selector?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, '') !== `openrouter/${nemotron.id}`) return;
  runtime.registerProvider('openrouter', { models: [nemotron] });
  await runtime.refresh({ allowNetwork: false, providers: ['openrouter'] });
}
