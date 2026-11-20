// The studio <-> SculptGL (MIT) bridge. Wired into the assembled index.html by scripts/sculpt/assemble.mjs;
// it lives in the studio repository, never in the third-party tools folder. SculptGL sources are not modified.
//
// The page is opened by the studio: http://127.0.0.1:3211/sculpt/?studio=<studio origin>. Messages are accepted
// ONLY from that origin (it must be loopback) and only from the window that opened the page (the iframe parent
// or the opener). Protocol:
//   studio -> sculpt  {type:'load', url, name, id?}                load an OBJ/STL/PLY from the studio asset URL (the URL must be the studio origin)
//                   {type:'export', format:'obj'|'ply'|'stl', id?}
//                   {type:'status'}
//   sculpt -> studio {type:'ready', started, bridge, version, vertices, meshes, name, edits, loaded}  the page is up (also the answer to status; started=false while SculptGL boots)
//                   {type:'loaded', id, name, vertices, meshes}
//                   {type:'exported', id, format, name, bytes:ArrayBuffer, vertices, meshes}
//                   {type:'edited', edits}                         the scene has edits (undo-step counter)
//                   {type:'error', id, error}
// Coordinates: SculptGL normalizes size and centers the scene with the object matrix on load; on export the bridge
// removes that matrix, so vertices come back in the coordinate system they arrived from the studio.
(function () {
  'use strict';
  var BRIDGE = 1;
  var VERSION = 'SculptGL 0.9.0';
  var LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

  function studioOriginOf(raw) {
    try {
      var u = new URL(raw || 'http://127.0.0.1:3210');
      return /^https?:$/.test(u.protocol) && LOOPBACK.indexOf(u.hostname) >= 0 ? u.origin : null;
    } catch (e) { return null; }
  }
  var studioOrigin = studioOriginOf(new URLSearchParams(location.search).get('studio'));
  var peer = window.parent !== window ? window.parent : window.opener;

  var app = null, MeshClass = null, name = '', edits = 0, loaded = false;
  var norm = new WeakMap();   // mesh -> the SculptGL normalization matrix after load
  var defaultNorm = null;     // for meshes added inside SculptGL itself

  function post(msg, transfer) {
    if (!peer || !studioOrigin) return;
    try { peer.postMessage(msg, studioOrigin, transfer || []); } catch (e) { /* the studio window is gone */ }
  }
  function vertexCount() {
    var n = 0, meshes = app ? app.getMeshes() : [];
    for (var i = 0; i < meshes.length; i++) n += meshes[i].getNbVertices();
    return n;
  }
  function info() { return { started: !!app, bridge: BRIDGE, version: VERSION, vertices: vertexCount(), meshes: app ? app.getMeshes().length : 0, name: name, edits: edits, loaded: loaded }; }

  // 4x4, column-major (like gl-matrix)
  function mul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      var s = 0;
      for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function invert(m) {
    var a = [], i, j, k;
    for (i = 0; i < 4; i++) { a[i] = []; for (j = 0; j < 4; j++) a[i][j] = m[j * 4 + i]; for (j = 0; j < 4; j++) a[i][4 + j] = i === j ? 1 : 0; }
    for (i = 0; i < 4; i++) {
      var p = i;
      for (j = i + 1; j < 4; j++) if (Math.abs(a[j][i]) > Math.abs(a[p][i])) p = j;
      if (Math.abs(a[p][i]) < 1e-12) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      var t = a[i]; a[i] = a[p]; a[p] = t;
      var d = a[i][i];
      for (j = 0; j < 8; j++) a[i][j] /= d;
      for (j = 0; j < 4; j++) if (j !== i) { var f = a[j][i]; for (k = 0; k < 8; k++) a[j][k] -= f * a[i][k]; }
    }
    var o = new Array(16);
    for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) o[j * 4 + i] = a[i][4 + j];
    return o;
  }

  function fileKind(file, fallback) {
    var m = /\.(obj|stl|ply)(?:$|[?#])/i.exec(file || '');
    return m ? m[1].toLowerCase() : fallback;
  }

  async function load(msg) {
    var url = new URL(String(msg.url || ''), location.href);
    if (url.origin !== studioOrigin) throw new Error('The model URL must belong to the studio.');
    var kind = fileKind(msg.name, null) || fileKind(url.pathname, 'obj');
    var res = await fetch(url.href, { credentials: 'omit' });
    if (!res.ok) throw new Error('The studio did not return the model (' + res.status + ').');
    var data = kind === 'obj' ? await res.text() : await res.arrayBuffer();
    // SculptGL reorders vertices for the GPU cache; the original order must survive to put the shape back on the source mesh
    MeshClass.OPTIMIZE = false;
    app._autoMatrix = true;
    app.clearScene();
    var meshes = app.loadScene(data, kind);
    if (!meshes || !meshes.length) throw new Error('The file has no geometry.');
    meshes.forEach(function (m) { norm.set(m, Array.prototype.slice.call(m.getMatrix())); });
    defaultNorm = norm.get(meshes[0]);
    name = String(msg.name || 'model.' + kind).replace(/\.[^.]*$/, '');
    edits = 0;
    loaded = true;
    app.render();
    return info();
  }

  // Export through the same code as the "File" menu buttons: saving is intercepted so the Blob is captured instead of downloaded.
  async function exportScene(format) {
    var meshes = app.getMeshes();
    if (!meshes.length) throw new Error('The SculptGL scene has no models.');
    var files = app.getGui()._ctrlFiles;
    var call = { obj: 'saveFileAsOBJ', ply: 'saveFileAsPLY', stl: 'saveFileAsSTL' }[format];
    if (!call) throw new Error('Export format: obj, ply or stl.');
    var saved = [], blob = null, order = meshes.slice();
    var oldSave = files._save, oldAll = files._exportAll, oldZ = files._objColorZbrush, oldA = files._objColorAppended;
    // SculptGL re-sorts meshes by depth on every draw; restore the load order (ids grow in file order)
    meshes.sort(function (a, b) { return a.getID() - b.getID(); });
    files._save = function (data) { blob = data; };
    meshes.forEach(function (m, i) {
      var mat = m.getMatrix();
      saved[i] = Array.prototype.slice.call(mat);
      mat.set(mul(invert(norm.get(m) || defaultNorm || saved[i]), saved[i]));
    });
    files._exportAll = true; files._objColorZbrush = false; files._objColorAppended = false;
    try { files[call](); } finally {
      files._save = oldSave; files._exportAll = oldAll; files._objColorZbrush = oldZ; files._objColorAppended = oldA;
      meshes.forEach(function (m, i) { m.getMatrix().set(saved[i]); });
      order.forEach(function (m, i) { meshes[i] = m; });
    }
    if (!blob) throw new Error('SculptGL returned no file.');
    var bytes = await blob.arrayBuffer();
    return { format: format, name: (name || 'sculpt') + '-sculpt.' + format, bytes: bytes, vertices: vertexCount(), meshes: meshes.length };
  }

  var editTimer = 0;
  function watchEdits() {
    var sm = app._stateManager, push = sm.pushState;
    sm.pushState = function () {
      var r = push.apply(this, arguments);
      edits++;
      if (!editTimer) editTimer = setTimeout(function () { editTimer = 0; if (edits > 0) post({ type: 'edited', edits: edits }); }, 250);
      return r;
    };
  }

  async function onMessage(e) {
    if (!studioOrigin || e.origin !== studioOrigin || e.source !== peer) return;
    var msg = e.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    var id = msg.id;
    try {
      if (msg.type === 'status') post(Object.assign({ type: 'ready' }, info()));
      else if (msg.type === 'load') { var r = await load(msg); post({ type: 'loaded', id: id, name: name, vertices: r.vertices, meshes: r.meshes }); }
      else if (msg.type === 'export') { var x = await exportScene(String(msg.format || 'obj')); post({ type: 'exported', id: id, format: x.format, name: x.name, bytes: x.bytes, vertices: x.vertices, meshes: x.meshes }, [x.bytes]); }
    } catch (err) { post({ type: 'error', id: id, error: err && err.message ? err.message : String(err) }); }
  }

  window.addEventListener('message', onMessage);
  window.addEventListener('load', function () {
    app = window.sculptApp;
    if (!app || !app._gl || !app.getMeshes().length) { post({ type: 'error', error: 'SculptGL did not start: WebGL is required.' }); return; }
    MeshClass = Object.getPrototypeOf(app.getMeshes()[0].constructor);   // Multimesh -> Mesh: its static OPTIMIZE flag
    MeshClass.OPTIMIZE = false;
    watchEdits();
    post(Object.assign({ type: 'ready' }, info()));
  });
  window.imaginariumSculptBridge = { info: info, exportScene: exportScene, load: load };
})();
