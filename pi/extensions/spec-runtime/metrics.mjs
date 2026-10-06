// Native ESM resolves this symlinked extension to its source directory. Pi's TS
// loader resolves imports relative to the installed link, so keep that hop local.
export { metrics, formatMetrics } from '../../../scripts/spec-observe/metrics.mjs';
