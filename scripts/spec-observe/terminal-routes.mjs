// Local dashboard routes for the identity-bound terminal stream owner.
//
// `POST /api/assignment-terminal/open` starts or shares a stream for a
// verified assignment; `GET|HEAD /api/assignment-terminal/<uuid>/<asset>`
// proxies a player asset from an already-ready entry. The routes share the
// operator dashboard's Origin + action-token boundary, but take the strict
// locality rule used by the completion route: the configured public host and
// forwarding headers never authorize a terminal action or asset.
//
// Failures cross HTTP only as fixed status/state/reason mappings; the stream
// owner's error message and any attached child diagnostics never do.

const OPEN_PATH = "/api/assignment-terminal/open";
const ASSET_PATH = /^\/api\/assignment-terminal\/([^/]+)\/([^/]+)$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Fixed browser-safe failures keyed by the stream owner's state code. An
// unrecognized shape is reported as the generic `failed` state, never with the
// owner's message.
const OPEN_FAILURES = new Map([
  ["not-live", { status: 404, error: "The assignment terminal is not live." }],
  ["changed", { status: 409, error: "The assignment terminal identity changed. Reconcile it before viewing." }],
  ["not-installed", { status: 503, error: "asciinema is not installed on the dashboard host." }],
  ["busy", { status: 503, error: "Terminal streams are unavailable. Try again shortly." }],
  ["failed", { status: 503, error: "The terminal stream could not be started." }],
]);

function openFailure(error) {
  const state = OPEN_FAILURES.has(error?.state) ? error.state : "failed";
  const failure = OPEN_FAILURES.get(state);
  return { status: failure.status, state, error: failure.error };
}

/**
 * Route one dashboard request to the terminal stream owner.
 *
 * The returned handler keeps the `createSessionRoutes` contract: it claims
 * only its own paths, reports each refusal itself and returns `true` when it
 * has answered. A request classified as remote is refused before anything
 * else, assets are delegated only after that locality check, and the open
 * action additionally requires the exact expected Origin, the dashboard
 * action token, an exact `application/json` content type and a bounded JSON
 * body containing a UUID `assignment_id`.
 *
 * @param {object} options
 * @param {object} options.terminals `createTerminalViews` owner
 * @param {string} options.actionToken per-server dashboard action token
 * @returns {(request: object, response: object, url: URL,
 *   context: {remote: boolean, expectedOrigin: string}) => Promise<boolean>}
 */
export function createTerminalRoutes({ terminals, actionToken }) {
  return async (request, response, url, { remote, expectedOrigin }) => {
    const open = url.pathname === OPEN_PATH;
    const asset = open ? null : ASSET_PATH.exec(url.pathname);
    if (!open && asset === null) return false;
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (remote) {
      send(403, { error: "Terminal access requires the local dashboard." });
      return true;
    }
    if (!open) {
      terminals.handleAsset(request, response, asset[1], asset[2]);
      return true;
    }
    if (request.method !== "POST") {
      send(405, { error: "Use POST." });
      return true;
    }
    if (request.headers.origin !== expectedOrigin
      || request.headers["x-sentinel-token"] !== actionToken
      || request.headers["content-type"] !== "application/json") {
      send(403, { error: "Terminal actions require the same-origin local dashboard and its action token." });
      return true;
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 4096) {
        send(413, { error: "Request is too large." });
        return true;
      }
      chunks.push(chunk);
    }
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      send(400, { error: "Invalid JSON request." });
      return true;
    }
    if (typeof input?.assignment_id !== "string" || !UUID_PATTERN.test(input.assignment_id)) {
      send(400, { error: "Assignment ID must be a UUID." });
      return true;
    }
    try {
      send(200, await terminals.open(input.assignment_id));
    } catch (error) {
      const failure = openFailure(error);
      send(failure.status, { state: failure.state, error: failure.error });
    }
    return true;
  };
}
