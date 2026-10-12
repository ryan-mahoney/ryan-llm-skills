// Operator-only package preview controls. Package authorization is supplied by
// the dashboard and must complete before any runtime operation.
const PATH = '/api/package-preview';
const BODY_LIMIT = 8192;
const ERRORS = {
  400: 'Package preview request is invalid.',
  403: 'Package preview requires an authorized dashboard endpoint.',
  405: 'Method not allowed.',
  409: 'Package preview conflicts with current state.',
  413: 'Package preview request body is too large.',
  503: 'Package preview service unavailable.',
};

function send(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}
const fail = (response, status, headers) => send(response, status, { error: ERRORS[status] }, headers);

export function createPackagePreviewRoutes({ previewService, actionToken, authorize } = {}) {
  return async (request, response, url, { remote, expectedOrigin } = {}) => {
    if (url.pathname !== PATH) return false;
    if (remote === true) { fail(response, 403); return true; }
    if (!['GET', 'POST'].includes(request.method)) {
      fail(response, 405, { Allow: 'GET, POST' }); return true;
    }
    try {
      let requested, action;
      if (request.method === 'POST') {
        if (request.headers.origin !== expectedOrigin
          || typeof actionToken !== 'string' || request.headers['x-sentinel-token'] !== actionToken
          || request.headers['content-type'] !== 'application/json') {
          fail(response, 403); return true;
        }
        const length = request.headers['content-length'];
        if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) {
          fail(response, 400); return true;
        }
        if (Number(length) > BODY_LIMIT) { fail(response, 413); return true; }
        let bytes = 0; const chunks = [];
        for await (const chunk of request) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > BODY_LIMIT) { fail(response, 413); return true; }
          chunks.push(Buffer.from(chunk));
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { fail(response, 400); return true; }
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || !['start', 'stop'].includes(input.action)) { fail(response, 400); return true; }
        requested = input.package; action = input.action;
      } else {
        requested = url.searchParams.get('package'); action = 'status';
      }
      let target;
      try { target = await authorize(requested); }
      catch { fail(response, 403); return true; }
      const result = await previewService[action](target);
      send(response, request.method === 'POST' ? 202 : 200, result);
    } catch (error) {
      // Service status is typed. Never return exception messages or Compose output.
      fail(response, [400, 409, 503].includes(error?.status) ? error.status : 503);
    }
    return true;
  };
}
