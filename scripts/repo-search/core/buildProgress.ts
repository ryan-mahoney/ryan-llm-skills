// Small reusable build phase/progress contracts. Progress is optional and
// bounded: callers receive phase changes, completion, and coarse embedding
// counts rather than unbounded per-chunk chatter.

export type BuildPhase =
  | "planning"
  | "restoring"
  | "chunking"
  | "embedding"
  | "persisting"
  | "validating"
  | "done";

export type BuildProgressEvent =
  | { type: "phase"; phase: BuildPhase }
  | { type: "complete"; phase: BuildPhase; count?: number }
  | { type: "embedded"; embedded: number; cached: number };

export type BuildProgressReporter = (event: BuildProgressEvent) => void;

export const NOOP_BUILD_PROGRESS: BuildProgressReporter = () => {};

/**
 * Wraps a sink so `embedded` events are emitted at most once per `interval`
 * embedded chunks. Phase/complete events are always forwarded.
 */
export function createBoundedBuildReporter(
  sink: BuildProgressReporter,
  interval = 25,
): BuildProgressReporter {
  let lastEmbedded = 0;
  return (event) => {
    if (event.type === "embedded") {
      if (event.embedded !== 0 && event.embedded - lastEmbedded < interval) return;
      lastEmbedded = event.embedded;
    }
    sink(event);
  };
}
