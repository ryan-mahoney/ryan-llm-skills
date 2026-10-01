// The only place the journey rating thresholds and rules are written (R10, INV-3).
// The rubric, prompts and decks cite this file and state no threshold number.

/**
 * Band edges per metric. Efficiency is a ratio where more is better, so `direct`
 * and `detours` are inclusive lower bounds; the count metrics are lower-is-better,
 * so `direct` and `detours` are inclusive upper bounds. Anything outside the last
 * edge is `lost`.
 */
export const BANDS = {
  efficiency: { direct: 0.8, detours: 0.5 },
  backtracks: { direct: 1, detours: 3 },
  errors: { direct: 0, detours: 2 },
  entryActions: { direct: 2, detours: 5 },
};

export const ATTRIBUTIONS = ["product", "tester", "harness"];

const RATED_ORDER = ["direct", "detours", "lost"];

/**
 * Band one proxy value.
 *
 * `efficiency` takes either the ratio itself or `{actions, referenceActions}`;
 * an object with `actions` 0 is lost because no path can be efficient without
 * actions. `errors` takes `{total, endedInError}`. `entryActions` takes a number,
 * or null when the entry route was never reached, which is lost.
 */
export function bandOf(metric, value) {
  const edges = BANDS[metric];
  if (!edges) {
    throw new Error(`rating: unknown metric "${metric}"`);
  }

  if (metric === "efficiency") {
    const ratio =
      typeof value === "number"
        ? value
        : value && value.actions > 0
          ? value.referenceActions / value.actions
          : null;
    if (ratio === null) return "lost";
    return ratio >= edges.direct ? "direct" : ratio >= edges.detours ? "detours" : "lost";
  }

  if (metric === "errors") {
    const total = value && value.total;
    if (value && value.endedInError) return "lost";
    return total <= edges.direct ? "direct" : total <= edges.detours ? "detours" : "lost";
  }

  if (metric === "entryActions") {
    if (value === null || value === undefined) return "lost";
    return value <= edges.direct ? "direct" : value <= edges.detours ? "detours" : "lost";
  }

  return value <= edges.direct ? "direct" : value <= edges.detours ? "detours" : "lost";
}

const QUESTIONS = ["q1", "q2", "q3", "q4"];

/**
 * The lowest reviewer question score over every scored value, or null when the
 * review scored nothing. A null question is not scored and is never 0.
 */
export function stepMinimum(reviewSteps) {
  const scored = (reviewSteps ?? [])
    .flatMap((step) => QUESTIONS.map((question) => step[question]))
    .filter((value) => value !== null && value !== undefined);
  return scored.length === 0 ? null : Math.min(...scored);
}

/**
 * Rate one run from raw numbers.
 *
 * `proxies` is the object of result.json (C-6). Returns the rating, the band of
 * each metric and the attribution (null unless the run is `Not completed`).
 */
export function rate({ status, checkPass, proxies, referenceActions, stepMinimum: minimum, attribution } = {}) {
  const bands = {
    efficiency: bandOf("efficiency", { actions: proxies?.actions, referenceActions }),
    backtracks: bandOf("backtracks", proxies?.backtracks),
    errors: bandOf("errors", { total: proxies?.errorsSeen?.total, endedInError: proxies?.endedInError }),
    entryActions: bandOf("entryActions", proxies?.actionsToEntryRoute),
  };

  if (status === "harness-error" || checkPass === null || checkPass === undefined) {
    return { rating: "Not rated", bands, attribution: null };
  }

  if (checkPass === false) {
    if (!ATTRIBUTIONS.includes(attribution)) {
      throw new Error(`rating: a not-completed run needs attribution one of ${ATTRIBUTIONS.join(", ")}`);
    }
    return { rating: "Not completed", bands, attribution };
  }

  const worst = RATED_ORDER.filter((band) => Object.values(bands).includes(band)).pop();
  if (worst === "lost") return { rating: "Lost", bands, attribution: null };
  if (worst === "detours" || minimum === 0) return { rating: "Detours", bands, attribution: null };
  return { rating: "Direct", bands, attribution: null };
}

const stepsByNumber = (review) => new Map((review?.steps ?? []).map((step) => [step.n, step]));

/**
 * Reviewer repeatability over q1-q4 of the steps present in both reviews: how
 * many compared questions match exactly, and how many are within one point.
 */
export function agreement(reviewA, reviewB) {
  const a = stepsByNumber(reviewA);
  const b = stepsByNumber(reviewB);
  let n = 0;
  let exact = 0;
  let withinOne = 0;

  for (const [number, stepA] of a) {
    const stepB = b.get(number);
    if (!stepB) continue;
    for (const question of QUESTIONS) {
      const left = stepA[question];
      const right = stepB[question];
      if (left === null || left === undefined || right === null || right === undefined) continue;
      n += 1;
      const difference = Math.abs(left - right);
      if (difference === 0) exact += 1;
      if (difference <= 1) withinOne += 1;
    }
  }

  return { n, exact, withinOne };
}