// The existing native scout and Client retain transcripts, accounting and deadlines.
export async function retryPlanningJson(scout, input, { parseJson }) {
  const response = await scout.prompt(JSON.stringify(input));
  try { return parseJson(response); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const retry = await scout.prompt(JSON.stringify({ planning_format_error: error.message,
      previous_response_excerpt: response.slice(0, 12000),
      instruction: 'Return the complete executable changeset plan as JSON only, without commentary. Correct only response format. Preserve the entire original task and source facts from this planning session. This is the sole JSON-format retry for this planning attempt.' }));
    return parseJson(retry);
  }
}
