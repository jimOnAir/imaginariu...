// The Sculpt tab: SculptGL (MIT) right above the model in the scene.
//
//   GET  /api/sculpt/status   -> {available, url, webError?, hint?}; url - the sculpt page on the web port
//                                (ASTRA_VFX_WEB_PORT, 3211), NOT the studio origin
//   GET  http://127.0.0.1:<webPort>/sculpt/        the SculptGL page served from <ASTRA_VFX_TOOLS>/web/sculptgl
//                                (the route lives in server/vfx-tools.mjs next to the web generators)
//   GET  /api/assets/:id       with Access-Control-Allow-Origin for the sculpt origin only - GET/HEAD only
//
// The third-party SculptGL JS runs on another origin and cannot reach the studio API: index.mjs rejects foreign Origins.
// The one exception is reading an asset by id (a UUID, not guessable): that is how the sculpt page downloads the OBJ
// the studio put into assets. Results come back through postMessage (scripts/sculpt/bridge.js); the studio loads the
// returned mesh as a new asset itself.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolveInside } from './vfx-tools.mjs';

export const SCULPT_DIR = 'web/sculptgl';
/** A studio asset: GET /api/assets/<uuid>. The only API path the sculpt page may read. */
export const ASSET_PATH = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sculpt page origin for a web-server port (null until the server is up). */
export const sculptOrigin = (port) => (port ? `http://127.0.0.1:${port}` : null);

/**
 * Allows the sculpt page to read an asset: when the request is GET/HEAD /api/assets/<uuid> exactly from the sculpt
 * origin, sets the CORS headers and returns true. Anything else (other origin, other path, writes) returns false.
 */
export function allowAssetCors(req, res, origin) {
  if (!origin || !['GET', 'HEAD'].includes(req.method) || !ASSET_PATH.test(req.path) || req.headers.origin !== origin) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  return true;
}

export function registerSculpt(app, asyncRoute, { vfx }) {
  const origin = () => sculptOrigin(vfx.webPort);
  const installed = () => fs.stat(path.join(resolveInside(vfx.root, SCULPT_DIR), 'index.html')).then((s) => s.isFile(), () => false);

  app.get('/api/sculpt/status', asyncRoute(async (req, res) => {
    await vfx.startWeb();
    const has = await installed();
    const url = origin() && has ? origin() + '/sculpt/' : null;
    const status = { available: !!url, url, bridge: 1 };
    if (!has) status.hint = 'SculptGL is not built. Run scripts/vfx/install-vfx.sh -Only sculptgl (needs Node.js).';
    else if (!origin()) status.hint = vfx.webError || 'The sculpt web server is not running.';
    if (vfx.webError) status.webError = vfx.webError;
    res.json(status);
  }));

  return { origin, installed, assetCors: (req, res) => allowAssetCors(req, res, origin()) };
}
