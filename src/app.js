import { W as TW, H as TH, PARTS, FACE_ORDER, regionsFor as templateRegions, regionAt as templateRegionAt, boundsOf, EDGES, acrossSeam, seamMatrix, faceAt, ALL_FACES, MIRROR_FACES, FACES } from './template.js';
import { CHANGELOG } from './changelog.js';
import { createPreview } from './preview.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const native = window.native || null;

// W x H is the size of the project on screen: 585 x 559 for templates, anything for a normal canvas (see applySize)
let W = TW, H = TH;
const isTemplate = () => state.mode !== 'canvas';
const regionsFor = (mode) => mode === 'canvas' ? [{ id: 'all', label: 'Whole canvas', group: null, rects: [[0, 0, W, H]] }] : templateRegions(mode);
const regionAt = (x, y, mode) => mode === 'canvas' ? null : templateRegionAt(x, y, mode);

// ------------------------------------------------------------------ documents & layers
function mkCanvas(w = W, h = H) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const ctxOf = (c) => c.getContext('2d', { willReadFrequently: true });

let idCounter = 0;
function makeLayer(name, w = W, h = H) {
  const canvas = mkCanvas(w, h);
  return { id: 'l' + (++idCounter), name, kind: 'Layer', locked: false, canvas, ctx: ctxOf(canvas), visible: true, opacity: 1, blend: 'source-over' };
}
function newDoc(kind, w = W, h = H) {
  const l = makeLayer('Layer 1', w, h);
  return { kind, layers: [l], activeId: l.id, undo: [], redo: [], comp: mkCanvas(w, h), counter: 1 };
}

const state = {
  mode: 'shirt',
  docs: { shirt: newDoc('shirt'), pants: newDoc('pants') },
  tool: 'brush', fg: '#d23c3c', bg: '#ffffff',
  size: 6, opacity: 1, hardEraser: false, fillShape: false, tolerance: 24, sampleAll: false, gradTransparent: false,
  font: 'Arial', fontSize: 24, bold: false,
  region: 'all', underlay: true, guides: true, shade: false, seams: false, zoom: 1, recent: [],
};
const doc = () => state.docs[state.mode];
const activeLayer = () => doc().layers.find(l => l.id === doc().activeId) || doc().layers[doc().layers.length - 1];
const currentRegion = () => regionsFor(state.mode).find(r => r.id === state.region) || regionsFor(state.mode)[0];

// ------------------------------------------------------------------ view setup
const view = $('#view'), vctx = view.getContext('2d');
const overlay = $('#overlay'), octx = overlay.getContext('2d');
let OS = 2; // overlay scale: template px → device px (zoom × devicePixelRatio), set every draw
const dpx = (n) => n * (window.devicePixelRatio || 1) / OS; // n screen pixels, in template units
const stack = $('#stack'), scroller = $('#scroller');
// side by side: the template part not being edited shows next to the canvas; clicking it switches to it
const otherView = $('#otherView'), ovx = otherView.getContext('2d');
let pairPref = false; try { pairPref = localStorage.getItem('stitch-pair') === '1'; } catch { /* storage unavailable */ }
const pairOn = () => pairPref && isTemplate();
const preview = createPreview($('#preview'));
const templateImg = new Image(); templateImg.src = 'default-template.png'; templateImg.onload = () => requestRender();
const templateReady = () => templateImg.complete && templateImg.naturalWidth > 0;

const grpC = mkCanvas(), grpX = grpC.getContext('2d');
// ---- layer masks: l.mask is a grey picture the size of the layer. White shows the layer, black hides it,
// grey partly hides it, and anything never painted counts as white. l.maskOff turns it off without deleting it.
function maskAlpha(l) { // the mask as an alpha channel, rebuilt only after the mask changes
  const m = l.mask;
  if (!l._ma || l._ma.width !== m.width || l._ma.height !== m.height) { l._ma = mkCanvas(m.width, m.height); l._maDirty = true; }
  if (l._maDirty !== false) {
    const id = m.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, m.width, m.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; d[i + 3] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) * a / 65280 + 255 - a; d[i] = d[i + 1] = d[i + 2] = 0; }
    l._ma.getContext('2d').putImageData(id, 0, 0); l._maDirty = false;
  }
  return l._ma;
}
// ---- mirror: while a layer's l.mirror is on, what is painted on it is painted again where it would sit on the other
// side of the body (arm to arm, leg to leg, one half of the torso onto the other); on a normal canvas, flipped across
// the middle. Only new strokes and paths are mirrored, and they stay mirrored after it is turned off.
// the mirror map of the face under (x, y), or null off the template's faces. Path handles use their anchor's map
// so a curve keeps its shape even where a handle pokes over the face edge.
function mirrorXf(x, y) {
  if (!isTemplate()) return (q) => ({ x: W - q.x, y: q.y });
  const i = ALL_FACES.indexOf(faceAt(x, y)); if (i < 0) return null;
  const { from: [fx, fy], to: [tx, ty, tw] } = MIRROR_FACES[i];
  return (q) => ({ x: tx + tw - (q.x - fx), y: ty + (q.y - fy) });
}
const mirroring = () => !!(op && (op.maskOf || op.real || op.l))?.mirror; // the layer being painted has Mirror on
// a path's twin on the other side (null if none of its points are on a face)
function mirrorSub(sp) {
  const home = sp.pts.map(q => mirrorXf(q.x, q.y)).find(Boolean); if (!home) return null;
  return { closed: sp.closed, pts: sp.pts.map(q => { const f = mirrorXf(q.x, q.y) || home; return { ...f(q), hin: q.hin && f(q.hin), hout: q.hout && f(q.hout) }; }) };
}
let maskScratch = null;
// what a layer adds to the picture: its pixels, cut by its mask (the result is only good until the next call)
function layerSource(l) {
  if (!l.mask || l.maskOff) return l.canvas;
  const w = l.canvas.width, h = l.canvas.height;
  if (!maskScratch || maskScratch.width !== w || maskScratch.height !== h) maskScratch = mkCanvas(w, h);
  const x = maskScratch.getContext('2d'); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.clearRect(0, 0, w, h);
  x.drawImage(l.canvas, 0, 0); x.globalCompositeOperation = 'destination-in'; x.drawImage(maskAlpha(l), 0, 0); x.globalCompositeOperation = 'source-over';
  return maskScratch;
}
function newMask(w, h, fill = '#fff') { const c = mkCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = fill; x.fillRect(0, 0, w, h); return c; }
const maskEditing = (l, d = doc()) => !!l?.mask && d.maskEdit === l.id && !d.noSel;
// draws a list of layers onto ctx c; layers in a group are flattened on their own first, so blend modes
// like "clip to below" or "erase" inside a group only affect the rest of that group
function compositeLayers(c, layers, groups) {
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  for (let i = 0; i < layers.length;) {
    const l = layers[i], gid = l.group, g = gid ? (groups || []).find(x => x.id === gid) : null;
    if (g) {
      let j = i; while (j < layers.length && layers[j].group === gid) j++;
      if (g.visible !== false && (g.opacity ?? 1) > 0) {
        const tc = mkCanvas(c.canvas.width, c.canvas.height), tx = tc.getContext('2d');
        for (let k = i; k < j; k++) { const m = layers[k]; if (!m.visible || m.opacity <= 0) continue; tx.globalAlpha = m.opacity; tx.globalCompositeOperation = m.blend; tx.drawImage(layerSource(m), 0, 0); }
        c.globalAlpha = g.opacity ?? 1; c.globalCompositeOperation = 'source-over'; c.drawImage(tc, 0, 0);
      }
      i = j; continue;
    }
    if (l.visible && l.opacity > 0) { c.globalAlpha = l.opacity; c.globalCompositeOperation = l.blend; c.drawImage(layerSource(l), 0, 0); }
    i++;
  }
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
}
function compositeDoc(d) {
  const c = d.comp.getContext('2d'); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, d.comp.width, d.comp.height);
  compositeLayers(c, d.layers, d.groups);
}

let renderQueued = false;
function requestRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } }
function render() {
  renderQueued = false;
  for (const o of [op, adjOp]) if (o?.maskOf) o.maskOf._maDirty = true; // a mask is being painted
  const tpl = isTemplate();
  if (tpl) { compositeDoc(state.docs.shirt); compositeDoc(state.docs.pants); } else compositeDoc(doc());
  vctx.clearRect(0, 0, W, H);
  vctx.drawImage(doc().comp, 0, 0);
  if (tpl && state.underlay && templateReady()) vctx.drawImage(templateImg, 0, 0, W, H); // same as export
  if (pairOn()) {
    const other = state.docs[state.mode === 'shirt' ? 'pants' : 'shirt'];
    if (otherView.width !== W || otherView.height !== H) { otherView.width = W; otherView.height = H; }
    ovx.clearRect(0, 0, W, H); ovx.drawImage(other.comp, 0, 0);
    if (state.underlay && templateReady()) ovx.drawImage(templateImg, 0, 0, W, H);
  }
  drawOverlay();
  if (tpl && preview) preview.update(state.docs.shirt.comp, state.docs.pants.comp);
  updateThumbs();
}

let hover = null;
function drawOverlay() {
  const o = octx, dpr = window.devicePixelRatio || 1;
  // the overlay covers the visible canvas area at screen resolution, so outlines stay 1px sharp at any zoom
  // ...minus the scrollbars, so outlines and shading never cover them
  overlay.style.width = scroller.clientWidth + 'px'; overlay.style.height = scroller.clientHeight + 'px';
  const orc = overlay.getBoundingClientRect(), wDev = Math.max(1, Math.round(orc.width * dpr)), hDev = Math.max(1, Math.round(orc.height * dpr));
  if (overlay.width !== wDev || overlay.height !== hDev) { overlay.width = wDev; overlay.height = hDev; }
  o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, overlay.width, overlay.height);
  const vr = view.getBoundingClientRect(); OS = vr.width / W * dpr;
  o.setTransform(OS, 0, 0, OS, Math.round((vr.left - orc.left) * dpr) + .5, Math.round((vr.top - orc.top) * dpr) + .5);
  const regs = regionsFor(state.mode), faces = regs.filter(r => r.face);
  if (state.shade && faces.length) {
    o.fillStyle = 'rgba(12,14,20,.6)'; o.beginPath(); o.rect(0, 0, W, H);
    for (const f of faces) o.rect(...f.rects[0]);
    o.fill('evenodd');
  }
  if (state.guides && faces.length) {
    o.lineWidth = 1 / OS; o.setLineDash([dpx(4), dpx(3)]); o.strokeStyle = 'rgba(0,170,225,.85)';
    for (const f of faces) { const [x, y, w, h] = f.rects[0]; o.strokeRect(x, y, w, h); } // exactly on the template's face borders
    o.setLineDash([]);
    const fs = Math.min(dpx(10), 7 * 1.6), fs2 = Math.min(dpx(11), 8 * 1.6);
    o.font = `600 ${fs}px Segoe UI, sans-serif`; o.fillStyle = 'rgba(120,215,255,.95)';
    o.strokeStyle = 'rgba(10,20,40,.85)'; o.lineWidth = fs * .28; o.lineJoin = 'round';
    const lbl = (t, x, y) => { o.strokeText(t, x, y); o.fillText(t, x, y); };
    for (const f of faces) { const [x, y] = f.rects[0]; lbl(f.short.toUpperCase(), x + fs * .4, y + fs * 1.25); }
    o.font = `700 ${fs2}px Segoe UI, sans-serif`;
    const limb = state.mode === 'pants' ? 'LEG' : 'ARM';
    lbl('TORSO', 168, 20); lbl('RIGHT ' + limb, 22, 300); lbl('LEFT ' + limb, 377, 300);
  }
  const cur = currentRegion();
  if (cur.id !== 'all') {
    o.lineWidth = dpx(1.5); o.strokeStyle = '#ffb84d';
    for (const r of cur.rects) o.strokeRect(r[0] + .75, r[1] + .75, r[2] - 1.5, r[3] - 1.5);
  }
  drawToolOverlay(o);
}

// ------------------------------------------------------------------ zoom & pan
function setZoom(z, anchor) {
  z = Math.min(12, Math.max(0.25, z));
  let before;
  if (anchor) { const r = stack.getBoundingClientRect(); before = { x: (anchor.x - r.left) / state.zoom, y: (anchor.y - r.top) / state.zoom }; }
  state.zoom = z;
  stack.style.width = W * z + 'px'; stack.style.height = H * z + 'px';
  otherView.style.width = W * z + 'px'; otherView.style.height = H * z + 'px';
  view.classList.toggle('pixelated', z >= 2); otherView.classList.toggle('pixelated', z >= 2);
  $('#zoomVal').textContent = Math.round(z * 100) + '%';
  requestAnimationFrame(() => drawOverlay());
  if (typeof updateTextEditor === 'function') try { updateTextEditor(); } catch { /* not ready */ }
  if (anchor && before) {
    const r = stack.getBoundingClientRect();
    scroller.scrollLeft += (r.left + before.x * z) - anchor.x;
    scroller.scrollTop += (r.top + before.y * z) - anchor.y;
  }
}
function zoomFit() {
  const r = scroller.getBoundingClientRect();
  const two = pairOn(); // side by side: both parts and the gap between them have to fit
  setZoom(Math.max(0.25, Math.min((r.width - 48 - (two ? 28 : 0)) / (two ? 2 * W : W), (r.height - 48) / H)));
}
$('#zoomIn').onclick = () => setZoom(state.zoom * 1.25);
$('#zoomOut').onclick = () => setZoom(state.zoom / 1.25);
$('#zoomFit').onclick = zoomFit;
$('#zoom100').onclick = () => setZoom(1);
scroller.addEventListener('scroll', () => drawOverlay());
window.addEventListener('resize', () => requestAnimationFrame(() => drawOverlay()));
// wheel zooms at the pointer like Pixlr (Ctrl+wheel too, which is also a touchpad pinch). Shift+wheel scrolls sideways,
// Alt+wheel scrolls up/down, and a sideways touchpad swipe scrolls normally
scroller.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  if (e.shiftKey) { scroller.scrollLeft += dy; return; }
  if (e.altKey) { scroller.scrollTop += dy; return; }
  // one mouse notch (100) = 15%; touchpads send small steps and zoom smoothly
  setZoom(state.zoom * Math.pow(1.15, -Math.max(-300, Math.min(300, dy)) / 100), { x: e.clientX, y: e.clientY });
}, { passive: false });

// ------------------------------------------------------------------ history
// every undo step keeps full-size snapshots, so big canvases keep fewer steps (60 for templates, about 24 at 1920 x 1080)
const maxHistory = () => Math.max(10, Math.min(60, Math.floor(400e6 / (W * H * 8))));
const TOOL_LABELS = { pen: 'Path', shape: 'Shape', select: 'Select', lasso: 'Lasso', wand: 'Magic select', brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser', fill: 'Fill', gradient: 'Gradient', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', text: 'Text', move: 'Move' };
let histLabel = null;
function labelled(label, fn) { const prev = histLabel; histLabel = label; try { return fn(); } finally { histLabel = prev; } }
function pushHistory(entry) {
  const d = doc(); editVersion++; entry.label = entry.label || histLabel || TOOL_LABELS[state.tool] || 'Edit'; d.undo.push(entry);
  while (d.undo.length > maxHistory()) d.undo.shift();
  d.redo.length = 0; changed();
}
function pushPixels(layer, before, vb) { const e = { t: 'px', id: layer.id, before, after: layer.ctx.getImageData(0, 0, W, H) }; if (vb !== undefined || layer.vec) { e.vb = clone(vb); e.va = clone(layer.vec); } pushHistory(e); }
function snapStruct() {
  const d = doc();
  return { activeId: d.activeId, activeGroup: d.activeGroup || null, maskEdit: d.maskEdit || null, groups: clone(d.groups || []), layers: d.layers.map(l => ({ id: l.id, name: l.name, kind: l.kind, vec: clone(l.vec), group: l.group || null, locked: !!l.locked, mirror: !!l.mirror, visible: l.visible, opacity: l.opacity, blend: l.blend, data: l.ctx.getImageData(0, 0, W, H), mask: l.mask ? l.mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H) : null, maskOff: !!l.maskOff })) };
}
function restoreStruct(s) {
  const d = doc(); editVersion++;
  d.layers = s.layers.map(o => { const l = makeLayer(o.name); Object.assign(l, { id: o.id, kind: o.kind || 'Layer', group: o.group || null, locked: !!o.locked, mirror: !!o.mirror, visible: o.visible, opacity: o.opacity, blend: o.blend }); if (o.vec) l.vec = clone(o.vec); l.ctx.putImageData(o.data, 0, 0); if (o.mask) { l.mask = mkCanvas(); l.mask.getContext('2d', { willReadFrequently: true }).putImageData(o.mask, 0, 0); l.maskOff = !!o.maskOff; } return l; });
  d.maskEdit = s.maskEdit || null; d.activeId = s.activeId; d.groups = clone(s.groups || []); d.activeGroup = s.activeGroup || null; d.sel = new Set([d.activeId]); d.noSel = false;
}
function structOp(fn, label) { const before = snapStruct(); if (fn() === false) return; pushHistory({ t: 'st', label, before, after: snapStruct() }); rebuildLayers(); }
function propChange(layer, key, value, label) {
  const before = layer[key]; if (before === value) return;
  layer[key] = value; pushHistory({ t: 'prop', id: layer.id, key, before, after: value, label }); rebuildLayers();
}
function applyEntry(e, key) {
  editVersion++;
  if (e.t === 'px' && e.m) { const l = doc().layers.find(x => x.id === e.id); if (l?.mask) { l.mask.getContext('2d').putImageData(e[key], 0, 0); l._maDirty = true; } }
  else if (e.t === 'px') { const l = doc().layers.find(x => x.id === e.id); if (l) { l.ctx.putImageData(e[key], 0, 0); if ('va' in e) { const v = clone(key === 'before' ? e.vb : e.va); if (v) l.vec = v; else delete l.vec; } } }
  else if (e.t === 'sw') { const s = swatchById(e.id); if (s) { s.paint = clone(e[key]); rerenderFills(); } }
  else if (e.t === 'swo') { const ids = e[key]; state.swatches.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); renderSwatches(); scheduleAutosave(); }
  else if (e.t === 'prop') { const l = doc().layers.find(x => x.id === e.id); if (l) l[e.key] = e[key]; }
  else if (e.t === 'sel') { selX.clearRect(0, 0, W, H); selX.putImageData(e[key], 0, 0); selectionChanged(false); }
  else if (e.t === 'sz') { setProjectSize(e[key].w, e[key].h); restoreStruct(e[key].struct); }
  else restoreStruct(e[key]);
}
function undo() { if (penDraw) finishPath(); endTextEdit(); flushVecEdit(); cancelOp(); const d = doc(), e = d.undo.pop(); if (!e) return; applyEntry(e, 'before'); d.redo.push(e); changed(); rebuildLayers(); }
function redo() { if (penDraw) finishPath(); endTextEdit(); flushVecEdit(); cancelOp(); const d = doc(), e = d.redo.pop(); if (!e) return; applyEntry(e, 'after'); d.undo.push(e); changed(); rebuildLayers(); }
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;

function jumpHistory(n) { // n = number of undo entries to keep
  endTextEdit(); flushVecEdit(); cancelOp(); const d = doc();
  while (d.undo.length > n) { const e = d.undo.pop(); applyEntry(e, 'before'); d.redo.push(e); }
  while (d.undo.length < n && d.redo.length) { const e = d.redo.pop(); applyEntry(e, 'after'); d.undo.push(e); }
  changed(); rebuildLayers();
}
const histIcon = '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>';
function renderHistory() {
  const d = doc(), list = $('#historyList'); if (!list) return;
  const items = [{ label: 'Open', n: 0 }, ...d.undo.map((e, i) => ({ label: e.label, n: i + 1 })), ...[...d.redo].reverse().map((e, i) => ({ label: e.label, n: d.undo.length + i + 1, future: true }))];
  list.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'hist' + (it.n === d.undo.length ? ' current' : '') + (it.future ? ' future' : '');
    row.innerHTML = `<span></span>${histIcon}`; row.firstChild.textContent = it.label;
    row.onclick = () => jumpHistory(it.n);
    list.appendChild(row);
  }
  const cur = list.querySelector('.current'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function changed() {
  requestRender(); scheduleAutosave(); renderHistory();
  $('#btnUndo').disabled = !doc().undo.length; $('#btnRedo').disabled = !doc().redo.length;
}

// ------------------------------------------------------------------ painting helpers
function withClip(c, fn) {
  const r = currentRegion();
  c.save();
  if (r.id !== 'all') { c.beginPath(); for (const rc of r.rects) c.rect(...rc); c.clip(); }
  fn(c);
  c.restore();
}
function regionMask() {
  const r = currentRegion(); if (r.id === 'all') return null;
  const m = new Uint8Array(W * H);
  for (const [x, y, w, h] of r.rects) for (let j = y; j < y + h; j++) m.fill(1, j * W + x, j * W + x + w);
  return m;
}
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const toHex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

let op = null; // current in-progress operation
function beginOp(opts = {}) {
  const l = activeLayer();
  if (doc().noSel) { doc().noSel = false; rebuildLayers(); }
  if (!layerVisible(l)) { toast('The active layer is hidden'); return null; }
  if (l.locked) { toast(`“${l.name}” is locked - click its lock icon to unlock it`); return null; }
  if (maskEditing(l) && !opts.vec && state.tool !== 'move') {
    const mx = l.mask.getContext('2d', { willReadFrequently: true });
    return { l: { id: l.id, name: l.name, canvas: l.mask, ctx: mx, visible: true }, before: mx.getImageData(0, 0, W, H), maskOf: l };
  }
  if (l.vec?.type === 'fill' && !opts.raster) {
    const m = mkCanvas(); m.getContext('2d').drawImage(maskCanvas(l.vec.mask), 0, 0);
    const proxy = { id: l.id, name: l.name, canvas: m, ctx: ctxOf(m), visible: true };
    return { l: proxy, before: proxy.ctx.getImageData(0, 0, W, H), real: l, realBefore: l.ctx.getImageData(0, 0, W, H), vb: clone(l.vec) };
  }
  if (l.vec && !opts.vec) { askRasterize(l); return null; } // text/shapes stay editable unless the user agrees
  return { l, before: l.ctx.getImageData(0, 0, W, H), vb: l.vec ? clone(l.vec) : undefined };
}
function restoreOp(o) { o.l.ctx.putImageData(o.before, 0, 0); if (o.maskOf) { o.maskOf._maDirty = true; return; } if (o.real) { o.real.vec = clone(o.vb); renderFill(o.real, o.l.canvas); return; } if (o.vb !== undefined) o.l.vec = clone(o.vb); }
function commitOp(o) {
  if (o.maskOf) { o.maskOf._maDirty = true; pushHistory({ t: 'px', m: true, id: o.maskOf.id, before: o.before, after: o.l.ctx.getImageData(0, 0, W, H) }); return; }
  if (o.real) { const url = o.l.canvas.toDataURL(); maskCache.set(url, o.l.canvas); o.real.vec.mask = url; o.real.vec.bb = contentBounds(o.l) || [0, 0, W, H]; renderFill(o.real); pushPixels(o.real, o.realBefore, o.vb); return; }
  pushPixels(o.l, o.before, o.vb);
}
function cancelOp() { if (op) { restoreOp(op); op = null; requestRender(); } }
function snapCanvas(imageData) { const c = mkCanvas(); c.getContext('2d').putImageData(imageData, 0, 0); return c; }

function addRecent(col, save = true) {
  state.recent = [col, ...state.recent.filter(c => c !== col)].slice(0, 12);
  if (save) try { localStorage.setItem('stitch-recent', JSON.stringify(state.recent)); } catch { /* storage unavailable */ }
  const box = $('#recent'); box.innerHTML = '';
  for (const c of state.recent) { const b = document.createElement('button'); b.style.background = c; b.title = c; b.onclick = () => setFg(c); box.appendChild(b); }
}
function setFg(c) { state.fg = c; $('#colFg').value = c; }
function pickColor(p) {
  const d = doc(); compositeDoc(d);
  const px = d.comp.getContext('2d').getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
  if (px[3] === 0) { toast('Transparent pixel'); return; }
  setFg(toHex(px[0], px[1], px[2])); addRecent(state.fg);
}

// ------------------------------------------------------------------ tools
// ===== shared option-bar widgets (Pixlr style)
const ICONS = {
  rect: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/></svg>',
  modeNew: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="none"/></svg>',
  modeAdd: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="11" height="11" fill="currentColor" stroke="none" opacity=".55"/><rect x="9" y="9" width="11" height="11" fill="currentColor" stroke="none"/></svg>',
  modeSub: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="11" height="11" fill="currentColor" stroke="none"/><rect x="9" y="9" width="11" height="11" fill="#282828" stroke="currentColor" stroke-width="1.5"/></svg>',
  lassoFree: '<svg viewBox="0 0 24 24"><path d="M7 15c-3-2-3-7 3-9s10 0 10 4-5 6-9 6c-2 0-3-1-4-1z"/><path d="M7 15c-1 2 0 4 2 5"/></svg>',
  lassoPoly: '<svg viewBox="0 0 24 24"><path d="M5 18L7 6l7 3 5-4-2 13z"/></svg>',
  lassoMag: '<svg viewBox="0 0 24 24"><path d="M5 18L7 6l7 3 5-4-2 13z" stroke-dasharray="2 2"/><path d="M14 13v6M11 16h6"/></svg>',
  rotL: '<svg viewBox="0 0 24 24"><path d="M4 10a8 8 0 1 1 2 7"/><path d="M4 4v6h6"/></svg>',
  rotR: '<svg viewBox="0 0 24 24"><path d="M20 10a8 8 0 1 0-2 7"/><path d="M20 4v6h-6"/></svg>',
  flipH: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M9 6L3 18h6z"/><path d="M15 6l6 12h-6z" fill="currentColor"/></svg>',
  flipV: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/><path d="M6 9L18 3v6z"/><path d="M6 15l12 6v-6z" fill="currentColor"/></svg>',
  dup: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/><path d="M14 11v6M11 14h6"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0"/></svg>',
};
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
function obLabel(t) { const s = el('span', 'ob-label'); s.textContent = t; return s; }
function obSeg(items, get, set) {
  const g = el('div', 'ob-seg');
  for (const it of items) {
    const b = el('button', 'ob-segbtn' + (it.text ? ' text' : ''), it.icon || ''); if (it.text) b.textContent = it.text;
    b.dataset.v = it.v; addMiniTip(b, it.title || it.text);
    b.onclick = () => { set(it.v); g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === String(get()))); };
    g.append(b);
  }
  g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === String(get())));
  g.sync = () => g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === String(get())));
  return g;
}
let popEl = null, popAnchor = null;
function closePop() { if (popEl) { const p = popEl; fadeOut(p, () => p.remove()); popEl = null; popAnchor = null; } }
function openPop(anchor, content, { width } = {}) {
  if (popAnchor === anchor) { closePop(); return; }
  closePop();
  popEl = el('div', 'ob-pop'); popEl.append(content); if (width) popEl.style.width = width + 'px';
  if (width && width > 240) { const grip = el('div', 'ob-grip', '•••'); grip.title = 'Drag to move'; popEl.append(grip); const pe = popEl; makeDraggable(grip, (dx, dy) => { pe.style.left = (parseFloat(pe.style.left) + dx) + 'px'; pe.style.top = (parseFloat(pe.style.top) + dy) + 'px'; }); }
  document.body.append(popEl); popAnchor = anchor;
  const r = anchor.getBoundingClientRect();
  popEl.style.left = Math.min(window.innerWidth - popEl.offsetWidth - 8, r.left) + 'px'; popEl.style.top = (r.bottom + 6) + 'px';
}
document.addEventListener('pointerdown', (e) => { if (popEl && !popEl.contains(e.target) && !popAnchor?.contains(e.target)) closePop(); }, true);
function obNum(get, set, { min = 0, max = 100, suffix = '', width = 52, slider = true } = {}) {
  const w = el('div', 'ob-num'); w.style.setProperty('--w', width + 'px');
  const inp = el('input'); inp.type = 'text'; inp.value = get() + suffix;
  const btn = el('button', 'ob-numbtn', '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg>');
  w.append(inp, btn);
  const commit = (v) => { v = Math.round(Math.max(min, Math.min(max, +String(v).replace(/[^\d.-]/g, '') || 0))); set(v); inp.value = v + suffix; };
  inp.onfocus = () => { inp.value = String(get()); inp.select(); };
  inp.onblur = () => commit(inp.value);
  inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); commit(get() + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)); inp.select(); } e.stopPropagation(); };
  if (slider) btn.onclick = () => {
    const box = el('div', 'ob-pop-slider'); const r = el('input', 'sl-range'); r.type = 'range'; r.min = min; r.max = max; r.value = get();
    r.oninput = () => { set(+r.value); inp.value = r.value + suffix; };
    box.append(r); openPop(w, box, { width: 200 });
  };
  else btn.style.display = 'none';
  w.sync = () => { if (document.activeElement !== inp) inp.value = get() + suffix; };
  return w;
}
function obToggle(label, get, set) {
  const l = el('label', 'ob-toggle'); const c = el('input', 'switch'); c.type = 'checkbox'; c.checked = !!get();
  c.onchange = () => set(c.checked); const s = el('span'); s.textContent = label; l.append(c, s); return l;
}
function obBtn(icon, title, fn) { const b = el('button', 'ob-icon', icon); addMiniTip(b, title); b.onclick = fn; return b; }
function obInput(prefix, get, set) {
  const w = el('div', 'ob-field'); const p = el('span'); p.textContent = prefix; const i = el('input'); i.type = 'text'; i.value = get();
  i.onfocus = () => i.select();
  i.onchange = () => { const v = Math.round(+i.value); if (Number.isFinite(v)) set(v); i.value = get(); };
  i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); set(get() + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)); i.value = get(); } e.stopPropagation(); };
  w.append(p, i); w.sync = () => { if (document.activeElement !== i) i.value = get(); }; return w;
}
function addMiniTip(b, text) { if (text) b.title = text; }

// ===== state for the tools
Object.assign(state, {
  brush: { size: 20, soft: 20, step: 15, angle: 0, round: 100, flow: 100, opacity: 100, mirror: 'none', scatter: false, hard: false, pressure: true, wrap: false },
  eraser: { size: 30, soft: 20, step: 15, angle: 0, round: 100, flow: 100, opacity: 100, hard: false, pressure: true, wrap: false },
  pencilSize: 1, selType: 'rect', selMode: 'new', feather: 0, antialias: true,
  lassoType: 'free', lassoSize: 20, wandTol: 32, contiguous: true, wandSampleAll: false, arrFixed: true, snap: true,
});
const brushOf = () => state.tool === 'eraser' ? state.eraser : state.brush;

// ===== selection
const selC = mkCanvas(), selX = ctxOf(selC);
let hasSel = false, selPath = null, antsOffset = 0, antsTimer = 0, selPreview = null;
function selAlpha() { return hasSel ? selX.getImageData(0, 0, W, H).data : null; }
// selection changes are undo steps (like Photoshop/Pixlr); record = false for ones the app makes itself (undo, switching projects)
let selSnap = null; // the selection as of the last change, the 'before' of the next step
const SEL_LABELS = { select: 'Rectangle select', lasso: 'Lasso select', wand: 'Magic select' };
function selectionChanged(record = true) {
  const img = selX.getImageData(0, 0, W, H), a = img.data; let any = false;
  const m = new Uint8Array(W * H); for (let p = 0, i = 3; p < m.length; p++, i += 4) if (a[i] >= 128) { m[p] = 1; any = true; }
  hasSel = any;
  if (!any) { selPath = null; selX.clearRect(0, 0, W, H); for (let i = 3; i < a.length; i += 4) a[i - 3] = a[i - 2] = a[i - 1] = a[i] = 0; }
  const before = selSnap && selSnap.width === W && selSnap.height === H ? selSnap : new ImageData(W, H);
  selSnap = img;
  if (record && !sameSel(before.data, a)) pushHistory({ t: 'sel', before, after: img, label: any ? histLabel || SEL_LABELS[state.tool] || 'Select' : 'Deselect' });
  if (any) {
    const path = new Path2D();
    for (let y = 0; y <= H; y++) { let run = -1; for (let x = 0; x <= W; x++) { const a1 = y > 0 && x < W ? m[(y - 1) * W + x] : 0, b1 = y < H && x < W ? m[y * W + x] : 0, edge = x < W && a1 !== b1; if (edge && run < 0) run = x; if (!edge && run >= 0) { path.moveTo(run, y); path.lineTo(x, y); run = -1; } } }
    for (let x = 0; x <= W; x++) { let run = -1; for (let y = 0; y <= H; y++) { const a1 = x > 0 && y < H ? m[y * W + x - 1] : 0, b1 = x < W && y < H ? m[y * W + x] : 0, edge = y < H && a1 !== b1; if (edge && run < 0) run = y; if (!edge && run >= 0) { path.moveTo(x, run); path.lineTo(x, y); run = -1; } } }
    selPath = path;
  }
  clearInterval(antsTimer);
  if (hasSel) antsTimer = setInterval(() => { antsOffset = (antsOffset + 1) % 8; drawOverlay(); }, 110);
  drawOverlay();
}
function sameSel(a, b) { for (let i = 3; i < a.length; i += 4) if ((a[i] >= 128) !== (b[i] >= 128) || a[i] !== b[i]) return false; return true; }
function applySelection(draw, mode, feather, aa) {
  let t = mkCanvas(); const tc = t.getContext('2d'); tc.fillStyle = '#fff'; tc.strokeStyle = '#fff'; draw(tc);
  if (!aa) { const id = tc.getImageData(0, 0, W, H), d = id.data; for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0; tc.putImageData(id, 0, 0); }
  if (feather > 0) { const f = mkCanvas(), fc = f.getContext('2d'); fc.filter = `blur(${feather}px)`; fc.drawImage(t, 0, 0); t = f; }
  selX.save();
  if (mode === 'new') { selX.clearRect(0, 0, W, H); selX.drawImage(t, 0, 0); }
  else if (mode === 'add') selX.drawImage(t, 0, 0);
  else if (mode === 'sub') { selX.globalCompositeOperation = 'destination-out'; selX.drawImage(t, 0, 0); }
  selX.restore();
  selectionChanged();
}
function deselect(record = true) { selX.clearRect(0, 0, W, H); selectionChanged(record); }
function selectAll() { selX.fillStyle = '#fff'; selX.fillRect(0, 0, W, H); labelled('Select all', () => selectionChanged()); }
function invertSelection() { const t = mkCanvas(), tc = t.getContext('2d'); tc.fillStyle = '#fff'; tc.fillRect(0, 0, W, H); tc.globalCompositeOperation = 'destination-out'; tc.drawImage(selC, 0, 0); selX.clearRect(0, 0, W, H); selX.drawImage(t, 0, 0); labelled('Invert selection', () => selectionChanged()); }
function selectRegion() { const r = currentRegion(); labelled('Select region', () => applySelection(c => { for (const rc of r.rects) c.fillRect(...rc); }, 'new', 0, false)); }
// combined 0..255 weights of "Paint only in" region and selection, or null if everything is editable
function combinedWeights() {
  const rm = regionMask(), sa = selAlpha(); if (!rm && !sa) return null;
  const w = new Uint8Array(W * H);
  for (let p = 0; p < w.length; p++) w[p] = (rm ? rm[p] : 1) * (sa ? sa[p * 4 + 3] : 255);
  return w;
}
// draw `src` (a W×H canvas) onto the op's layer through region clip + selection mask
const tmpC = mkCanvas(), tmpX = tmpC.getContext('2d');
function compositeOnto(o, src, { erase = false, alpha = 1 } = {}) {
  restoreOp(o);
  let s = src;
  if (hasSel) { tmpX.globalCompositeOperation = 'source-over'; tmpX.clearRect(0, 0, W, H); tmpX.drawImage(src, 0, 0); tmpX.globalCompositeOperation = 'destination-in'; tmpX.drawImage(selC, 0, 0); tmpX.globalCompositeOperation = 'source-over'; s = tmpC; }
  withClip(o.l.ctx, c => { c.globalAlpha = alpha; c.globalCompositeOperation = erase ? 'destination-out' : 'source-over'; c.drawImage(s, 0, 0); });
  if (o.maskOf) o.maskOf._maDirty = true;
  if (o.real) renderFill(o.real, o.l.canvas);
  requestRender();
}
function clearSelectedPixels() {
  const o = beginOp(); if (!o) return;
  const s = mkCanvas(); s.getContext('2d').drawImage(selC, 0, 0);
  compositeOnto(o, s, { erase: true }); labelled('Delete selection', () => commitOp(o));
}
// clipboard: with a pixel selection, Ctrl+C copies those pixels; without one, the selected layers themselves (text,
// shapes and paths stay editable). It is kept in the app, so it pastes into any tab, shirt/pants or project.
// The system clipboard gets a marker text, so an older image on it doesn't win over what was copied here.
let clip = null;
const CLIP_MARK = 'stitch-editor-layers';
function snapLayer(l) {
  const c = mkCanvas(); c.getContext('2d').drawImage(l.canvas, 0, 0);
  const m = l.mask ? (() => { const k = mkCanvas(); k.getContext('2d').drawImage(l.mask, 0, 0); return k; })() : null;
  return { name: l.name, kind: l.kind, opacity: l.opacity, blend: l.blend, visible: l.visible, mirror: !!l.mirror, vec: clone(l.vec), canvas: c, mask: m, maskOff: !!l.maskOff };
}
function copySel(cut) {
  if (hasSel) {
    const l = activeLayer(), c = mkCanvas(), x = c.getContext('2d'); x.drawImage(l.canvas, 0, 0);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(selC, 0, 0);
    clip = { w: W, h: H, layers: [{ name: 'Pasted', kind: 'Image', opacity: 1, blend: 'source-over', visible: true, mirror: false, vec: null, canvas: c, mask: null, maskOff: false }] };
  } else {
    const ids = new Set(selectedIds());
    clip = { w: W, h: H, layers: doc().layers.filter(l => ids.has(l.id)).map(snapLayer) };
  }
  navigator.clipboard.writeText(CLIP_MARK).catch(() => {});
  const n = clip.layers.length;
  toast(hasSel ? (cut ? 'Cut selection' : 'Copied selection') : `${cut ? 'Cut' : 'Copied'} ${n > 1 ? n + ' layers' : 'layer'} - Ctrl+V pastes it into any tab`);
  if (cut) { if (hasSel) clearSelectedPixels(); else labelled('Cut', () => $('#lyDel').click()); }
}
// pasted above the active layer; from a project of another size it lands centred
function pasteClip(cb) {
  const dx = Math.round((W - cb.w) / 2), dy = Math.round((H - cb.h) / 2), same = !dx && !dy && cb.w === W && cb.h === H;
  structOp(() => {
    const d = doc(), a = activeLayer(), group = !d.noSel ? a?.group || null : null, made = cb.layers.map(s => {
      const l = makeLayer(s.name); Object.assign(l, { kind: s.kind, opacity: s.opacity, blend: s.blend, visible: s.visible, mirror: s.mirror, group });
      l.ctx.drawImage(s.canvas, dx, dy);
      if (s.mask) { l.mask = mkCanvas(); l.mask.getContext('2d', { willReadFrequently: true }).drawImage(s.mask, dx, dy); l.maskOff = s.maskOff; }
      if (s.vec && (same || s.vec.type !== 'fill')) { l.vec = clone(s.vec); if (!same) { shiftVec(l.vec, dx, dy); renderVec(l); } }
      else if (s.vec) l.kind = 'Image'; // a colour fill's mask is the other project's size: it comes over as pixels
      return l;
    });
    d.layers.splice(d.layers.indexOf(a) + 1, 0, ...made);
    d.activeId = made[made.length - 1].id; d.activeGroup = null; d.noSel = false; d.sel = new Set(made.map(l => l.id));
  }, 'Paste');
  setTool('move');
}
function pasteCanvas(c, name = 'Pasted') { pasteClip({ w: W, h: H, layers: [{ name, kind: 'Image', opacity: 1, blend: 'source-over', visible: true, mirror: false, vec: null, canvas: c, mask: null, maskOff: false }] }); }
document.addEventListener('paste', async (e) => {
  if (e.target.matches?.('input, textarea')) return;
  if (homeOpen()) { const f = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))?.getAsFile(); if (f) { e.preventDefault(); newProjectFromImages([f]); } return; }
  const ours = clip && e.clipboardData?.getData('text/plain') === CLIP_MARK;
  const item = !ours && [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); const img = new Image(); img.src = URL.createObjectURL(item.getAsFile()); await img.decode(); const c = mkCanvas(); c.getContext('2d').drawImage(img, img.width === W && img.height === H ? 0 : Math.round((W - Math.min(W, img.width)) / 2), img.width === W && img.height === H ? 0 : Math.round((H - Math.min(H, img.height)) / 2), Math.min(W, img.width), Math.min(H, img.height)); pasteCanvas(c, 'Pasted image'); return; }
  if (clip) { e.preventDefault(); pasteClip(clip); }
});

let modeOverride = null;
const selModeFor = (e) => e.shiftKey ? 'add' : e.altKey ? 'sub' : state.selMode;
const marqueeTool = {
  down(p, e) { modeOverride = selModeFor(e); op = { start: p, mode: modeOverride, constrain: false }; },
  move(p, e) { if (!op) return; op.end = p; op.constrain = e.shiftKey && op.mode !== 'add'; selPreview = marqueeShape(op); drawOverlay(); },
  up(p, e) {
    if (!op) return; const o = op; op = null; selPreview = null; o.end = p;
    if (Math.hypot(p.x - o.start.x, p.y - o.start.y) < 2) { if (o.mode === 'new') deselect(); else drawOverlay(); return; }
    const s = marqueeShape(o);
    applySelection(c => { c.beginPath(); s(c); c.fill(); }, o.mode, state.feather, state.antialias);
  },
};
// works in whole pixels: the pixel pressed on is always one corner of the box, whichever way the drag goes
function marqueeShape(o) {
  const sx = Math.floor(o.start.x), sy = Math.floor(o.start.y);
  let dx = Math.floor(o.end.x) - sx, dy = Math.floor(o.end.y) - sy;
  if (o.constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = dx < 0 ? -m : m; dy = dy < 0 ? -m : m; }
  const x = Math.min(sx, sx + dx), y = Math.min(sy, sy + dy), w = Math.abs(dx) + 1, h = Math.abs(dy) + 1;
  if (state.selType === 'rect') return (c) => c.rect(x, y, w, h);
  return (c) => c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
}
// lasso: free, polygon, magnetic
let lasso = null, gradMap = null;
function buildGradMap() {
  compositeDoc(doc()); const d = doc().comp.getContext('2d').getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
  const lum = (i) => (d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11) * d[i + 3] / 255;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = (y * W + x) * 4; g[y * W + x] = Math.abs(lum(i + 4) - lum(i - 4)) + Math.abs(lum(i + W * 4) - lum(i - W * 4)); }
  return g;
}
function snapEdge(p) {
  const r = Math.max(2, Math.round(state.lassoSize / 4)); let best = -1, bp = p;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy; if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || dx * dx + dy * dy > r * r) continue;
    const v = gradMap[y * W + x] - Math.hypot(dx, dy) * 2; if (v > best) { best = v; bp = { x: x + .5, y: y + .5 }; }
  }
  return best > 8 ? bp : p;
}
function finishLasso() {
  const L = lasso; lasso = null; selPreview = null;
  if (!L || L.pts.length < 3) { drawOverlay(); return; }
  applySelection(c => { c.beginPath(); L.pts.forEach((q, i) => i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)); c.closePath(); c.fill(); }, L.mode, state.feather, state.antialias);
}
function lassoPreview() {
  if (!lasso) { selPreview = null; return; }
  const pts = lasso.hover && state.lassoType === 'poly' ? [...lasso.pts, lasso.hover] : lasso.pts;
  selPreview = (c) => { pts.forEach((q, i) => i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)); };
}
const lassoTool = {
  down(p, e) {
    if (state.lassoType === 'poly') {
      if (!lasso) lasso = { pts: [p], mode: selModeFor(e) };
      else {
        const f = lasso.pts[0];
        if (lasso.pts.length > 2 && Math.hypot(p.x - f.x, p.y - f.y) * state.zoom < 9) { finishLasso(); return; }
        lasso.pts.push(p);
      }
      lassoPreview(); drawOverlay(); return;
    }
    if (state.lassoType === 'mag') gradMap = buildGradMap();
    lasso = { pts: [state.lassoType === 'mag' ? snapEdge(p) : p], mode: selModeFor(e) }; lassoPreview(); drawOverlay();
  },
  move(p) {
    if (!lasso || state.lassoType === 'poly') return;
    const q = state.lassoType === 'mag' ? snapEdge(p) : p, last = lasso.pts[lasso.pts.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) >= 1.5) lasso.pts.push(q);
    lassoPreview(); drawOverlay();
  },
  hover(p) { if (lasso && state.lassoType === 'poly') { lasso.hover = p; lassoPreview(); } },
  up(p) { if (state.lassoType !== 'poly') { if (lasso && lasso.pts.length < 3 && lasso.mode === 'new') { lasso = null; deselect(); return; } finishLasso(); } },
  dbl() { if (lasso && state.lassoType === 'poly') finishLasso(); },
};
// magic select
const wandTool = {
  down(p, e) {
    const x = Math.floor(p.x), y = Math.floor(p.y); if (x < 0 || y < 0 || x >= W || y >= H) return;
    let src; if (state.wandSampleAll) { compositeDoc(doc()); src = doc().comp.getContext('2d').getImageData(0, 0, W, H).data; } else src = activeLayer().ctx.getImageData(0, 0, W, H).data;
    const m = floodRegion(src, x, y, state.wandTol, state.contiguous);
    const t = mkCanvas(), tc = t.getContext('2d'), id = tc.createImageData(W, H);
    for (let i = 0; i < m.length; i++) if (m[i]) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = id.data[i * 4 + 3] = 255; }
    tc.putImageData(id, 0, 0);
    applySelection(c => { if (state.antialias) { c.filter = 'blur(0.6px)'; } c.drawImage(t, 0, 0); c.filter = 'none'; }, selModeFor(e), state.feather, true);
  },
};
function floodRegion(src, x, y, tol, contiguous) {
  const i0 = (y * W + x) * 4, r0 = src[i0], g0 = src[i0 + 1], b0 = src[i0 + 2], a0 = src[i0 + 3], m = new Uint8Array(W * H);
  const match = (k) => (a0 === 0 && src[k + 3] === 0) || (Math.abs(src[k] - r0) <= tol && Math.abs(src[k + 1] - g0) <= tol && Math.abs(src[k + 2] - b0) <= tol && Math.abs(src[k + 3] - a0) <= tol);
  if (!contiguous) { for (let p = 0; p < m.length; p++) if (match(p * 4)) m[p] = 1; return m; }
  const seen = new Uint8Array(W * H), st = [x, y];
  while (st.length) {
    const py = st.pop(), px = st.pop(), i = py * W + px; if (seen[i]) continue; seen[i] = 1;
    if (!match(i * 4)) continue; m[i] = 1;
    if (px > 0) st.push(px - 1, py); if (px < W - 1) st.push(px + 1, py); if (py > 0) st.push(px, py - 1); if (py < H - 1) st.push(px, py + 1);
  }
  return m;
}

// ===== brush engine (draw + eraser)
const strokeC = mkCanvas(), sctx = strokeC.getContext('2d');
const tipCache = new Map();
function makeTip(b, size, hard) {
  size = Math.max(0.5, size);
  const key = [Math.round(size * 2) / 2, b.soft, b.angle, b.round, hard].join('|');
  if (tipCache.has(key)) return tipCache.get(key);
  const r = size / 2, ry = r * b.round / 100, dim = Math.ceil(size) + 2, c = mkCanvas(dim, dim), x = c.getContext('2d');
  const cx = dim / 2, cy = dim / 2, ang = b.angle * Math.PI / 180;
  if (hard || size < 2) {
    const id = x.createImageData(dim, dim), cs = Math.cos(-ang), sn = Math.sin(-ang);
    for (let j = 0; j < dim; j++) for (let i = 0; i < dim; i++) {
      const dx = i + .5 - cx, dy = j + .5 - cy, u = dx * cs - dy * sn, v = dx * sn + dy * cs;
      if ((u * u) / (r * r) + (v * v) / Math.max(.25, ry * ry) <= 1.0001 || (size < 1.5 && i === Math.floor(cx) && j === Math.floor(cy))) { const k = (j * dim + i) * 4; id.data[k] = id.data[k + 1] = id.data[k + 2] = id.data[k + 3] = 255; }
    }
    x.putImageData(id, 0, 0);
  } else {
    x.translate(cx, cy); x.rotate(ang); x.scale(1, b.round / 100);
    const hardness = 1 - b.soft / 100, g = x.createRadialGradient(0, 0, Math.max(0, r * hardness * .98), 0, 0, r);
    g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = b.soft === 0 ? '#fff' : g; x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.fill();
  }
  if (tipCache.size > 200) tipCache.clear();
  tipCache.set(key, c); return c;
}
function tintedTip(tip, color) {
  const c = mkCanvas(tip.width, tip.height), x = c.getContext('2d'); x.drawImage(tip, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height); return c;
}
function mirrorPoints(p) {
  const m = state.tool === 'brush' ? state.brush.mirror : 'none', out = [p];
  if (m !== 'none') {
    const r = currentRegion(), [bx, by, bw, bh] = r.id === 'all' ? [0, 0, W, H] : boundsOf(r.rects), cx = bx + bw / 2, cy = by + bh / 2;
    if (m === 'h' || m === 'both') out.push({ x: 2 * cx - p.x, y: p.y, pr: p.pr });
    if (m === 'v' || m === 'both') out.push({ x: p.x, y: 2 * cy - p.y, pr: p.pr }); if (m === 'both') out.push({ x: 2 * cx - p.x, y: 2 * cy - p.y, pr: p.pr });
  }
  return out;
}
function stampAt(p) {
  const b = brushOf(), size = b.size * (b.pressure && p.pr != null ? Math.max(.08, p.pr) : 1);
  for (const q of mirrorPoints(p)) {
    let x = q.x, y = q.y;
    if (b.scatter) { const a = Math.random() * Math.PI * 2, d = Math.random() * b.size * .6; x += Math.cos(a) * d; y += Math.sin(a) * d; }
    const tip = op.tips.get(Math.round(size * 2) / 2) || (() => { const t = tintedTip(makeTip(b, size, b.hard), state.tool === 'eraser' ? '#000' : state.fg); op.tips.set(Math.round(size * 2) / 2, t); return t; })();
    sctx.globalAlpha = b.flow / 100;
    if (isTemplate() && state.seams) stampWrapped(tip, x, y, b.hard);
    else stampTip(tip, x, y, b.hard);
  }
}
function stampTip(tip, x, y, hard, clipRect) {
  let dx = x - tip.width / 2, dy = y - tip.height / 2; if (hard) { dx = Math.round(dx); dy = Math.round(dy); }
  if (!clipRect) { sctx.drawImage(tip, dx, dy); return; }
  sctx.save(); sctx.beginPath(); sctx.rect(...clipRect); sctx.clip(); sctx.drawImage(tip, dx, dy); sctx.restore();
}
// Seams: a dab stays on its own face, and the part that would hang over an edge lands on the face that
// edge joins on the 3D body (wherever that face sits on the template)
function stampWrapped(tip, x, y, hard) {
  const f = faceAt(x, y); if (!f) { stampTip(tip, x, y, hard); return; }
  stampTip(tip, x, y, hard, f.rect);
  const r = tip.width / 2;
  for (const { e, o } of EDGES) {
    if (e.part !== f.part || e.face !== f.face) continue;
    const q = acrossSeam(e, o, { x, y }); if (q.d < r) stampTip(tip, q.x, q.y, hard, o.rect);
  }
}
function strokeTo(p) {
  const b = brushOf(), spacing = Math.max(.5, b.size * Math.max(1, b.step) / 100), last = op.last;
  const dx = p.x - last.x, dy = p.y - last.y, dist = Math.hypot(dx, dy);
  let t = op.carry;
  while (t <= dist) { const k = dist ? t / dist : 0; stampAt({ x: last.x + dx * k, y: last.y + dy * k, pr: last.pr != null ? last.pr + (p.pr - last.pr) * k : p.pr }); t += spacing; }
  op.carry = t - dist; op.last = p;
}
// Mirror on: the stroke plus each face of it flipped onto its partner face (a normal canvas flips as a whole). Copying the
// finished stroke picture keeps both sides identical, whatever the brush does (scatter, angled tips, hard-edge rounding)
const mirC = mkCanvas(), mirX = mirC.getContext('2d');
function withMirror(src) {
  if (!mirroring()) return src;
  if (mirC.width !== W || mirC.height !== H) { mirC.width = W; mirC.height = H; }
  mirX.clearRect(0, 0, W, H); mirX.drawImage(src, 0, 0);
  const flip = (sx, sy, sw, sh, dx, dy) => { mirX.save(); mirX.translate(dx + sw, dy); mirX.scale(-1, 1); mirX.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh); mirX.restore(); };
  if (!isTemplate()) flip(0, 0, W, H, 0, 0);
  else for (const { from: [fx, fy, fw, fh], to: [tx, ty] } of MIRROR_FACES) flip(fx, fy, fw, fh, tx, ty);
  return mirC;
}
function applyBrush() { compositeOnto(op, withMirror(strokeC), { erase: state.tool === 'eraser', alpha: brushOf().opacity / 100 }); }
// putting the stroke onto the layer touches the whole canvas, so do it at most once per frame (stamping stays per event)
function compositeSoon(fn) {
  if (!op) return; op.pendingComp = fn;
  if (!op.compRaf) { const o = op; o.compRaf = requestAnimationFrame(() => { o.compRaf = 0; const f = o.pendingComp; o.pendingComp = null; if (op === o) f?.(); }); }
}
function flushComposite(o) { if (o.compRaf) { cancelAnimationFrame(o.compRaf); o.compRaf = 0; } const f = o.pendingComp; o.pendingComp = null; f?.(); }
const penPressure = (e) => (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : null;
const brushTool = {
  down(p, e) {
    op = beginOp(); if (!op) return;
    if (state.tool === 'brush') addRecent(state.fg);
    op.tips = new Map(); sctx.clearRect(0, 0, W, H);
    p.pr = penPressure(e);
    if (e.shiftKey && lastPoint) { op.last = lastPoint; op.carry = 0; strokeTo(p); }
    else { op.last = p; op.carry = 0; stampAt(p); op.carry = Math.max(.5, brushOf().size * Math.max(1, brushOf().step) / 100); }
    applyBrush();
  },
  move(p, e) { if (!op || !op.tips) return; p.pr = penPressure(e); strokeTo(p); compositeSoon(applyBrush); },
  up() { if (!op || !op.tips) return; flushComposite(op); lastPoint = op.last; commitOp(op); op = null; },
};
let lastPoint = null;
// Seams on: a stroke that runs off a face carries on from the matching edge of the face it joins on the body.
// roll.m maps the pointer to where the stroke really is; every edge crossed turns it onto the next face.
const ROLL_TOOLS = new Set(['brush', 'eraser', 'pencil']);
let roll = null;
const mapPt = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
const mulM = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const inside = (r, p) => p.x >= r[0] && p.y >= r[1] && p.x < r[0] + r[2] && p.y < r[1] + r[3];
function rollStart(p) {
  const f = state.seams && isTemplate() && ROLL_TOOLS.has(state.tool) ? faceAt(p.x, p.y) : null;
  roll = f ? { m: [1, 0, 0, 1, 0, 0], f, last: p, moved: false } : null;
}
function rollMove(p, e) {
  const t = tools[state.tool];
  if (!roll || !op) { t.move?.(p, e); return; }
  let v = mapPt(roll.m, p);
  for (let n = 0; n < 4 && !inside(roll.f.rect, v); n++) {
    // the edge the stroke leaves through first
    const a = roll.last, dIn = (E, q) => (q.x - E.p0[0]) * E.n[0] + (q.y - E.p0[1]) * E.n[1]; let best = null;
    for (const E of EDGES) {
      if (E.e.part !== roll.f.part || E.e.face !== roll.f.face) continue;
      const da = dIn(E.e, a), dv = dIn(E.e, v); if (dv >= 0) continue;
      const k = da <= 0 ? 0 : da / (da - dv); if (!best || k < best.k) best = { E, k };
    }
    if (!best) break;
    const x = { x: a.x + (v.x - a.x) * best.k, y: a.y + (v.y - a.y) * best.k };
    t.move(x, e); // draw up to the edge
    const T = seamMatrix(best.E.e, best.E.o), entry = mapPt(T, x);
    roll.m = mulM(T, roll.m); roll.f = best.E.o; roll.moved = true;
    op.last = { ...entry, pr: op.last?.pr }; roll.last = entry; v = mapPt(T, v);
  }
  t.move(v, e); roll.last = v;
}
// pencil: pixel-perfect squares
function pencilSeg(a, b) {
  const s = state.pencilSize; sctx.fillStyle = state.fg; sctx.globalAlpha = 1;
  let x0 = Math.floor(a.x), y0 = Math.floor(a.y); const x1 = Math.floor(b.x), y1 = Math.floor(b.y);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, o = Math.floor((s - 1) / 2);
  let err = dx + dy;
  for (;;) { sctx.fillRect(x0 - o, y0 - o, s, s); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
}
const pencilTool = {
  down(p, e) { op = beginOp(); if (!op) return; addRecent(state.fg); sctx.clearRect(0, 0, W, H); const s = e.shiftKey && lastPoint ? lastPoint : p; pencilSeg(s, p); op.last = p; compositeOnto(op, withMirror(strokeC), { alpha: state.opacity }); },
  move(p) { if (!op) return; pencilSeg(op.last, p); op.last = p; compositeSoon(() => compositeOnto(op, withMirror(strokeC), { alpha: state.opacity })); },
  up() { if (!op) return; flushComposite(op); lastPoint = op.last; commitOp(op); op = null; },
};

// ===== shapes / gradient (draw into a scratch canvas, then composite through region + selection)
const shapeC = mkCanvas(), shX = shapeC.getContext('2d');
function drawShape(c, a, b, shift) {
  c.strokeStyle = c.fillStyle = state.fg; c.lineWidth = state.size; c.lineCap = 'round'; c.lineJoin = 'miter';
  let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (shift && (state.tool === 'rect' || state.tool === 'ellipse')) { const m = Math.max(w, h); w = h = m; x = b.x < a.x ? a.x - m : a.x; y = b.y < a.y ? a.y - m : a.y; }
  if (state.tool === 'rect') {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (state.fillShape) c.fillRect(x, y, w, h); else { const o = state.size % 2 ? 0.5 : 0; c.strokeRect(x + o, y + o, w, h); }
  } else if (state.tool === 'ellipse') {
    c.beginPath(); c.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, .1), Math.max(h / 2, .1), 0, 0, Math.PI * 2); state.fillShape ? c.fill() : c.stroke();
  } else if (state.tool === 'line') {
    let ex = b.x, ey = b.y;
    if (shift) { const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(b.x - a.x, b.y - a.y); ex = a.x + Math.cos(ang) * len; ey = a.y + Math.sin(ang) * len; }
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(ex, ey); c.stroke();
  } else if (state.tool === 'gradient') {
    const g = c.createLinearGradient(a.x, a.y, b.x, b.y); g.addColorStop(0, state.fg);
    if (state.gradTransparent) { const [r, gg, bb] = hexToRgb(state.fg); g.addColorStop(1, `rgba(${r},${gg},${bb},0)`); } else g.addColorStop(1, state.bg);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }
}
const shapeTool = {
  down(p) { op = beginOp(); if (!op) return; op.start = p; addRecent(state.fg); },
  move(p, e) { if (!op || !op.start) return; shX.clearRect(0, 0, W, H); drawShape(shX, op.start, p, e.shiftKey); compositeOnto(op, shapeC, { alpha: state.opacity }); },
  up(p, e) { if (!op || !op.start) return; if (Math.hypot(p.x - op.start.x, p.y - op.start.y) < 1) { restoreOp(op); op = null; requestRender(); return; } this.move(p, e); commitOp(op); op = null; },
};

function floodFill(p, e) {
  const l = activeLayer(); if (!l.visible) { toast('The active layer is hidden'); return; }
  if ((l.vec?.type === 'text' || l.vec?.type === 'shape') && !doc().noSel && !maskEditing(l)) { // recolour editable text/shapes instead of rasterizing them
    addRecent(state.fg); vecEdit(l, v => { v.fill = { type: 'color', color: state.fg }; }, l.vec.type === 'text' ? 'Text colour' : 'Shape fill'); buildOptions(); return;
  }
  const o = beginOp(); if (!o) return;
  const fillC = mkCanvas(), fx = fillC.getContext('2d');
  if (e && e.shiftKey) { fx.fillStyle = state.fg; fx.fillRect(0, 0, W, H); }
  else {
    const x = Math.floor(p.x), y = Math.floor(p.y); if (x < 0 || y < 0 || x >= W || y >= H) return;
    const rm = regionMask(); if (rm && !rm[y * W + x]) { toast('Clicked outside the selected region'); return; }
    let src; if (state.sampleAll) { compositeDoc(doc()); src = doc().comp.getContext('2d').getImageData(0, 0, W, H).data; } else src = o.before.data;
    const m = floodRegion(src, x, y, state.tolerance, true), id = fx.createImageData(W, H), [r, g, b] = hexToRgb(state.fg);
    for (let i = 0; i < m.length; i++) if (m[i] && (!rm || rm[i])) { const k = i * 4; id.data[k] = r; id.data[k + 1] = g; id.data[k + 2] = b; id.data[k + 3] = 255; }
    fx.putImageData(id, 0, 0);
  }
  compositeOnto(o, fillC, { alpha: state.opacity }); addRecent(state.fg); commitOp(o);
}

// ===== arrange (move / scale / rotate the active layer)
let arr = null, editVersion = 0;
const bumpEdit = () => { editVersion++; };
function ensureArr() {
  const l = activeLayer();
  if (arr && arr.layerId === l.id && arr.version === editVersion) {
    // text grows while you type without an edit-version bump, so keep the handles in step with the layer
    const v = l.vec; if (arr.vec && !arr.path && v && v.type !== 'fill' && !op?.arr) Object.assign(arr, { x: v.x, y: v.y, w: Math.max(1, v.w), h: Math.max(1, v.h), angle: v.angle || 0, flipX: !!v.flipX, flipY: !!v.flipY });
    return arr;
  }
  if (l.vec?.type === 'path') { const b = pathBBox(allPts(l.vec)); arr = { layerId: l.id, version: editVersion, vec: true, path: true, x: b.x, y: b.y, w: b.w, h: b.h, angle: 0, flipX: false, flipY: false }; return arr; }
  if (l.vec && l.vec.type !== 'fill') { const v = l.vec; arr = { layerId: l.id, version: editVersion, vec: true, x: v.x, y: v.y, w: Math.max(1, v.w), h: Math.max(1, v.h), angle: v.angle || 0, flipX: !!v.flipX, flipY: !!v.flipY }; return arr; }
  const srcL = l.vec?.type === 'fill' ? { ctx: maskCanvas(l.vec.mask).getContext('2d'), canvas: maskCanvas(l.vec.mask) } : l;
  const b = contentBounds(srcL);
  if (!b) { arr = { layerId: l.id, version: editVersion, empty: true }; return arr; }
  const src = mkCanvas(b[2], b[3]); src.getContext('2d').drawImage(srcL.canvas, -b[0], -b[1]);
  arr = { layerId: l.id, version: editVersion, src, x: b[0], y: b[1], w: b[2], h: b[3], angle: 0, flipX: false, flipY: false };
  return arr;
}
function renderArr(o) {
  if (arr.path) {
    const a = arr, base = normPath(clone(o.vb)).paths, b0 = pathBBox(base.flatMap(sp => sp.pts)), cx0 = b0.x + b0.w / 2, cy0 = b0.y + b0.h / 2, cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    const sx = a.w / b0.w * (a.flipX ? -1 : 1), sy = a.h / b0.h * (a.flipY ? -1 : 1), cs = Math.cos(a.angle), sn = Math.sin(a.angle);
    const m = (q) => q && ({ x: cx + (q.x - cx0) * sx * cs - (q.y - cy0) * sy * sn, y: cy + (q.x - cx0) * sx * sn + (q.y - cy0) * sy * cs });
    normPath(o.l.vec).paths = base.map(sp => ({ closed: sp.closed, pts: sp.pts.map(pt => ({ ...m(pt), hin: m(pt.hin), hout: m(pt.hout) })) })); renderPath(o.l); requestRender(); return;
  }
  if (arr.vec) {
    const a = arr, v = o.l.vec;
    if (v.type === 'text') { // resizing text scales its font size from where the drag started, in whole pixels
      const b = o.vb || v;
      if (Math.abs(a.h - b.h) > .5 || Math.abs(a.w - b.w) > .5) { const k = Math.abs(a.h - b.h) > .5 ? a.h / b.h : a.w / b.w; v.size = Math.max(4, Math.round(b.size * k)); }
    }
    else { v.w = a.w; v.h = a.h; }
    Object.assign(v, { x: a.x, y: a.y, angle: a.angle, flipX: a.flipX, flipY: a.flipY }); renderVec(o.l);
    if (v.type === 'text') {
      // text scales as a whole, so keep the edge opposite the dragged handle where it was
      const b = o.vb;
      if (b && Math.abs(a.x + a.w - (b.x + b.w)) < 1 && Math.abs(a.x - b.x) >= 1) v.x = Math.round(a.x + a.w - v.w);
      if (b && Math.abs(a.y + a.h - (b.y + b.h)) < 1 && Math.abs(a.y - b.y) >= 1) v.y = Math.round(a.y + a.h - v.h);
      if (v.x !== a.x || v.y !== a.y) renderVec(o.l);
      a.x = v.x; a.y = v.y; a.w = v.w; a.h = v.h;
    }
    requestRender(); return;
  }
  const a = arr, c = o.l.ctx; c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
  c.translate(a.x + a.w / 2, a.y + a.h / 2); c.rotate(a.angle); c.scale(a.flipX ? -1 : 1, a.flipY ? -1 : 1);
  c.imageSmoothingQuality = 'high'; c.drawImage(a.src, -a.w / 2, -a.h / 2, a.w, a.h); c.restore(); if (o.real) renderFill(o.real, o.l.canvas); requestRender();
}
function arrCommit(o, label) { labelled(label, () => commitOp(o)); if (arr.path) arr = null; else arr.version = editVersion; syncArrInputs(); }
function arrApply(label, fn) { const a = ensureArr(); if (a.empty) { toast('This layer is empty'); return; } const o = beginOp({ vec: !!a.vec }); if (!o) return; fn(a); renderArr(o); arrCommit(o, label); drawOverlay(); }
function arrHandles(a) {
  const pts = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]], cs = Math.cos(a.angle), sn = Math.sin(a.angle), cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  const tr = (u, v) => ({ x: cx + u * cs - v * sn, y: cy + u * sn + v * cs });
  return { corners: pts.map(([u, v]) => tr(u * a.w / 2, v * a.h / 2)), rot: tr(0, -a.h / 2 - 22 / state.zoom), tr, cx, cy, cs, sn };
}
function arrHit(p) {
  const a = arr; if (!a || a.empty) return null; const H_ = arrHandles(a), tol = 7 / state.zoom;
  if (Math.hypot(p.x - H_.rot.x, p.y - H_.rot.y) < tol + 2) return 'rot';
  for (let i = 0; i < 8; i++) if (Math.hypot(p.x - H_.corners[i].x, p.y - H_.corners[i].y) < tol) return i;
  return 'move';
}
const arrCursor = { rot: 'grab', move: 'move', 0: 'nwse-resize', 4: 'nwse-resize', 2: 'nesw-resize', 6: 'nesw-resize', 1: 'ns-resize', 5: 'ns-resize', 3: 'ew-resize', 7: 'ew-resize' };
function arrInside(p) {
  const a = arr; if (!a || a.empty) return false; const H_ = arrHandles(a), dx = p.x - H_.cx, dy = p.y - H_.cy, tol = 4 / state.zoom;
  return Math.abs(dx * H_.cs + dy * H_.sn) <= a.w / 2 + tol && Math.abs(-dx * H_.sn + dy * H_.cs) <= a.h / 2 + tol;
}
// the layers the Move tool moves together: the active group, or several selected layers (null for one layer)
function moveSet() {
  const d = doc(); if (d.noSel) return null;
  if (d.activeGroup) return groupMembers(d.activeGroup);
  return d.sel?.size > 1 ? d.layers.filter(l => d.sel.has(l.id)) : null;
}
function beginGroupMove(mem, p) {
  op = { gmove: true, start: p, struct: snapStruct(), label: doc().activeGroup ? 'Move group' : 'Move layers', mem: mem.map(l => ({ l, snap: (() => { const c = mkCanvas(); c.getContext('2d').drawImage(l.canvas, 0, 0); return c; })(), vec: clone(l.vec), mask: l.vec?.type === 'fill' ? maskCanvas(l.vec.mask) : null })) };
  op.snap = snapTargets(new Set(mem.map(l => l.id))); op.b0 = unionBounds(mem);
}
const arrangeTool = {
  down(p, e) {
    const d = doc(), mem = moveSet();
    if (mem) {
      const b = unionBounds(mem);
      if (b && p.x >= b[0] && p.y >= b[1] && p.x <= b[0] + b[2] && p.y <= b[1] + b[3]) {
        if (mem.some(l => l.locked)) { toast(d.activeGroup ? 'A layer in this group is locked' : 'One of the selected layers is locked'); return; }
        beginGroupMove(mem, p); return;
      }
    }
    let a = d.noSel ? null : ensureArr();
    const onBox = a && !a.empty && (arrHit(p) !== 'move' || arrInside(p));
    if (!onBox) {
      const hit = layerAtPoint(p);
      if (!hit) { deselectLayers(); return; }
      selectLayer(hit); a = ensureArr(); if (a.empty) return;
    }
    op = beginOp({ vec: !!a.vec }); if (!op) return;
    op.arr = { hit: arrHit(p), start: p, a0: { ...a }, snap: snapTargets(new Set([activeLayer().id])) };
  },
  move(p, e) {
    if (op?.gmove) {
      let dx = Math.round(p.x - op.start.x), dy = Math.round(p.y - op.start.y);
      if (op.b0) { const b = op.b0, s = snapBox(b[0] + dx, b[1] + dy, b[2], b[3], op.snap, e); dx += s.dx; dy += s.dy; op.snapLines = s.lines; }
      op.moved = !!(dx || dy);
      for (const m of op.mem) {
        const l = m.l;
        if (m.vec && m.vec.type === 'fill') { const c = mkCanvas(); c.getContext('2d').drawImage(m.mask, dx, dy); m.live = c; renderFill(l, c); }
        else if (m.vec) { const v = clone(m.vec); shiftVec(v, dx, dy); l.vec = v; renderVec(l); }
        else { l.ctx.clearRect(0, 0, W, H); l.ctx.drawImage(m.snap, dx, dy); }
      }
      requestRender(); drawOverlay(); return;
    }
    if (!op || !op.arr) return;
    const { hit, start, a0 } = op.arr, a = arr; op.snapLines = null;
    if (hit === 'move') {
      a.x = Math.round(a0.x + p.x - start.x); a.y = Math.round(a0.y + p.y - start.y);
      const b = aabbOf(a), s = snapBox(b.x, b.y, b.w, b.h, op.arr.snap, e); a.x += s.dx; a.y += s.dy; op.snapLines = s.lines;
    }
    else if (hit === 'rot') {
      const cx = a0.x + a0.w / 2, cy = a0.y + a0.h / 2; let ang = a0.angle + Math.atan2(p.y - cy, p.x - cx) - Math.atan2(start.y - cy, start.x - cx);
      if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * Math.PI / 12; a.angle = ang;
    } else {
      const H0 = arrHandles(a0), cs = H0.cs, sn = H0.sn;
      const loc = (q) => { const dx = q.x - H0.cx, dy = q.y - H0.cy; return { u: dx * cs + dy * sn, v: -dx * sn + dy * cs }; };
      const sgn = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]][hit], q = loc(p);
      let l = -a0.w / 2, r = a0.w / 2, t = -a0.h / 2, b = a0.h / 2;
      if (sgn[0] < 0) l = Math.min(q.u, r - 1); if (sgn[0] > 0) r = Math.max(q.u, l + 1);
      if (sgn[1] < 0) t = Math.min(q.v, b - 1); if (sgn[1] > 0) b = Math.max(q.v, t + 1);
      if (e.altKey) { if (sgn[0]) { const hw = Math.max(Math.abs(l), Math.abs(r)); l = -hw; r = hw; } if (sgn[1]) { const hh = Math.max(Math.abs(t), Math.abs(b)); t = -hh; b = hh; } }
      let w = r - l, h = b - t;
      const keep = state.arrFixed !== e.shiftKey && sgn[0] && sgn[1];
      if (keep) { const k = Math.max(w / a0.w, h / a0.h); w = a0.w * k; h = a0.h * k; if (sgn[0] < 0) l = r - w; else r = l + w; if (sgn[1] < 0) t = b - h; else b = t + h; if (e.altKey) { l = -w / 2; r = w / 2; t = -h / 2; b = h / 2; } }
      const mu = (l + r) / 2, mv = (t + b) / 2;
      a.w = Math.max(1, Math.round(w)); a.h = Math.max(1, Math.round(h));
      a.x = Math.round(H0.cx + mu * cs - mv * sn - a.w / 2); a.y = Math.round(H0.cy + mu * sn + mv * cs - a.h / 2);
      if (snapOn(e) && !a0.angle && !keep && !e.altKey) op.snapLines = snapEdges(a, sgn, op.arr.snap); // only unrotated, free resizes snap
    }
    renderArr(op); syncArrInputs(); drawOverlay();
  },
  up(p) {
    if (op?.gmove) {
      const o = op; op = null; if (!o.moved) return;
      for (const m of o.mem) if (m.live) { const url = m.live.toDataURL(); maskCache.set(url, m.live); m.l.vec = clone(m.vec); m.l.vec.mask = url; m.l.vec.bb = contentBounds({ ctx: m.live.getContext('2d') }) || [0, 0, W, H]; renderFill(m.l); }
      pushHistory({ t: 'st', label: o.label, before: o.struct, after: snapStruct() }); rebuildLayers(); arr = null; drawOverlay(); return;
    }
    if (!op || !op.arr) return; const h = op.arr.hit, a0 = op.arr.a0, a = arr, o = op; op = null;
    if (a.x === a0.x && a.y === a0.y && a.w === a0.w && a.h === a0.h && a.angle === a0.angle) { restoreOp(o); requestRender(); return; }
    arrCommit(o, h === 'move' ? 'Move' : h === 'rot' ? 'Rotate layer' : 'Transform');
  },
  hover(p) { const d = doc(); if (d.noSel || moveSet()) { stack.style.cursor = ''; return; } const a = ensureArr(); stack.style.cursor = a.empty ? '' : arrInside(p) || arrHit(p) !== 'move' ? (arrCursor[arrHit(p)] || 'move') : ''; },
};
function nudge(dx, dy) {
  const mem = moveSet();
  if (!mem) { arrApply('Nudge', a => { a.x += dx; a.y += dy; }); return; }
  if (mem.some(l => l.locked)) { toast('One of the selected layers is locked'); return; }
  const p = { x: 0, y: 0 }; beginGroupMove(mem, p); arrangeTool.move({ x: dx, y: dy }, { ctrlKey: true }); arrangeTool.up(p); // ctrl: nudges don't snap
}
let arrInputs = [];
function syncArrInputs() { arrInputs.forEach(i => i.sync()); }

// ===== text (classic, editable layers come next)
let textPos = null;
function drawTextPreview() {
  if (!op || !textPos) return;
  const txt = $('#textInput').value; shX.clearRect(0, 0, W, H);
  shX.fillStyle = state.fg; shX.textBaseline = 'top'; shX.font = `${state.bold ? 'bold ' : ''}${state.fontSize}px "${state.font}"`;
  txt.split('\n').forEach((line, i) => shX.fillText(line, textPos.x, textPos.y + i * state.fontSize * 1.15));
  compositeOnto(op, shapeC, { alpha: state.opacity });
}
const textTool = {
  down(p) {
    if (op) return; op = beginOp(); if (!op) return;
    textPos = { x: Math.round(p.x), y: Math.round(p.y) };
    $('#textInput').value = ''; $('#textModal').hidden = false; setTimeout(() => $('#textInput').focus(), 0);
  },
};
function finishText(ok) {
  $('#textModal').hidden = true; if (!op) return;
  if (ok && $('#textInput').value.trim()) { drawTextPreview(); addRecent(state.fg); commitOp(op); op = null; } else cancelOp();
  textPos = null;
}
$('#textInput').addEventListener('input', drawTextPreview);
$('#textInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishText(true); } if (e.key === 'Escape') finishText(false); });
$('#textOk').onclick = () => finishText(true);
$('#textCancel').onclick = () => finishText(false);

const tools = {
  move: arrangeTool, select: marqueeTool, lasso: lassoTool, wand: wandTool,
  brush: brushTool, eraser: brushTool, pencil: pencilTool,
  rect: shapeTool, ellipse: shapeTool, line: shapeTool, gradient: shapeTool,
  fill: { down: floodFill }, eyedropper: { down: pickColor }, text: textTool, hand: {}, zoom: {},
};

// ===== snapping (moving and resizing): edges and centres of the canvas, other layers, and the template's faces
const SNAP_PX = 6; // how close (in screen pixels) before something snaps
const COALESCE_TOOLS = new Set(['brush', 'eraser', 'pencil', 'lasso']);
const VEC_PLACE = new Set(['x', 'y', 'angle', 'flipX', 'flipY', 'w', 'h', '_ox', '_oy']); // where text sits, not what it looks like (text cache key)
const snapOn = (e) => state.snap && !(e?.ctrlKey || e?.metaKey);
// axis-aligned box around a (possibly rotated) arrange box
function aabbOf(a) { const c = arrHandles(a).corners, xs = c.map(q => q.x), ys = c.map(q => q.y), x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; }
function layerBounds(l) {
  const v = l.vec;
  if (v?.type === 'path') { const b = pathBBox(allPts(v)); return [b.x, b.y, b.w, b.h]; }
  if (v && v.type !== 'fill') { const b = aabbOf({ x: v.x, y: v.y, w: v.w, h: v.h, angle: v.angle || 0 }); return [b.x, b.y, b.w, b.h]; }
  return contentBounds(l);
}
function snapTargets(skipIds) {
  const xs = [0, W / 2, W], ys = [0, H / 2, H];
  const add = (b) => { if (!b) return; xs.push(b[0], b[0] + b[2] / 2, b[0] + b[2]); ys.push(b[1], b[1] + b[3] / 2, b[1] + b[3]); };
  if (isTemplate()) for (const r of regionsFor(state.mode)) if (r.face) add(r.rects[0]);
  const fx = xs.length, fy = ys.length; // targets before these indexes are fixed (canvas, template faces); after are other layers
  for (const l of doc().layers.slice(-40)) if (!skipIds.has(l.id) && layerVisible(l)) add(layerBounds(l));
  return { xs, ys, fx, fy };
}
// the closest target to any of vals, if within thr: { d: how far to shift, t: the target, i: its index }. Ties keep the fixed target
function snapAxis(vals, targets, thr) { let best = null; for (const v of vals) targets.forEach((t, i) => { const d = t - v; if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t, i }; }); return best; }
// shift needed so a box's left/centre/right and top/middle/bottom land on targets, plus the guide lines to show
function snapBox(x, y, w, h, T, e) {
  if (!snapOn(e) || !T) return { dx: 0, dy: 0, lines: null };
  const thr = SNAP_PX / state.zoom, sx = snapAxis([x, x + w / 2, x + w], T.xs, thr), sy = snapAxis([y, y + h / 2, y + h], T.ys, thr);
  return { dx: sx ? Math.round(sx.d) : 0, dy: sy ? Math.round(sy.d) : 0, lines: sx || sy ? { x: sx?.t, y: sy?.t, ox: sx?.i >= T.fx, oy: sy?.i >= T.fy } : null };
}
// resizing: snap the edges being dragged (sgn says which), keeping whole pixels
function snapEdges(a, sgn, T) {
  const thr = SNAP_PX / state.zoom, L = {};
  if (sgn[0] < 0) { const s = snapAxis([a.x], T.xs, thr); if (s) { const t = Math.round(s.t); a.w += a.x - t; a.x = t; L.x = s.t; L.ox = s.i >= T.fx; } }
  if (sgn[0] > 0) { const s = snapAxis([a.x + a.w], T.xs, thr); if (s) { a.w = Math.round(s.t) - a.x; L.x = s.t; L.ox = s.i >= T.fx; } }
  if (sgn[1] < 0) { const s = snapAxis([a.y], T.ys, thr); if (s) { const t = Math.round(s.t); a.h += a.y - t; a.y = t; L.y = s.t; L.oy = s.i >= T.fy; } }
  if (sgn[1] > 0) { const s = snapAxis([a.y + a.h], T.ys, thr); if (s) { a.h = Math.round(s.t) - a.y; L.y = s.t; L.oy = s.i >= T.fy; } }
  a.w = Math.max(1, a.w); a.h = Math.max(1, a.h);
  return 'x' in L || 'y' in L ? L : null;
}
function drawArrBox(o) {
  const a = ensureArr(); if (a.empty) return;
  const H_ = arrHandles(a), c = H_.corners, s = 4 / state.zoom;
  o.lineWidth = 1.2 / state.zoom; o.strokeStyle = '#0099cc'; o.beginPath(); [0, 2, 4, 6].forEach((i, k) => k ? o.lineTo(c[i].x, c[i].y) : o.moveTo(c[i].x, c[i].y)); o.closePath(); o.stroke();
  o.beginPath(); o.moveTo(c[1].x, c[1].y); o.lineTo(H_.rot.x, H_.rot.y); o.stroke();
  o.fillStyle = '#fff'; for (const q of c) { o.fillRect(q.x - s, q.y - s, s * 2, s * 2); o.strokeRect(q.x - s, q.y - s, s * 2, s * 2); }
  o.beginPath(); o.arc(H_.rot.x, H_.rot.y, s * 1.2, 0, Math.PI * 2); o.fill(); o.stroke();
}

// ===== the Shape (design mode) and Text tools move, resize and rotate shapes/text directly, like the Move tool
function vecLayerAt(p, type) {
  for (const l of [...doc().layers].reverse()) {
    if (l.vec?.type !== type || !layerVisible(l)) continue; const v = l.vec, cx = v.x + v.w / 2, cy = v.y + v.h / 2, a = -(v.angle || 0);
    const u = (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a), w_ = (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a);
    if (Math.abs(u) <= v.w / 2 + 3 && Math.abs(w_) <= v.h / 2 + 3) return l;
  }
  return null;
}
// is p on the selected shape/text's box or one of its handles?
function onVecBox(p, type) { const d = doc(), l = activeLayer(); if (d.noSel || d.activeGroup || l?.vec?.type !== type) return false; const a = ensureArr(); return !a.empty && (arrHit(p) !== 'move' || arrInside(p)); }
function grabVec(p, e, l) { if (l !== activeLayer() || doc().noSel) selectLayer(l); arrangeTool.down(p, e); if (op) op.viaArr = true; return !!op; }
const vecCursor = (p, type) => onVecBox(p, type) ? (arrCursor[arrHit(p)] || 'move') : '';
// Move tool: double-click text to edit it
arrangeTool.dbl = (p) => { const l = vecLayerAt(p, 'text'); if (!l) return; selectLayer(l); setTool('text'); startTextEdit(l, false); };

// painting/adjusting needs pixels: ask before turning editable text, shapes or fills into a plain layer
const PAINT_TOOLS = new Set(['brush', 'pencil', 'gradient', 'shape']);
function askRasterize(l) {
  if (document.querySelector('.rasterize-ask')) return;
  const what = { text: 'text', shape: 'shape', path: 'path', fill: 'colour fill' }[l.vec.type] || 'layer';
  if (PAINT_TOOLS.has(state.tool)) { // painting over text/shapes: offer a fresh layer on top (keeps them editable)
    const b = el('div', 'confirm-body rasterize-ask');
    b.textContent = `“${l.name}” is an editable ${what}, so it can't be painted on. Paint on a new layer above it instead?`;
    dlg('Paint on a new layer?', b, { okLabel: 'New layer', onOk: () => { $('#lyAdd').click(); toast('New layer added - paint away'); },
      extra: [{ label: 'Rasterize instead', run: () => { flushVecEdit(); endTextEdit(); structOp(() => { delete l.vec; l.kind = 'Layer'; }, 'Rasterize layer'); buildOptions(); } }] });
    return;
  }
  const b = el('div', 'confirm-body rasterize-ask');
  b.textContent = `“${l.name}” is an editable ${what}. To paint on it or change its pixels it has to become a plain image layer, and it can't be edited as ${what} after that.`;
  dlg('Rasterize layer?', b, { okLabel: 'Rasterize', onOk: () => { flushVecEdit(); endTextEdit(); structOp(() => { delete l.vec; l.kind = 'Layer'; }, 'Rasterize layer'); buildOptions(); toast(`“${l.name}” is now a plain layer - you can paint on it`); } });
}

// ===== overlay for tools (cursor, marquee preview, ants, arrange box)
function drawToolOverlay(o) {
  if (selPath) {
    o.lineWidth = 1 / OS; o.setLineDash([]); o.strokeStyle = 'rgba(255,255,255,.95)'; o.stroke(selPath);
    o.setLineDash([dpx(4), dpx(4)]); o.lineDashOffset = -antsOffset * dpx(1); o.strokeStyle = '#000'; o.stroke(selPath); o.setLineDash([]); o.lineDashOffset = 0;
  }
  if (selPreview) {
    o.beginPath(); selPreview(o); if (state.tool === 'lasso' && state.lassoType !== 'poly') o.closePath();
    o.lineWidth = 1 / OS; o.setLineDash([]); o.strokeStyle = '#fff'; o.stroke(); o.setLineDash([dpx(4), dpx(4)]); o.strokeStyle = '#000'; o.stroke(); o.setLineDash([]);
    if (lasso && state.lassoType === 'poly') { const f = lasso.pts[0]; o.fillStyle = '#fff'; o.strokeStyle = '#000'; o.beginPath(); o.arc(f.x, f.y, 3 / state.zoom, 0, Math.PI * 2); o.fill(); o.stroke(); }
  }
  drawPenOverlay(o);
  if (state.tool === 'move' && moveSet()) {
    const b = unionBounds(moveSet()); if (b) { o.lineWidth = 1.2 / state.zoom; o.strokeStyle = '#0099cc'; o.setLineDash([5 / state.zoom, 3 / state.zoom]); o.strokeRect(b[0], b[1], b[2], b[3]); o.setLineDash([]); }
  } else if (state.tool === 'move' && !doc().noSel) drawArrBox(o);
  const vt = state.tool === 'text' || state.tool === 'shape' ? activeLayer()?.vec?.type : null;
  if ((state.tool === 'text' || state.tool === 'shape') && vt === state.tool && !doc().noSel && !(op && !op.viaArr) && !(vt === 'shape' && state.shape.mode === 'draw') && !(vt === 'text' && textEdit)) drawArrBox(o); // while typing: outline only
  else if ((state.tool === 'text' || state.tool === 'shape') && activeLayer()?.vec && !doc().noSel && activeLayer().vec.type !== 'fill') {
    const v = activeLayer().vec, cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    o.save(); o.translate(cx, cy); o.rotate(v.angle || 0); o.lineWidth = 1 / state.zoom; o.strokeStyle = textEdit ? '#0099cc' : 'rgba(0,153,204,.7)'; o.setLineDash(textEdit ? [] : [4 / state.zoom, 3 / state.zoom]); o.strokeRect(-v.w / 2 - 2, -v.h / 2 - 2, v.w + 4, v.h + 4); o.restore(); o.setLineDash([]);
  }
  if (op?.snapLines) { // guides showing what a move/resize snapped to: pink = canvas/template, green = another layer
    const L = op.snapLines; o.save(); o.lineWidth = 1 / state.zoom; o.setLineDash([]);
    const line = (obj, x0, y0, x1, y1) => { o.strokeStyle = obj ? '#22d36b' : '#ff4fa3'; o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.stroke(); };
    if (L.x != null) line(L.ox, L.x, 0, L.x, H); if (L.y != null) line(L.oy, 0, L.y, W, L.y);
    o.restore();
  }
  const hp = roll?.moved ? roll.last : hover;
  if (hp && ['brush', 'eraser', 'pencil'].includes(state.tool)) {
    o.lineWidth = 1 / OS;
    for (const [col, off] of [['rgba(0,0,0,.8)', 0], ['rgba(255,255,255,.9)', 1 / OS]]) {
      o.strokeStyle = col; o.beginPath();
      if (state.tool === 'pencil') { const s = state.pencilSize, x0 = Math.floor(hp.x) - Math.floor((s - 1) / 2), y0 = Math.floor(hp.y) - Math.floor((s - 1) / 2); o.rect(x0 - off, y0 - off, s + off * 2, s + off * 2); }
      else { const b = brushOf(), r = Math.max(b.size / 2 + off, .5); o.ellipse(hp.x, hp.y, r, Math.max(.5, r * b.round / 100), b.angle * Math.PI / 180, 0, Math.PI * 2); }
      o.stroke();
    }
  }
}

// ===== brush popover
const PRESET_SIZES = [[1, 5, 10, 15, 20, 30, 50, 70, 100, 200, 400, 500], [5, 10, 20, 30, 40, 50, 70, 100, 150, 200, 400, 500], [5, 10, 20, 30, 40, 50, 70, 100, 150, 200, 400, 500]];
const PRESET_SOFT = [0, 50, 100];
function brushButton() {
  const b = brushOf(), btn = el('button', 'ob-brush');
  const prev = mkCanvas(26, 26); prev.className = 'ob-brush-tip';
  const num = el('span', 'ob-brush-size'); const caret = el('span', 'ob-caret', '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg>');
  btn.append(prev, num, caret);
  const sync = () => { const x = prev.getContext('2d'); x.clearRect(0, 0, 26, 26); const t = makeTip({ ...b, round: b.round }, Math.min(22, Math.max(3, b.size)), false); x.drawImage(t, 13 - t.width / 2, 13 - t.height / 2); num.textContent = b.size; };
  sync(); btn.sync = sync;
  btn.onclick = () => openPop(btn, brushPanel(b, sync), { width: 470 });
  return btn;
}
function brushPanel(b, onChange) {
  const p = el('div', 'bp');
  const ch = () => { onChange(); drawPrev(); drawStroke(); drawWheel(); drawOverlay(); };
  const s1 = el('div', 'bp-card');
  const size = slider('Size', 1, 500, b.size, 'px'), soft = slider('Softness', 0, 100, b.soft, '%');
  size.addEventListener('change', () => { b.size = size.value(); ch(); }); soft.addEventListener('change', () => { b.soft = soft.value(); ch(); });
  s1.append(size, soft);
  const tipBox = el('div', 'bp-card bp-check'), tipC = mkCanvas(110, 92); tipBox.append(tipC);
  const wheelBox = el('div', 'bp-card bp-wheel'), wheel = mkCanvas(110, 92), angLbl = el('span', 'bp-ang'); wheelBox.append(wheel, angLbl);
  const s2 = el('div', 'bp-card'); const step = slider('Step', 1, 200, b.step, '%'); step.addEventListener('change', () => { b.step = step.value(); ch(); }); s2.append(step);
  const strokeBox = el('div', 'bp-card bp-check bp-wide'), strokeC2 = mkCanvas(220, 70); strokeBox.append(strokeC2);
  const head = el('button', 'bp-head', '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg> Basic Circular');
  const grid = el('div', 'bp-grid');
  head.onclick = () => { grid.hidden = !grid.hidden; head.classList.toggle('closed', grid.hidden); };
  PRESET_SIZES.forEach((row, ri) => row.forEach(sz => {
    const c = el('button', 'bp-preset'), cv = mkCanvas(30, 30), lab = el('span'); lab.textContent = sz;
    const t = makeTip({ soft: PRESET_SOFT[ri], angle: 0, round: 100 }, Math.min(26, 3 + Math.sqrt(sz) * 1.6), false), x = cv.getContext('2d');
    x.drawImage(tintedTip(t, '#cfcfcf'), 15 - t.width / 2, 15 - t.height / 2);
    c.append(cv, lab); c.onclick = () => { b.size = sz; b.soft = PRESET_SOFT[ri]; size.set(sz); soft.set(b.soft); ch(); };
    grid.append(c);
  }));
  p.append(s1, tipBox, wheelBox, s2, strokeBox, head, grid);
  function drawPrev() { const x = tipC.getContext('2d'); x.clearRect(0, 0, 110, 92); const sz = Math.min(80, b.size), t = tintedTip(makeTip(b, sz, b.hard), '#fff'); x.drawImage(t, 55 - t.width / 2, 46 - t.height / 2); }
  function drawStroke() {
    const x = strokeC2.getContext('2d'); x.clearRect(0, 0, 220, 70); const sz = Math.max(2, Math.min(26, b.size)), t = tintedTip(makeTip(b, sz, b.hard), '#fff'), sp = Math.max(.5, sz * Math.max(1, b.step) / 100);
    for (let u = 0; u <= 1; u += sp / 230) { const px = 18 + u * 184, py = 35 + Math.sin(u * Math.PI * 2) * 15; x.globalAlpha = b.flow / 100; x.drawImage(t, px - t.width / 2, py - t.height / 2); }
    x.globalAlpha = 1;
  }
  function drawWheel() {
    const x = wheel.getContext('2d'); x.clearRect(0, 0, 110, 92); const cx = 55, cy = 46, R = 36, a = b.angle * Math.PI / 180, ry = R * b.round / 100;
    x.strokeStyle = '#bdbdbd'; x.lineWidth = 2; x.beginPath(); x.ellipse(cx, cy, R, Math.max(2, ry), a, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 1; x.beginPath(); x.moveTo(cx - R * Math.cos(a), cy - R * Math.sin(a)); x.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a)); x.stroke();
    x.fillStyle = '#bdbdbd'; for (const s of [-1, 1]) { x.beginPath(); x.arc(cx - s * ry * Math.sin(a), cy + s * ry * Math.cos(a), 4, 0, Math.PI * 2); x.fill(); }
    x.beginPath(); x.moveTo(cx + R + 6, cy - 5); x.lineTo(cx + R + 11, cy); x.lineTo(cx + R + 6, cy + 5); x.fill();
    angLbl.textContent = Math.round(b.angle) + '°';
  }
  let wdrag = false;
  const wset = (e) => { const r = wheel.getBoundingClientRect(), dx = e.clientX - r.left - 55, dy = e.clientY - r.top - 46; b.angle = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 180); b.round = Math.round(Math.max(10, Math.min(100, Math.hypot(dx, dy) / 36 * 100))); ch(); };
  wheel.onpointerdown = (e) => { wdrag = true; wheel.setPointerCapture(e.pointerId); wset(e); };
  wheel.onpointermove = (e) => { if (wdrag) wset(e); };
  wheel.onpointerup = () => { wdrag = false; };
  wheel.ondblclick = () => { b.angle = 0; b.round = 100; ch(); };
  drawPrev(); drawStroke(); drawWheel();
  return p;
}

// ===== options bar per tool
const optLeft = $('#optLeft');
function toolIcon(t) { const b = $(`#toolbar [data-tool="${t}"]`); return el('span', 'ob-toolicon', b ? b.innerHTML : ''); }
function pct(obj, key) { return obNum(() => obj[key], v => { obj[key] = v; }, { min: 1, max: 100, suffix: '%' }); }
function buildOptions() {
  closePop(); optLeft.innerHTML = ''; arrInputs = [];
  const t = state.tool, add = (...x) => optLeft.append(...x);
  add(toolIcon(t));
  const modeSeg = () => [obLabel('Mode:'), obSeg([{ v: 'new', icon: ICONS.modeNew, title: 'New selection' }, { v: 'add', icon: ICONS.modeAdd, title: 'Add to selection (Shift)' }, { v: 'sub', icon: ICONS.modeSub, title: 'Subtract from selection (Alt)' }], () => state.selMode, v => { state.selMode = v; })];
  const featherAA = () => [obLabel('Feather:'), obNum(() => state.feather, v => { state.feather = v; }, { min: 0, max: 100 }), obToggle('Anti-alias', () => state.antialias, v => { state.antialias = v; })];
  if (t === 'move') {
    const a = () => ensureArr();
    const pos = (k) => obInput(k.toUpperCase(), () => a().empty ? 0 : a()[k], v => arrApply('Move', s => { s[k] = v; }));
    const size = (k) => obInput(k.toUpperCase(), () => a().empty ? 0 : a()[k], v => arrApply('Transform', s => {
      v = Math.max(1, v); const cx = s.x + s.w / 2, cy = s.y + s.h / 2; // keeps its centre where it was
      if (state.arrFixed) { const r = k === 'w' ? v / s.w : v / s.h; s.w = Math.max(1, Math.round(s.w * r)); s.h = Math.max(1, Math.round(s.h * r)); } else s[k] = v;
      s.x = Math.round(cx - s.w / 2); s.y = Math.round(cy - s.h / 2);
    }));
    const X = pos('x'), Y = pos('y'), Wd = size('w'), Hd = size('h'); arrInputs.push(X, Y, Wd, Hd);
    const lock = obBtn(state.arrFixed ? ICONS.lock : ICONS.unlock, 'Keep proportions', () => { state.arrFixed = !state.arrFixed; buildOptions(); });
    lock.classList.add('ob-lock');
    const snapT = obToggle('Snap', () => state.snap, v => { state.snap = v; }); snapT.title = 'Snap to edges and centres while moving or resizing (hold Ctrl to skip)'; add(snapT);
    add(obLabel('Aspect:'), obSeg([{ v: 'true', text: 'Fixed' }, { v: 'false', text: 'Free' }], () => String(state.arrFixed), v => { state.arrFixed = v === 'true'; buildOptions(); }),
      obLabel('Pos:'), X, Y, obLabel('Size:'), Wd, lock, Hd,
      el('span', 'ob-gap'),
      obBtn(ICONS.rotL, 'Rotate left 90°', () => arrApply('Rotate left', s => { s.angle -= Math.PI / 2; })),
      obBtn(ICONS.rotR, 'Rotate right 90°', () => arrApply('Rotate right', s => { s.angle += Math.PI / 2; })),
      obBtn(ICONS.flipH, 'Flip horizontal', () => arrApply('Flip horizontal', s => { s.flipX = !s.flipX; })),
      obBtn(ICONS.flipV, 'Flip vertical', () => arrApply('Flip vertical', s => { s.flipY = !s.flipY; })),
      el('span', 'ob-gap'),
      obBtn(ICONS.dup, 'Duplicate layer (Ctrl+D)', () => $('#lyDup').click()),
      obBtn(ICONS.del, 'Delete layer (Delete)', () => $('#lyDel').click()));
  } else if (t === 'select') {
    add(obLabel('Type:'), obSeg([{ v: 'rect', icon: ICONS.rect, title: 'Rectangle' }, { v: 'ellipse', icon: ICONS.ellipse, title: 'Ellipse' }], () => state.selType, v => { state.selType = v; }), ...modeSeg(), ...featherAA());
  } else if (t === 'lasso') {
    add(obLabel('Type:'), obSeg([{ v: 'free', icon: ICONS.lassoFree, title: 'Free lasso' }, { v: 'poly', icon: ICONS.lassoPoly, title: 'Polygon lasso - click points, click the first point or double-click to close' }, { v: 'mag', icon: ICONS.lassoMag, title: 'Magnetic lasso - snaps to edges' }], () => state.lassoType, v => { state.lassoType = v; lasso = null; selPreview = null; drawOverlay(); }),
      ...modeSeg(), obLabel('Size:'), obNum(() => state.lassoSize, v => { state.lassoSize = v; }, { min: 4, max: 100 }), ...featherAA());
  } else if (t === 'wand') {
    add(...modeSeg(), obLabel('Tolerance:'), obNum(() => state.wandTol, v => { state.wandTol = v; }, { min: 0, max: 255 }), ...featherAA(),
      obToggle('Contiguous', () => state.contiguous, v => { state.contiguous = v; }), obToggle('Sample all layers', () => state.wandSampleAll, v => { state.wandSampleAll = v; }));
  } else if (t === 'brush' || t === 'eraser') {
    const b = brushOf();
    add(obLabel('Brush:'), brushButton(), obLabel('Opacity:'), pct(b, 'opacity'), obLabel('Flow:'), pct(b, 'flow'));
    if (t === 'brush') {
      const m = el('select', 'ob-select'); for (const [v, l] of [['none', 'None'], ['h', 'Horizontal'], ['v', 'Vertical'], ['both', 'Both']]) { const o = el('option'); o.value = v; o.textContent = l; m.append(o); }
      m.value = b.mirror; m.onchange = () => { b.mirror = m.value; }; m.title = 'Mirror strokes across the middle of the template';
      add(obLabel('Mirror:'), m, obToggle('Scatter', () => b.scatter, v => { b.scatter = v; }));
    }
    add(obToggle('Hard tip', () => b.hard, v => { b.hard = v; drawOverlay(); }), obToggle('Pen pressure', () => b.pressure, v => { b.pressure = v; }));
  } else if (t === 'pencil') {
    add(obLabel('Size:'), obNum(() => state.pencilSize, v => { state.pencilSize = v; drawOverlay(); }, { min: 1, max: 100, suffix: 'px' }), obLabel('Opacity:'), obNum(() => Math.round(state.opacity * 100), v => { state.opacity = v / 100; }, { min: 1, max: 100, suffix: '%' }));
  } else if (t === 'fill') {
    add(obLabel('Opacity:'), obNum(() => Math.round(state.opacity * 100), v => { state.opacity = v / 100; }, { min: 1, max: 100, suffix: '%' }), obLabel('Tolerance:'), obNum(() => state.tolerance, v => { state.tolerance = v; }, { min: 0, max: 255 }),
      obToggle('Sample all layers', () => state.sampleAll, v => { state.sampleAll = v; }), el('span', 'ob-hint', 'Shift+click fills the whole selection (or template)'));
  } else if (t === 'gradient') {
    add(obLabel('Opacity:'), obNum(() => Math.round(state.opacity * 100), v => { state.opacity = v / 100; }, { min: 1, max: 100, suffix: '%' }), obToggle('Fade to transparent', () => state.gradTransparent, v => { state.gradTransparent = v; }));
  } else if (t === 'rect' || t === 'ellipse' || t === 'line') {
    add(obLabel(t === 'line' ? 'Width:' : 'Stroke:'), obNum(() => state.size, v => { state.size = v; }, { min: 1, max: 100, suffix: 'px' }), obLabel('Opacity:'), obNum(() => Math.round(state.opacity * 100), v => { state.opacity = v / 100; }, { min: 1, max: 100, suffix: '%' }));
    if (t !== 'line') add(obToggle('Filled', () => state.fillShape, v => { state.fillShape = v; }));
    add(el('span', 'ob-hint', t === 'line' ? 'Shift snaps to 45°' : 'Shift keeps it square / round'));
  } else if (t === 'text') { textOptions(add);
  } else if (t === 'shape') { shapeOptions(add);
  } else if (t === 'pen') { penOptions(add);
  } else if (t === 'eyedropper') add(el('span', 'ob-hint', 'Click to pick a colour (Alt+click works with most tools)'));
  else if (t === 'hand') add(el('span', 'ob-hint', 'Drag to pan the canvas'));
  else if (t === 'zoom') add(el('span', 'ob-hint', 'Click to zoom in · Alt+click to zoom out · Scroll to zoom anywhere'));
}

function setTool(t) {
  if (t !== state.tool && penDraw) finishPath();
  if (t !== state.tool) { penSel = penSub = -1; if (lasso) { lasso = null; selPreview = null; } if (t !== 'text') endTextEdit(); flushVecEdit(); }
  state.tool = t;
  $$('#toolbar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  for (const k of ['move', 'hand', 'zoom']) stack.classList.toggle('tool-' + k, t === k);
  stack.style.cursor = '';
  buildOptions(); drawOverlay();
}
$$('#toolbar [data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
function setSize(v) {
  if (state.tool === 'brush' || state.tool === 'eraser') brushOf().size = Math.max(1, Math.min(500, v));
  else if (state.tool === 'pencil') state.pencilSize = Math.max(1, Math.min(100, v));
  else state.size = Math.max(1, Math.min(100, v));
  buildOptions(); drawOverlay();
}
function curSize() { return state.tool === 'brush' || state.tool === 'eraser' ? brushOf().size : state.tool === 'pencil' ? state.pencilSize : state.size; }

// ------------------------------------------------------------------ pointer input
function toPt(e) { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }; }
let spaceDown = false, pan = null, pointerDown = false;
scroller.addEventListener('pointerdown', e => {
  if (!$('#textModal').hidden || e.target.closest('.text-edit')) return;
  const dlgOpen = !!document.querySelector('.dlg-wrap');
  if (pickOnce && e.button === 0) { const p0 = toPt(e); compositeDoc(doc()); const px = doc().comp.getContext('2d').getImageData(Math.floor(p0.x), Math.floor(p0.y), 1, 1).data; if (px[3]) pickOnce(toHex(px[0], px[1], px[2])); pickOnce = null; stack.classList.remove('picking'); return; }
  scroller.setPointerCapture(e.pointerId);
  if (state.tool === 'zoom' && e.button === 0) { setZoom(state.zoom * (e.altKey ? 1 / 1.25 : 1.25), { x: e.clientX, y: e.clientY }); return; }
  if (e.button === 1 || spaceDown || state.tool === 'hand') { pan = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop }; stack.classList.add('panning'); return; }
  if (e.button !== 0 || dlgOpen) return;
  if (e.target === otherView) { setMode(state.mode === 'shirt' ? 'pants' : 'shirt'); return; }
  const p = toPt(e), outside = p.x < 0 || p.y < 0 || p.x >= W || p.y >= H;
  if (outside && ['text', 'fill', 'eyedropper', 'gradient', 'brush', 'eraser', 'pencil'].includes(state.tool)) { if (textEdit) endTextEdit(); return; }
  if (e.altKey && ['brush', 'pencil', 'fill', 'rect', 'ellipse', 'line', 'gradient', 'text'].includes(state.tool)) { pickColor(p); return; }
  if (e.detail === 2 && tools[state.tool].dbl) { tools[state.tool].dbl(p, e); return; }
  pointerDown = true; rollStart(p);
  tools[state.tool].down?.(p, e);
});
scroller.addEventListener('pointermove', e => {
  if (pan) { scroller.scrollLeft = pan.sl - (e.clientX - pan.x); scroller.scrollTop = pan.st - (e.clientY - pan.y); return; }
  if (!pointerDown && e.target === otherView) { hover = null; stack.style.cursor = ''; drawOverlay(); return; }
  const p = toPt(e); hover = p;
  const rg = regionAt(p.x, p.y, state.mode);
  $('#stPos').textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
  $('#stRegion').textContent = rg ? rg.label : '';
  if (pointerDown) {
    // painting needs every in-between point; moving/resizing only needs the latest one (keeps dragging text smooth)
    const evs = COALESCE_TOOLS.has(state.tool) && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of (evs.length ? evs : [e])) rollMove(toPt(ce), ce.pointerType ? ce : e);
  } else tools[state.tool].hover?.(p, e);
  drawOverlay();
});
function endPointer(e) {
  if (pan) { pan = null; stack.classList.remove('panning'); return; }
  if (!pointerDown) return; pointerDown = false;
  tools[state.tool].up?.(toPt(e), e); roll = null;
}
scroller.addEventListener('pointerup', endPointer);
scroller.addEventListener('pointercancel', endPointer);
scroller.addEventListener('pointerleave', () => { hover = null; drawOverlay(); $('#stPos').textContent = '-'; $('#stRegion').textContent = ''; });

// ------------------------------------------------------------------ editable vector layers (shapes + text), paints, fill dialog
const clone = (o) => o == null ? o : JSON.parse(JSON.stringify(o));

// ===== paints: {type:'none'} | {type:'color', color} | {type:'gradient', kind, angle, stops:[{pos,color,alpha}]} | {type:'pattern', id, color, scale, angle}
const PATTERNS = ['dots', 'bigdots', 'rings', 'plus', 'grid', 'checks', 'vstripes', 'hstripes', 'diag', 'zigzag', 'triangles', 'waves', 'hearts', 'stars', 'bricks', 'hex'];
const patCache = new Map();
function patternTile(id, color) {
  const key = id + color; if (patCache.has(key)) return patCache.get(key);
  const s = 16, c = mkCanvas(s, s), x = c.getContext('2d'); x.fillStyle = x.strokeStyle = color; x.lineWidth = 1.6; x.lineCap = 'round';
  const dot = (cx, cy, r) => { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); };
  switch (id) {
    case 'dots': dot(8, 8, 2); break;
    case 'bigdots': dot(8, 8, 4.5); break;
    case 'rings': x.beginPath(); x.arc(8, 8, 4.5, 0, Math.PI * 2); x.stroke(); break;
    case 'plus': x.beginPath(); x.moveTo(8, 4); x.lineTo(8, 12); x.moveTo(4, 8); x.lineTo(12, 8); x.stroke(); break;
    case 'grid': x.fillRect(0, 0, 16, 1.5); x.fillRect(0, 0, 1.5, 16); break;
    case 'checks': x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8); break;
    case 'vstripes': x.fillRect(0, 0, 6, 16); break;
    case 'hstripes': x.fillRect(0, 0, 16, 6); break;
    case 'diag': x.lineWidth = 3; x.beginPath(); x.moveTo(-4, 20); x.lineTo(20, -4); x.moveTo(-4, 4); x.lineTo(4, -4); x.moveTo(12, 20); x.lineTo(20, 12); x.stroke(); break;
    case 'zigzag': x.lineWidth = 2; x.beginPath(); x.moveTo(0, 10); x.lineTo(4, 6); x.lineTo(8, 10); x.lineTo(12, 6); x.lineTo(16, 10); x.stroke(); break;
    case 'triangles': x.beginPath(); x.moveTo(8, 3); x.lineTo(13, 12); x.lineTo(3, 12); x.fill(); break;
    case 'waves': x.lineWidth = 2; x.beginPath(); for (let i = 0; i <= 16; i++) x.lineTo(i, 8 + Math.sin(i / 16 * Math.PI * 2) * 3); x.stroke(); break;
    case 'hearts': x.beginPath(); x.moveTo(8, 13); x.bezierCurveTo(1, 8, 4, 2, 8, 6); x.bezierCurveTo(12, 2, 15, 8, 8, 13); x.fill(); break;
    case 'stars': x.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 2.4 : 6, a = -Math.PI / 2 + i * Math.PI / 5; x.lineTo(8 + Math.cos(a) * r, 8 + Math.sin(a) * r); } x.fill(); break;
    case 'bricks': x.fillRect(0, 0, 16, 1.5); x.fillRect(0, 8, 16, 1.5); x.fillRect(4, 0, 1.5, 8); x.fillRect(12, 8, 1.5, 8); break;
    case 'hex': x.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; x.lineTo(8 + Math.cos(a) * 5, 8 + Math.sin(a) * 5); } x.closePath(); x.stroke(); break;
  }
  patCache.set(key, c); return c;
}
const rgba = (hex, a = 1) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
function paintStyle(c, p, [x, y, w, h]) {
  if (!p || p.type === 'none') return 'rgba(0,0,0,0)';
  if (p.type === 'color') return p.color;
  if (p.type === 'gradient') {
    const cx = x + w / 2, cy = y + h / 2; let g;
    if (p.kind === 'radial') g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, Math.hypot(w, h) / 2));
    else { const a = (p.angle || 0) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), half = Math.abs(dx) * w / 2 + Math.abs(dy) * h / 2; g = c.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half); }
    for (const s of [...p.stops].sort((a, b) => a.pos - b.pos)) g.addColorStop(Math.max(0, Math.min(1, s.pos)), rgba(s.color, s.alpha ?? 1));
    return g;
  }
  if (p.type === 'pattern') {
    const pat = c.createPattern(patternTile(p.id, p.color || '#ffffff'), 'repeat'), k = (p.scale || 100) / 100;
    pat.setTransform(new DOMMatrix().translateSelf(x, y).rotateSelf(p.angle || 0).scaleSelf(k, k)); return pat;
  }
  return '#000';
}
function paintCSS(p) {
  if (!p || p.type === 'none') return 'linear-gradient(135deg, #fff 45%, #e33 46% 54%, #fff 55%)';
  if (p.type === 'color') return p.color;
  if (p.type === 'gradient') { const st = [...p.stops].sort((a, b) => a.pos - b.pos).map(s => `${rgba(s.color, s.alpha ?? 1)} ${Math.round(s.pos * 100)}%`).join(','); return p.kind === 'radial' ? `radial-gradient(circle, ${st})` : `linear-gradient(${(p.angle || 0) + 90}deg, ${st})`; }
  if (p.type === 'pattern') return `url(${patternTile(p.id, p.color || '#fff').toDataURL()}) #333`;
  return '#000';
}

// ===== colour picker widget (SV square + hue bar + hex + eyedropper)
function hsv2hex(h, s, v) { const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return toHex(Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)); }
function hex2hsv(hex) { const [r, g, b] = hexToRgb(hex).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, mx ? d / mx : 0, mx]; }
let pickOnce = null;
function colorPicker(hex, onChange) {
  let [h, s, v] = hex2hsv(hex);
  const w = el('div', 'cp');
  const sv = mkCanvas(300, 130); sv.className = 'cp-sv'; const svBox = el('div', 'cp-svbox'), ring = el('div', 'cp-ring'); svBox.append(sv, ring); const hue = mkCanvas(300, 16); hue.className = 'cp-hue';
  const row = el('div', 'cp-row'); const hexIn = el('input', 'cp-hex'); hexIn.value = hex; const drop = el('button', 'ob-icon', '<svg viewBox="0 0 24 24"><path d="M14 6l4 4"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L17 9l-2-2z"/><path d="M15 8l-9 9-1 3 3-1 9-9"/></svg>');
  drop.title = 'Pick a colour from the canvas'; row.append(hexIn, drop); w.append(svBox, hue, row);
  const draw = () => {
    const x = sv.getContext('2d'); x.fillStyle = hsv2hex(h, 1, 1); x.fillRect(0, 0, 300, 130);
    let g = x.createLinearGradient(0, 0, 300, 0); g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 300, 130);
    g = x.createLinearGradient(0, 0, 0, 130); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000'); x.fillStyle = g; x.fillRect(0, 0, 300, 130);
    ring.style.left = s * 100 + '%'; ring.style.top = (1 - v) * 100 + '%'; ring.style.borderColor = v > .5 ? '#000' : '#fff';
    const y = hue.getContext('2d'); g = y.createLinearGradient(0, 0, 300, 0); for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, hsv2hex(i * 60 % 360, 1, 1)); y.fillStyle = g; y.fillRect(0, 0, 300, 16);
    y.fillStyle = '#fff'; y.strokeStyle = '#000'; y.fillRect(h / 360 * 300 - 2, 0, 4, 16); y.strokeRect(h / 360 * 300 - 2, .5, 4, 15);
  };
  const emit = () => { const c = hsv2hex(h, s, v); hexIn.value = c; draw(); onChange(c); };
  const drag = (cv, fn) => { cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); fn(e); cv.onpointermove = fn; }; cv.onpointerup = () => { cv.onpointermove = null; }; };
  drag(sv, (e) => { const r = sv.getBoundingClientRect(); s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)); emit(); });
  drag(hue, (e) => { const r = hue.getBoundingClientRect(); h = Math.max(0, Math.min(359.9, (e.clientX - r.left) / r.width * 360)); emit(); });
  hexIn.onchange = () => { let t = hexIn.value.trim(); if (!t.startsWith('#')) t = '#' + t; if (/^#[0-9a-f]{3}$/i.test(t)) t = '#' + [...t.slice(1)].map(ch => ch + ch).join(''); if (/^#[0-9a-f]{6}$/i.test(t)) { [h, s, v] = hex2hsv(t.toLowerCase()); emit(); } else hexIn.value = hsv2hex(h, s, v); };
  hexIn.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') hexIn.blur(); };
  drop.onclick = () => { pickOnce = (c) => { [h, s, v] = hex2hsv(c); emit(); }; toast('Click the canvas to pick a colour'); stack.classList.add('picking'); };
  w.set = (c) => { [h, s, v] = hex2hsv(c); hexIn.value = c; draw(); };
  draw(); return w;
}
const SWATCHES = ['#260707', '#6b0b0b', '#5a0a10', '#4c0812', '#7a0a0a', '#110505', '#3d0a0a', '#0e2a4f', '#ffffff', '#8a8a8a', '#000000', '#d23c3c', '#ff8a00', '#ffd400', '#3fae5a', '#2f5bd8', '#7b3fd8', '#f06bb6'];
const GRAD_PRESETS = [
  [['#260707', 1], ['#6b0b0b', 1]], [['#000000', 1], ['#ffffff', 1]], [['#c9d6ff', 1], ['#0b1d4a', 1]], [['#000000', 1], ['#3a3a3a', 1]], [['#ffffff', 1], ['#7a7a7a', 1]],
  [['#3a6cf5', 1], ['#e2427d', .5], ['#f8d23a', 1]], [['#1a1aa8', 1], ['#c8a246', .5], ['#1a1aa8', 1]], [['#000000', 1], ['#ff0000', 1]], [['#ffffff', 1], ['#ff2020', 1]],
  [['#ffffff', 1], ['#00ff20', 1]], [['#ffffff', 1], ['#2020ff', 1]], [['#00e5ff', 1], ['#ff9d00', 1]], [['#c8f0b0', 1], ['#5ab0e8', 1]], [['#7a1a00', 1], ['#2a0a0a', 1]],
].map(st => ({ type: 'gradient', kind: 'linear', angle: 0, stops: st.map((s, i, a) => ({ pos: Array.isArray(s) && a.length === 3 && i === 1 ? .5 : i / (a.length - 1), color: s[0], alpha: 1 })) }));

let fillDlg = null;
function openFillDialog(initial, { title = 'Fill', colorOnly = false, allowNone = true } = {}, onChange, onDone) {
  if (fillDlg && document.body.contains(fillDlg.wrap)) { if (fillDlg.title === title) return; fillDlg.cancel(); }
  let p = clone(initial) || { type: 'color', color: state.fg };
  const lastColor = () => p.type === 'color' ? p.color : p.type === 'gradient' ? p.stops[0].color : p.type === 'pattern' ? p.color : state.fg;
  const body = el('div', 'fill-dlg');
  const tabs = el('div', 'ob-seg fill-tabs'); const pane = el('div', 'fill-pane');
  const emit = () => onChange(clone(p));
  const tab = (t) => { tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === t)); pane.innerHTML = ''; (t === 'color' ? colorPane : t === 'gradient' ? gradPane : patternPane)(); };
  if (!colorOnly) { for (const [v, l] of [['color', 'Color'], ['gradient', 'Gradient'], ['pattern', 'Pattern']]) { const b = el('button', 'ob-segbtn text'); b.textContent = l; b.dataset.v = v; b.onclick = () => tab(v); tabs.append(b); } body.append(tabs); }
  body.append(pane);
  const grid = (items, cls) => { const g = el('div', 'fill-grid ' + (cls || '')); items.forEach(it => g.append(it)); return g; };
  const noneBtn = (fn) => { const b = el('button', 'fill-sw none'); b.title = 'None'; b.onclick = fn; return b; };
  function colorPane() {
    const cur = p.type === 'color' ? p.color : lastColor();
    const cp = colorPicker(cur, (c) => { p = { type: 'color', color: c }; emit(); sw.forEach(x => x.classList.remove('on')); });
    const sw = SWATCHES.slice(0, allowNone ? 11 : 12).map(c => { const b = el('button', 'fill-sw'); b.style.background = c; b.onclick = () => { p = { type: 'color', color: c }; cp.set(c); emit(); sw.forEach(x => x.classList.toggle('on', x === b)); }; return b; });
    pane.append(cp, grid([...(allowNone ? [noneBtn(() => { p = { type: 'none' }; emit(); })] : []), ...sw]));
    if (state.recent.length) {
      const lab = el('div', 'fill-label'); lab.textContent = 'Recent';
      const rc = state.recent.map(c => { const b = el('button', 'fill-sw'); b.style.background = c; b.title = c; b.onclick = () => { p = { type: 'color', color: c }; cp.set(c); emit(); sw.forEach(x => x.classList.remove('on')); }; return b; });
      pane.append(lab, grid(rc));
    }
  }
  function gradPane() {
    if (p.type !== 'gradient') { const c = lastColor(); p = { type: 'gradient', kind: 'linear', angle: 0, stops: [{ pos: 0, color: c, alpha: 1 }, { pos: 1, color: '#ffffff', alpha: 1 }] }; emit(); }
    let sel = 0;
    const bar = el('div', 'gbar'); const barIn = el('div', 'gbar-in'); const stopsEl = el('div', 'gstops'); bar.append(barIn, stopsEl);
    const ctl = el('div', 'grow-ctl');
    const opN = obNum(() => Math.round((p.stops[sel]?.alpha ?? 1) * 100), v => { p.stops[sel].alpha = v / 100; redraw(); emit(); }, { min: 0, max: 100, suffix: '%' });
    const colIn = el('input'); colIn.type = 'color'; colIn.className = 'gcol';
    colIn.oninput = () => { p.stops[sel].color = colIn.value; redraw(); emit(); };
    const delB = el('button', 'ob-icon', ICONS.del); delB.title = 'Delete stop'; delB.onclick = () => { if (p.stops.length > 2) { p.stops.splice(sel, 1); sel = 0; redraw(); emit(); } };
    ctl.append(obLabel('Opacity:'), opN, obLabel('Color:'), colIn, delB);
    const kind = obSeg([{ v: 'linear', text: 'Linear' }, { v: 'radial', text: 'Radial' }], () => p.kind, v => { p.kind = v; redraw(); emit(); });
    const dir = obNum(() => p.angle || 0, v => { p.angle = v; redraw(); emit(); }, { min: 0, max: 359, suffix: '°' });
    const row2 = el('div', 'grow-ctl'); row2.append(kind, obLabel('Direction:'), dir);
    const presets = grid([...(allowNone ? [noneBtn(() => { p = { type: 'none' }; emit(); })] : []), ...GRAD_PRESETS.map(g => { const b = el('button', 'fill-sw'); b.style.background = paintCSS(g); b.onclick = () => { p = clone(g); sel = 0; redraw(); emit(); }; return b; })]);
    function redraw() {
      barIn.style.background = `${paintCSS({ ...p, kind: 'linear', angle: 0 })}, repeating-conic-gradient(#3a3a3a 0 25%, #2a2a2a 0 50%) 0 0/12px 12px`;
      stopsEl.innerHTML = '';
      p.stops.forEach((s, i) => {
        const m = el('div', 'gstop' + (i === sel ? ' on' : '')); m.style.left = (s.pos * 100) + '%'; m.style.setProperty('--c', s.color);
        m.onpointerdown = (e) => { e.stopPropagation(); sel = i; m.setPointerCapture(e.pointerId); const r = bar.getBoundingClientRect(); m.onpointermove = (ev) => { s.pos = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); m.style.left = (s.pos * 100) + '%'; barIn.style.background = `${paintCSS({ ...p, kind: 'linear', angle: 0 })}, repeating-conic-gradient(#3a3a3a 0 25%, #2a2a2a 0 50%) 0 0/12px 12px`; emit(); }; m.onpointerup = () => { m.onpointermove = null; redraw(); }; syncCtl(); stopsEl.querySelectorAll('.gstop').forEach((x, j) => x.classList.toggle('on', j === i)); };
        stopsEl.append(m);
      });
      syncCtl(); kind.sync(); dir.sync();
    }
    function syncCtl() { opN.sync(); colIn.value = p.stops[sel]?.color || '#000000'; delB.disabled = p.stops.length <= 2; }
    barIn.onpointerdown = (e) => { const r = bar.getBoundingClientRect(), pos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); const st = [...p.stops].sort((a, b) => a.pos - b.pos); let c = st[0].color; for (const s of st) if (s.pos <= pos) c = s.color; p.stops.push({ pos, color: c, alpha: 1 }); sel = p.stops.length - 1; redraw(); emit(); };
    pane.append(bar, ctl, row2, presets); redraw();
  }
  function patternPane() {
    if (p.type !== 'pattern') { p = { type: 'pattern', id: 'dots', color: '#ffffff', scale: 100, angle: 0 }; emit(); }
    const prev = mkCanvas(300, 110); prev.className = 'pat-prev';
    const drawPrev = () => { const x = prev.getContext('2d'); x.fillStyle = '#2a2a2a'; x.fillRect(0, 0, 300, 110); x.fillStyle = paintStyle(x, p, [0, 0, 300, 110]); x.fillRect(0, 0, 300, 110); };
    const ctl = el('div', 'grow-ctl');
    const colIn = el('input'); colIn.type = 'color'; colIn.className = 'gcol'; colIn.value = p.color; colIn.oninput = () => { p.color = colIn.value; drawPrev(); emit(); rebuild(); };
    ctl.append(obLabel('Scale:'), obNum(() => p.scale, v => { p.scale = Math.max(10, v); drawPrev(); emit(); }, { min: 10, max: 400, suffix: '%' }), obLabel('Direction:'), obNum(() => p.angle, v => { p.angle = v; drawPrev(); emit(); }, { min: 0, max: 359, suffix: '°' }), obLabel('Color:'), colIn);
    const g = el('div', 'fill-grid');
    const rebuild = () => { g.innerHTML = ''; if (allowNone) g.append(noneBtn(() => { p = { type: 'none' }; emit(); })); for (const id of PATTERNS) { const b = el('button', 'fill-sw pat' + (p.id === id ? ' on' : '')); b.style.background = `url(${patternTile(id, '#fff').toDataURL()}) #2a2a2a`; b.title = id; b.onclick = () => { p.id = id; p.type = 'pattern'; drawPrev(); emit(); rebuild(); }; g.append(b); } };
    pane.append(prev, ctl, g); drawPrev(); rebuild();
  }
  fillDlg = { title, ...dlg(title, body, { okLabel: 'OK', onOk: () => onDone(true, clone(p)), onCancel: () => onDone(false, clone(initial)) }) };
  tab(colorOnly ? 'color' : (p.type === 'gradient' ? 'gradient' : p.type === 'pattern' ? 'pattern' : 'color'));
}
function paintSwatch(get, set, opts = {}) {
  const b = el('button', 'ob-swatch'); const inner = el('span'); b.append(inner);
  const sync = () => { inner.style.background = paintCSS(get()); }; sync(); b.sync = sync;
  b.title = opts.title || 'Fill';
  b.onclick = () => { const orig = clone(get()); openFillDialog(orig, opts, (p) => { set(p, false); sync(); }, (ok, p) => { set(p, true, ok ? undefined : 'cancel'); sync(); }); };
  return b;
}

// ===== vector layer rendering
const FONTS_SYS = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const FONTS_GOOGLE = ['Oswald', 'Bebas Neue', 'Anton', 'Montserrat', 'Poppins', 'Roboto', 'Lobster', 'Pacifico', 'Bangers', 'Permanent Marker', 'Press Start 2P', 'Fredoka', 'Luckiest Guy', 'Righteous', 'Russo One', 'Black Ops One', 'Bungee', 'Creepster', 'Dancing Script', 'Great Vibes', 'Satisfy', 'Shadows Into Light', 'Abril Fatface', 'Alfa Slab One', 'Archivo Black', 'Bowlby One SC', 'Caveat', 'Comfortaa', 'Kanit', 'Orbitron', 'Playfair Display', 'Rubik Mono One', 'Teko', 'Titan One', 'VT323', 'Silkscreen', 'Rye', 'Monoton', 'Audiowide', 'Special Elite'];
const loadedG = new Set();
function loadFont(name) {
  if (!FONTS_GOOGLE.includes(name) || loadedG.has(name)) return Promise.resolve();
  loadedG.add(name);
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}&display=swap`;
  document.head.append(l);
  return new Promise((res) => { l.onload = () => document.fonts.load(`40px "${name}"`).then(res, res); l.onerror = res; setTimeout(res, 4000); });
}
let localFonts = [];
try { localFonts = JSON.parse(localStorage.getItem('stitch-fonts') || '[]'); } catch { localFonts = []; }
for (const f of localFonts) { try { const ff = new FontFace(f.name, Uint8Array.from(atob(f.data), c => c.charCodeAt(0)).buffer); ff.load().then(x => { document.fonts.add(x); rerenderAllVec(); }); } catch { /* ignore broken font */ } }
document.fonts.addEventListener?.('loadingdone', () => rerenderAllVec());
function rerenderAllVec() { for (const d of Object.values(state.docs)) for (const l of d.layers) if (l.vec?.type === 'text') renderVec(l); requestRender(); }

function shapePath(c, v) {
  const w = v.w, h = v.h, x = -w / 2, y = -h / 2;
  switch (v.shape) {
    case 'rect': c.rect(x, y, w, h); break;
    case 'round': c.roundRect(x, y, w, h, Math.max(0, Math.min(v.radius || 0, w / 2, h / 2))); break;
    case 'ellipse': c.ellipse(0, 0, Math.max(.5, w / 2), Math.max(.5, h / 2), 0, 0, Math.PI * 2); break;
    case 'star': { const n = v.points || 5, inner = (v.inner || 45) / 100; for (let i = 0; i < n * 2; i++) { const r = i % 2 ? inner : 1, a = -Math.PI / 2 + i * Math.PI / n; c.lineTo(Math.cos(a) * w / 2 * r, Math.sin(a) * h / 2 * r); } c.closePath(); break; }
    case 'line': if (v.dir > 0) { c.moveTo(x, y); c.lineTo(x + w, y + h); } else { c.moveTo(x, y + h); c.lineTo(x + w, y); } break;
  }
}
function drawShapeVec(c, v) {
  c.save(); c.translate(v.x + v.w / 2, v.y + v.h / 2); c.rotate(v.angle || 0); c.scale(v.flipX ? -1 : 1, v.flipY ? -1 : 1);
  const box = [-v.w / 2, -v.h / 2, v.w, v.h];
  c.beginPath(); shapePath(c, v);
  if (v.shape === 'line') { c.lineWidth = Math.max(1, v.strokeW || 4); c.lineCap = 'round'; c.strokeStyle = paintStyle(c, v.fill, box); c.stroke(); }
  else {
    if (v.fill?.type !== 'none') { c.fillStyle = paintStyle(c, v.fill, box); c.fill(); }
    if (v.strokeW > 0 && v.stroke?.type !== 'none') { c.lineWidth = v.strokeW; c.lineJoin = 'round'; c.strokeStyle = paintStyle(c, v.stroke, box); c.stroke(); }
  }
  c.restore();
}
function textFont(v) { return `${v.italic ? 'italic ' : ''}${v.bold ? 'bold ' : ''}${v.size}px "${v.family}", Arial`; }
function textLines(v) { return (v.upper ? v.text.toUpperCase() : v.text).split('\n'); }
const measC = mkCanvas(4, 4).getContext('2d');
function textLayout(v) {
  measC.font = textFont(v); measC.letterSpacing = (v.letter || 0) + 'px';
  const lines = textLines(v).map(t => ({ t, w: Math.max(1, measC.measureText(t).width) }));
  const lineH = v.size * (1.2 + (v.lineSpace || 0) / 100), w = Math.max(...lines.map(l => l.w)), h = lineH * lines.length;
  return { lines, lineH, w: Math.ceil(w), h: Math.ceil(h) };
}
// renders text (with all styles) to a tight canvas; returns {c, ox, oy}: offset of the unstyled text block inside c
function renderTextCanvas(v) {
  const L = textLayout(v), fx = v.fx || {}, pad = Math.ceil(v.size * .6 + (fx.outline?.on ? fx.outline.width * 2 : 0) + (fx.bg?.on ? fx.bg.pad : 0) + (fx.shadow?.on ? fx.shadow.blur + fx.shadow.dist : 0) + (fx.curve?.on ? L.w * .6 : 0) + 8);
  const gw = L.w + pad * 2, gh = L.h + pad * 2, g = mkCanvas(gw, gh), x = g.getContext('2d');
  x.font = textFont(v); x.letterSpacing = (v.letter || 0) + 'px'; x.textBaseline = 'alphabetic';
  const asc = v.size * .8, box = [pad, pad, L.w, L.h];
  const fill = paintStyle(x, v.fill, box);
  const curveAmt = fx.curve?.on ? (fx.curve.amt || 0) / 100 : 0;
  const drawGlyphs = (mode) => {
    L.lines.forEach((ln, i) => {
      const by = pad + i * L.lineH + (L.lineH - v.size) / 2 + asc;
      const lx = pad + (v.align === 'center' ? (L.w - ln.w) / 2 : v.align === 'right' ? L.w - ln.w : 0);
      const doText = (s, px, py) => mode === 'stroke' ? x.strokeText(s, px, py) : x.fillText(s, px, py);
      if (curveAmt) {
        const R = ln.w / (Math.abs(curveAmt) * Math.PI) , sgn = Math.sign(curveAmt), cx = lx + ln.w / 2, cy = by + sgn * R;
        let acc = 0; const chars = [...ln.t];
        for (const ch of chars) {
          const cw = x.measureText(ch).width; const mid = acc + cw / 2 - ln.w / 2; const a = mid / R;
          x.save(); x.translate(cx + Math.sin(a) * R, cy - sgn * Math.cos(a) * R); x.rotate(a * sgn); doText(ch, -cw / 2, 0); x.restore(); acc += cw;
        }
      } else if (v.align === 'justify' && i < L.lines.length - 1 && ln.t.includes(' ')) {
        const words = ln.t.split(' '), ww = words.map(w => x.measureText(w).width), gap = (L.w - ww.reduce((a, b) => a + b, 0)) / (words.length - 1);
        let px = pad; words.forEach((w, k) => { doText(w, px, by); px += ww[k] + gap; });
      } else doText(ln.t, lx, by);
      if (v.underline && mode === 'fill' && !curveAmt) { const uw = v.align === 'justify' && i < L.lines.length - 1 ? L.w : ln.w, ux = v.align === 'justify' ? pad : lx; x.fillRect(ux, by + v.size * .1, uw, Math.max(1, v.size * .06)); }
    });
  };
  if (fx.outline?.on && fx.outline.width > 0) { x.strokeStyle = fx.outline.color; x.lineWidth = fx.outline.width * 2; x.lineJoin = 'round'; drawGlyphs('stroke'); }
  x.fillStyle = fill; drawGlyphs('fill');
  // warp
  let src = g;
  if (fx.warp?.on && fx.warp.amt) {
    const amt = fx.warp.amt / 100, extra = Math.ceil(gh * Math.abs(amt) * .6), out = mkCanvas(gw, gh + extra * 2), o = out.getContext('2d');
    for (let col = 0; col < gw; col++) {
      const t = (col - pad) / Math.max(1, L.w), tt = Math.max(0, Math.min(1, t));
      let dy = 0, sc = 1;
      if (fx.warp.style === 'arch') dy = -Math.sin(Math.PI * tt) * amt * L.h * .45;
      else if (fx.warp.style === 'bulge') sc = 1 + Math.sin(Math.PI * tt) * amt * .5;
      else dy = Math.sin(tt * Math.PI * 2) * amt * L.h * .3;
      const hh = gh * sc; o.drawImage(g, col, 0, 1, gh, col, extra + dy + (gh - hh) / 2, 1, hh);
    }
    src = out;
  }
  // background + shadow composition
  const fin = mkCanvas(src.width, src.height), f = fin.getContext('2d'), yoff = (src.height - gh) / 2;
  if (fx.bg?.on) { f.fillStyle = fx.bg.color; f.beginPath(); f.roundRect(pad - fx.bg.pad, yoff + pad - fx.bg.pad, L.w + fx.bg.pad * 2, L.h + fx.bg.pad * 2, fx.bg.radius || 0); f.fill(); }
  if (fx.shadow?.on) { const a = (fx.shadow.angle || 45) * Math.PI / 180; f.shadowColor = rgba(fx.shadow.color, (fx.shadow.opacity ?? 60) / 100); f.shadowBlur = fx.shadow.blur; f.shadowOffsetX = Math.cos(a) * fx.shadow.dist; f.shadowOffsetY = Math.sin(a) * fx.shadow.dist; }
  f.drawImage(src, 0, 0); f.shadowColor = 'transparent';
  // crop to content
  const d = f.getImageData(0, 0, fin.width, fin.height).data; let x0 = fin.width, y0 = fin.height, x1 = -1, y1 = -1;
  for (let yy = 0; yy < fin.height; yy++) for (let xx = 0; xx < fin.width; xx++) if (d[(yy * fin.width + xx) * 4 + 3] > 2) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
  if (x1 < 0) { x0 = pad; y0 = pad; x1 = pad + L.w; y1 = pad + L.h; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, crop = mkCanvas(cw, ch); crop.getContext('2d').drawImage(fin, -x0, -y0);
  return { c: crop, ox: pad - x0, oy: pad + yoff - y0, L };
}
function renderVec(l) {
  if (l.vec.type === 'fill') { renderFill(l); return; }
  if (l.vec.type === 'path') { renderPath(l); return; }
  const v = l.vec, c = l.ctx; c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
  if (v.type === 'shape') drawShapeVec(c, v);
  else {
    // the rendered text is cached until its content or style changes, so moving/rotating it is just a redraw
    const key = JSON.stringify(v, function (k, x) { return this === v && VEC_PLACE.has(k) ? undefined : x; }) + document.fonts.check(textFont(v)); // top level only: fill.angle is style
    if (l._tc?.key !== key) l._tc = { key, r: renderTextCanvas(v) };
    const r = l._tc.r; v.w = r.c.width; v.h = r.c.height; v._ox = r.ox; v._oy = r.oy;
    c.translate(v.x + v.w / 2, v.y + v.h / 2); c.rotate(v.angle || 0); c.scale(v.flipX ? -1 : 1, v.flipY ? -1 : 1); c.drawImage(r.c, -v.w / 2, -v.h / 2);
  }
  c.restore();
}

// ===== vector edit history (debounced so sliders make one history step)
let vecPending = null;
function vecEdit(l, mutate, label) {
  if (!l?.vec) return;
  if (l.locked) { toast(`“${l.name}” is locked`); return; }
  if (!vecPending || vecPending.l !== l) { flushVecEdit(); vecPending = { l, label, before: l.ctx.getImageData(0, 0, W, H), vb: clone(l.vec) }; }
  mutate(l.vec); renderVec(l); requestRender(); if (arr && arr.layerId === l.id) arr = null;
  clearTimeout(vecPending.t); vecPending.t = setTimeout(flushVecEdit, 450);
  updateTextEditor();
}
function flushVecEdit() {
  const p = vecPending; if (!p) return; vecPending = null; clearTimeout(p.t);
  if (JSON.stringify(p.vb) === JSON.stringify(p.l.vec)) return;
  const d = Object.values(state.docs).find(dd => dd.layers.includes(p.l)); if (!d || d !== doc()) return;
  labelled(p.label, () => pushPixels(p.l, p.before, p.vb)); rebuildLayers();
}
const activeVec = (type) => { if (doc().noSel) return null; const l = activeLayer(); return l?.vec?.type === type ? l : null; };

// ===== shape tool
Object.assign(state, {
  shape: { mode: 'design', shape: 'rect', fill: { type: 'color', color: '#d23c3c' }, stroke: { type: 'color', color: '#000000' }, strokeW: 0, radius: 12, points: 5, inner: 45 },
  textDef: { family: 'Oswald', size: 48, fill: { type: 'color', color: '#ffffff' }, lineSpace: 0, letter: 0, align: 'center', upper: false, italic: false, bold: false, underline: false,
    fx: { curve: { on: false, amt: 40 }, warp: { on: false, style: 'arch', amt: 30 }, bg: { on: false, color: '#000000', pad: 10, radius: 8 }, outline: { on: false, color: '#000000', width: 3 }, shadow: { on: false, color: '#000000', blur: 6, dist: 4, angle: 45, opacity: 60 } } },
});
const SHAPE_ICONS = {
  rect: ICONS.rect, round: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="4"/></svg>', ellipse: ICONS.ellipse,
  line: '<svg viewBox="0 0 24 24"><path d="M5 19L19 5"/></svg>', star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>',
};
function shapeBox(a, b, shift, type) {
  let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y), dir = (b.x - a.x) * (b.y - a.y) >= 0 ? 1 : -1;
  if (shift && type === 'line') { const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(b.x - a.x, b.y - a.y), ex = a.x + Math.cos(ang) * len, ey = a.y + Math.sin(ang) * len; x = Math.min(a.x, ex); y = Math.min(a.y, ey); w = Math.abs(ex - a.x); h = Math.abs(ey - a.y); dir = (ex - a.x) * (ey - a.y) >= 0 ? 1 : -1; }
  else if (shift) { const m = Math.max(w, h); w = h = m; x = b.x < a.x ? a.x - m : a.x; y = b.y < a.y ? a.y - m : a.y; }
  return { x: Math.round(x), y: Math.round(y), w: Math.max(type === 'line' ? 0 : 1, Math.round(w)), h: Math.max(type === 'line' ? 0 : 1, Math.round(h)), dir };
}
function newShapeVec(box) { const S = state.shape; return { type: 'shape', shape: S.shape, ...box, angle: 0, fill: clone(S.fill), stroke: clone(S.stroke), strokeW: S.strokeW, radius: S.radius, points: S.points, inner: S.inner }; }
const shapeToolV = {
  down(p, e) {
    if (state.shape.mode === 'design') { // grab the selected shape (or another one) instead of drawing over it
      if (onVecBox(p, 'shape')) { grabVec(p, e, activeLayer()); return; }
      const hit = vecLayerAt(p, 'shape'); if (hit) { grabVec(p, e, hit); return; }
      if (!doc().noSel && activeLayer()?.vec?.type === 'shape') { deselectLayers(); return; } // first click off a shape deselects it
    }
    if (state.shape.mode === 'draw') { op = beginOp(); if (!op) return; op.start = p; return; }
    op = { struct: snapStruct(), start: p };
    const d = doc(), l = makeLayer(({ rect: 'Rectangle', round: 'Rounded rectangle', ellipse: 'Ellipse', line: 'Line', star: 'Star' })[state.shape.shape]);
    l.kind = 'Shape'; l.vec = newShapeVec({ x: p.x, y: p.y, w: 1, h: 1, dir: 1 });
    d.layers.splice(d.layers.indexOf(activeLayer()) + 1, 0, l); d.activeId = l.id; d.noSel = false; d.sel = new Set([l.id]); op.l = l; rebuildLayers();
  },
  move(p, e) {
    if (op?.viaArr) { arrangeTool.move(p, e); return; }
    if (!op || !op.start) return;
    const box = shapeBox(op.start, p, e.shiftKey, state.shape.shape);
    if (state.shape.mode === 'draw') { shX.clearRect(0, 0, W, H); drawShapeVec(shX, newShapeVec(box)); compositeOnto(op, shapeC); return; }
    Object.assign(op.l.vec, box); renderVec(op.l); requestRender();
  },
  up(p, e) {
    if (op?.viaArr) { arrangeTool.up(p, e); buildOptions(); return; }
    if (!op || !op.start) return; const o = op; op = null;
    const tiny = Math.hypot(p.x - o.start.x, p.y - o.start.y) < 2;
    if (state.shape.mode === 'draw') { if (tiny) { restoreOp(o); requestRender(); return; } this.move.call({}, p, e); op = o; shX.clearRect(0, 0, W, H); drawShapeVec(shX, newShapeVec(shapeBox(o.start, p, e.shiftKey, state.shape.shape))); compositeOnto(o, shapeC); op = null; addRecent(paintCSS(state.shape.fill).startsWith('#') ? state.shape.fill.color : state.fg); labelled('Draw shape', () => commitOp(o)); return; }
    if (tiny) { restoreStruct(o.struct); rebuildLayers(); requestRender(); return; }
    Object.assign(o.l.vec, shapeBox(o.start, p, e.shiftKey, state.shape.shape)); renderVec(o.l);
    pushHistory({ t: 'st', label: 'Add shape', before: o.struct, after: snapStruct() }); rebuildLayers(); buildOptions();
  },
  hover(p) { stack.style.cursor = state.shape.mode === 'design' ? vecCursor(p, 'shape') : ''; },
};
function shapeOptions(add) {
  const S = state.shape, L = () => activeVec('shape');
  const edit = (fn, label) => { fn(S); const l = L(); if (l && S.mode === 'design') vecEdit(l, fn, label); };
  add(obLabel('Mode:'), obSeg([{ v: 'design', text: 'Design' }, { v: 'draw', text: 'Draw' }], () => S.mode, v => { S.mode = v; }));
  add(obLabel('Type:'), obSeg(Object.keys(SHAPE_ICONS).map(k => ({ v: k, icon: SHAPE_ICONS[k], title: ({ rect: 'Rectangle', round: 'Rounded rectangle', ellipse: 'Ellipse', line: 'Line', star: 'Star / polygon' })[k] })), () => (L()?.vec.shape) || S.shape, v => { edit(s => { s.shape = v; if (v === 'line' && !s.strokeW) s.strokeW = 4; }, 'Shape type'); buildOptions(); }));
  const cur = L()?.vec || S;
  add(obLabel('Fill:'), paintSwatch(() => (L()?.vec || S).fill, (p, done, cancel) => { edit(s => { s.fill = clone(p); }, 'Shape fill'); }, { title: 'Fill' }));
  if (cur.shape !== 'line') add(obLabel('Stroke:'), paintSwatch(() => (L()?.vec || S).stroke, (p) => edit(s => { s.stroke = clone(p); }, 'Shape stroke'), { title: 'Stroke' }));
  add(obNum(() => (L()?.vec || S).strokeW || (cur.shape === 'line' ? 4 : 0), v => edit(s => { s.strokeW = v; }, cur.shape === 'line' ? 'Line width' : 'Stroke width'), { min: cur.shape === 'line' ? 1 : 0, max: 100, suffix: 'px' }));
  if (cur.shape === 'round') add(obLabel('Radius:'), obNum(() => (L()?.vec || S).radius, v => edit(s => { s.radius = v; }, 'Corner radius'), { min: 0, max: 300 }));
  if (cur.shape === 'star') add(obLabel('Points:'), obNum(() => (L()?.vec || S).points, v => edit(s => { s.points = Math.max(3, v); }, 'Star points'), { min: 3, max: 40 }), obLabel('Inner:'), obNum(() => (L()?.vec || S).inner, v => edit(s => { s.inner = v; }, 'Star inner size'), { min: 5, max: 100, suffix: '%' }));
  if (L()) add(el('span', 'ob-gap'), obBtn(ICONS.dup, 'Duplicate layer', () => $('#lyDup').click()), obBtn(ICONS.del, 'Delete layer', () => $('#lyDel').click()));
  else add(el('span', 'ob-hint', 'Drag on the canvas to draw · Shift keeps proportions'));
}
if (state.shape.strokeW === 0 && state.shape.shape === 'line') state.shape.strokeW = 4;

// ===== text tool
let textEdit = null;
const textTA = el('textarea', 'text-edit'); textTA.spellcheck = false; stack.append(textTA); textTA.hidden = true;
function updateTextEditor() {
  if (!textEdit) return; const v = textEdit.l.vec, z = state.zoom;
  textTA.style.font = textFont({ ...v, size: v.size * z }); textTA.style.letterSpacing = (v.letter || 0) * z + 'px';
  textTA.style.lineHeight = (v.size * (1.2 + (v.lineSpace || 0) / 100)) * z + 'px'; textTA.style.textAlign = v.align === 'justify' ? 'justify' : v.align;
  textTA.style.textTransform = v.upper ? 'uppercase' : 'none';
  const L = textLayout(v);
  textTA.style.width = (L.w + 4) * z + 'px'; textTA.style.height = (L.h + 2) * z + 'px';
  textTA.style.left = (v.x + (v._ox || 0) - 2) * z + 'px'; textTA.style.top = (v.y + (v._oy || 0)) * z + 'px';
  textTA.style.transformOrigin = `${(v.w / 2 - (v._ox || 0) + 2) * z}px ${(v.h / 2 - (v._oy || 0)) * z}px`;
  textTA.style.transform = `rotate(${v.angle || 0}rad)`;
}
function startTextEdit(l, selectAll) {
  endTextEdit();
  textEdit = { l, before: l.ctx.getImageData(0, 0, W, H), vb: clone(l.vec) };
  textTA.value = l.vec.text; textTA.hidden = false; updateTextEditor();
  setTimeout(() => { textTA.focus(); if (selectAll) textTA.select(); }, 0); drawOverlay();
}
function endTextEdit() {
  const t = textEdit; if (!t) return; textEdit = null; textTA.hidden = true; textTA.blur();
  if (!t.l.vec.text.trim()) t.l.vec.text = t.vb.text || 'Text';
  const nm = (x) => x.replace(/\s+/g, ' ').trim().slice(0, 28) || 'Text';
  if (t.l.name === 'Text' || t.l.name === nm(t.vb.text)) t.l.name = nm(t.l.vec.text);
  renderVec(t.l); requestRender();
  if (JSON.stringify(t.vb) !== JSON.stringify(t.l.vec)) labelled('Edit text', () => pushPixels(t.l, t.before, t.vb));
  rebuildLayers(); drawOverlay();
}
textTA.addEventListener('input', () => { if (!textEdit) return; textEdit.l.vec.text = textTA.value; renderVec(textEdit.l); updateTextEditor(); requestRender(); });
textTA.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); endTextEdit(); } });
textTA.addEventListener('pointerdown', (e) => e.stopPropagation());
function newTextLayer(p, txt = 'Your text here') {
  const before = snapStruct(), d = doc(), l = makeLayer('Text'); l.kind = 'Text';
  l.vec = { type: 'text', text: txt, x: 0, y: 0, angle: 0, ...clone(state.textDef) };
  renderVec(l); l.vec.x = Math.round(Math.max(0, Math.min(W - l.vec.w, p.x - l.vec.w / 2))); l.vec.y = Math.round(Math.max(0, Math.min(H - l.vec.h, p.y - l.vec.h / 2))); renderVec(l);
  d.layers.splice(d.layers.indexOf(activeLayer()) + 1, 0, l); d.activeId = l.id; d.noSel = false; d.sel = new Set([l.id]);
  pushHistory({ t: 'st', label: 'Add text', before, after: snapStruct() }); rebuildLayers(); requestRender();
  if (state.tool !== 'text') setTool('text'); else buildOptions();
  startTextEdit(l, true);
}
const textLayerAt = (p) => vecLayerAt(p, 'text');function confirmDlg(title, msg, okLabel, onOk) { const b = el('div', 'confirm-body'); b.textContent = msg; dlg(title, b, { okLabel, onOk }); }
const textToolV = {
  // click text to edit it, drag it (or its handles) to move/resize/rotate it, click empty canvas to add text
  // clicking off text first deselects it; only a click on empty canvas with nothing selected offers new text
  down(p, e) {
    if (textEdit) {
      const hit = vecLayerAt(p, 'text');
      if (hit === textEdit.l) return; // clicks on the text being typed stay in the text box
      endTextEdit();
      if (!hit) { deselectLayers(); return; }
      if (grabVec(p, e, hit)) op.textTap = { l: hit, start: p };
      return;
    }
    const onBox = onVecBox(p, 'text'), target = onBox ? activeLayer() : vecLayerAt(p, 'text');
    if (target) {
      const handle = onBox && arrHit(p) !== 'move';
      if (grabVec(p, e, target) && !handle) op.textTap = { l: target, start: p };
      return;
    }
    if (!doc().noSel && activeLayer()?.vec?.type === 'text') { deselectLayers(); return; }
    confirmDlg('Add text', 'Do you want to add a new Text layer?', 'Add', () => newTextLayer(p));
  },
  move(p, e) { if (op?.viaArr) arrangeTool.move(p, e); },
  up(p, e) {
    if (!op?.viaArr) return;
    const t = op.textTap, tap = t && Math.hypot(p.x - t.start.x, p.y - t.start.y) < 3 ? t.l : null;
    arrangeTool.up(p, e); buildOptions(); if (tap) startTextEdit(tap, false);
  },
  hover(p) { stack.style.cursor = textEdit && arrHit(p) === 'move' ? '' : vecCursor(p, 'text'); },
};const TEXT_PRESETS = [
  { name: 'Plain white', fx: {}, fill: { type: 'color', color: '#ffffff' }, family: 'Oswald' },
  { name: 'Black outline', fx: { outline: { on: true, color: '#000000', width: 4 } }, fill: { type: 'color', color: '#ffffff' }, family: 'Bebas Neue' },
  { name: 'Drop shadow', fx: { shadow: { on: true, color: '#000000', blur: 4, dist: 5, angle: 45, opacity: 75 } }, fill: { type: 'color', color: '#ffd400' }, family: 'Anton' },
  { name: 'Badge', fx: { bg: { on: true, color: '#d23c3c', pad: 12, radius: 14 } }, fill: { type: 'color', color: '#ffffff' }, family: 'Montserrat', bold: true },
  { name: 'Arched', fx: { curve: { on: true, amt: 45 }, outline: { on: true, color: '#000000', width: 3 } }, fill: { type: 'color', color: '#ffffff' }, family: 'Luckiest Guy' },
  { name: 'Retro gradient', fx: { outline: { on: true, color: '#2a0a3a', width: 3 } }, fill: { type: 'gradient', kind: 'linear', angle: 90, stops: [{ pos: 0, color: '#ffd400', alpha: 1 }, { pos: 1, color: '#ff3d7f', alpha: 1 }] }, family: 'Bungee' },
  { name: 'Script', fx: {}, fill: { type: 'color', color: '#ffffff' }, family: 'Pacifico' },
  { name: 'Pixel', fx: { shadow: { on: true, color: '#000000', blur: 0, dist: 3, angle: 45, opacity: 100 } }, fill: { type: 'color', color: '#ffffff' }, family: 'Press Start 2P', size: 24 },
];
function applyPreset(v, pr) {
  const fx = clone(state.textDef.fx); for (const k of Object.keys(fx)) fx[k].on = false;
  for (const [k, o] of Object.entries(pr.fx)) Object.assign(fx[k], o);
  Object.assign(v, { fx, fill: clone(pr.fill), family: pr.family, bold: !!pr.bold }); if (pr.size) v.size = pr.size;
  loadFont(pr.family).then(rerenderAllVec);
}
function fontPanel(get, set) {
  const p = el('div', 'font-pop');
  const search = el('input', 'font-search'); search.placeholder = 'Search'; search.onkeydown = (e) => e.stopPropagation();
  const list = el('div', 'font-list');
  const add = el('button', 'pill primary font-add', '+ Add local font');
  const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = '.ttf,.otf,.woff,.woff2'; fileIn.hidden = true;
  add.onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const f = fileIn.files[0]; if (!f) return; const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const buf = await f.arrayBuffer(); try { const ff = await new FontFace(name, buf).load(); document.fonts.add(ff); } catch { toast('Could not load that font'); return; }
    let bin = ''; new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
    localFonts = localFonts.filter(x => x.name !== name).concat([{ name, data: btoa(bin) }]);
    try { localStorage.setItem('stitch-fonts', JSON.stringify(localFonts)); } catch { toast('Font added for this session (too big to remember)'); }
    set(name); build();
  };
  const all = () => [...localFonts.map(f => [f.name, 'local']), ...FONTS_GOOGLE.map(f => [f, 'g']), ...FONTS_SYS.map(f => [f, 's'])];
  const build = () => {
    list.innerHTML = ''; const q = search.value.toLowerCase();
    for (const [name, src] of all()) {
      if (q && !name.toLowerCase().includes(q)) continue;
      const b = el('button', 'font-item' + (get() === name ? ' on' : '')); b.textContent = name; b.style.fontFamily = `"${name}", Arial`;
      if (src === 'g') { loadFont(name); const tag = el('span', 'font-tag', 'G'); tag.title = 'Google font (downloaded when used)'; b.append(tag); }
      if (src === 'local') { const tag = el('span', 'font-tag local', 'L'); tag.title = 'Your local font'; b.append(tag); }
      b.onclick = () => { set(name); list.querySelectorAll('.font-item').forEach(x => x.classList.toggle('on', x === b)); };
      list.append(b);
    }
  };
  search.oninput = build; p.append(search, list, add, fileIn); build(); setTimeout(() => list.querySelector('.on')?.scrollIntoView({ block: 'center' }), 0); return p;
}
function textOptions(add) {
  const l = activeVec('text'), T = state.textDef;
  if (!l) {
    const addB = el('button', 'ob-outline'); addB.textContent = 'Add text'; addB.onclick = () => newTextLayer({ x: W / 2, y: H / 2 });
    const pre = el('button', 'ob-iconbtn', '<span class="ob-aa">Aa</span><svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg>'); pre.title = 'Text presets';
    pre.onclick = () => { const box = el('div', 'preset-pop'); for (const pr of TEXT_PRESETS) { const b = el('button', 'preset-item'); b.textContent = pr.name; b.style.fontFamily = `"${pr.family}", Arial`; loadFont(pr.family); b.onclick = () => { applyPreset(T, pr); closePop(); toast(`Preset “${pr.name}” - click the canvas or Add text`); }; box.append(b); } openPop(pre, box, { width: 220 }); };
    add(addB, obLabel('Preset:'), pre, el('span', 'ob-hint', 'Click the canvas to add text, or click existing text to edit it'));
    return;
  }
  const V = () => l.vec;
  const edit = (fn, label) => { fn(T); vecEdit(l, fn, label); };
  const editB = el('button', 'ob-outline' + (textEdit ? ' on' : '')); editB.textContent = textEdit ? 'Done' : 'Edit'; editB.onclick = () => { textEdit ? endTextEdit() : startTextEdit(l, false); buildOptions(); };
  const fontB = el('button', 'ob-font'); const fName = el('span'); fName.textContent = V().family; fName.style.fontFamily = `"${V().family}", Arial`;
  fontB.append(fName, el('span', 'ob-caret', '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg>'));
  fontB.onclick = () => openPop(fontB, fontPanel(() => V().family, (name) => { loadFont(name).then(() => vecEdit(l, v => { v.family = name; }, 'Font')); edit(v => { v.family = name; }, 'Font'); fName.textContent = name; fName.style.fontFamily = `"${name}", Arial`; }), { width: 270 });
  const fmtB = el('button', 'ob-iconbtn', '<svg viewBox="0 0 24 24"><path d="M4 6h10M4 10h16M4 14h10M4 18h16"/></svg><svg viewBox="0 0 24 24" class="c"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg>'); fmtB.title = 'Format';
  fmtB.onclick = () => openPop(fmtB, formatPanel(l, edit), { width: 260 });
  const styB = el('button', 'ob-iconbtn', '<span class="ob-aa">Aa</span><svg viewBox="0 0 24 24" class="c"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg>'); styB.title = 'Styles';
  styB.onclick = () => openPop(styB, stylesPanel(l, edit), { width: 280 });
  add(editB, obLabel('Font:'), fontB, obLabel('Fill:'), paintSwatch(() => V().fill, (p) => edit(v => { v.fill = clone(p); }, 'Text fill')),
    obLabel('Size:'), obNum(() => V().size, v => edit(s => { s.size = Math.max(4, v); }, 'Text size'), { min: 4, max: 400 }),
    obLabel('Format:'), fmtB, obLabel('Styles:'), styB, el('span', 'ob-gap'),
    obBtn('<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>', 'New text layer', () => newTextLayer({ x: W / 2, y: H / 2 })),
    obBtn(ICONS.dup, 'Duplicate layer', () => { endTextEdit(); $('#lyDup').click(); }), obBtn(ICONS.del, 'Delete layer', () => { endTextEdit(); $('#lyDel').click(); }));
}
function formatPanel(l, edit) {
  const v = l.vec, p = el('div', 'fmt-pop');
  const ls = slider('Line space', -50, 200, v.lineSpace || 0), lt = slider('Letter space', -20, 100, v.letter || 0);
  ls.addEventListener('change', () => edit(s => { s.lineSpace = ls.value(); }, 'Line spacing')); lt.addEventListener('change', () => edit(s => { s.letter = lt.value(); }, 'Letter spacing'));
  const al = el('div', 'sl-label'); al.textContent = 'Align';
  const A = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const alignSeg = obSeg([{ v: 'left', icon: A('M4 6h16M4 10h10M4 14h16M4 18h10'), title: 'Left' }, { v: 'center', icon: A('M4 6h16M7 10h10M4 14h16M7 18h10'), title: 'Centre' }, { v: 'right', icon: A('M4 6h16M10 10h10M4 14h16M10 18h10'), title: 'Right' }, { v: 'justify', icon: A('M4 6h16M4 10h16M4 14h16M4 18h16'), title: 'Justify' }], () => l.vec.align, x => edit(s => { s.align = x; }, 'Align'));
  alignSeg.classList.add('wide');
  const st = el('div', 'sl-label'); st.textContent = 'Style';
  const tog = (key, html, title) => { const b = el('button', 'ob-segbtn' + (l.vec[key] ? ' on' : ''), html); b.title = title; b.onclick = () => { edit(s => { s[key] = !l.vec[key]; }, title); b.classList.toggle('on', !!l.vec[key]); }; return b; };
  const styles = el('div', 'ob-seg wide'); styles.append(tog('upper', '<b style="font-size:13px">TT</b>', 'Uppercase'), tog('italic', '<i style="font-family:Georgia;font-size:15px">I</i>', 'Italic'), tog('bold', '<b style="font-size:15px">B</b>', 'Bold'), tog('underline', '<u style="font-size:15px">U</u>', 'Underline'));
  p.append(ls, lt, al, alignSeg, st, styles); return p;
}
function stylesPanel(l, edit) {
  const p = el('div', 'sty-pop');
  const sec = (key, title, build) => {
    const s = el('div', 'sty-sec'); const head = el('div', 'sty-head'); const chev = el('span', 'sty-chev', '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>');
    const name = el('span', 'sty-name'); name.textContent = title; const sw = el('input', 'switch'); sw.type = 'checkbox'; sw.checked = !!l.vec.fx[key].on;
    head.append(chev, name, sw); const body = el('div', 'sty-body'); body.hidden = true; build(body, l.vec.fx[key]);
    head.onclick = (e) => { if (e.target === sw) return; body.hidden = !body.hidden; s.classList.toggle('open', !body.hidden); };
    sw.onchange = () => { edit(v => { v.fx[key].on = sw.checked; }, title); if (sw.checked) { body.hidden = false; s.classList.add('open'); } };
    s.append(head, body); return s;
  };
  const sl = (body, fxKey, k, label, min, max, unit = '') => { const r = slider(label, min, max, l.vec.fx[fxKey][k], unit); r.addEventListener('change', () => edit(v => { v.fx[fxKey][k] = r.value(); v.fx[fxKey].on = true; }, label)); body.append(r); };
  const col = (body, fxKey, label) => { const row = el('div', 'sty-col'); const t = el('span'); t.textContent = label; const c = el('input'); c.type = 'color'; c.className = 'gcol'; c.value = l.vec.fx[fxKey].color; c.oninput = () => edit(v => { v.fx[fxKey].color = c.value; v.fx[fxKey].on = true; }, label); row.append(t, c); body.append(row); };
  p.append(
    sec('curve', 'Curve', (b) => sl(b, 'curve', 'amt', 'Bend', -100, 100)),
    sec('warp', 'Warp', (b) => { const s = el('select', 'ob-select'); for (const [v, t] of [['arch', 'Arch'], ['bulge', 'Bulge'], ['wave', 'Wave']]) { const o = el('option'); o.value = v; o.textContent = t; s.append(o); } s.value = l.vec.fx.warp.style; s.onchange = () => edit(v => { v.fx.warp.style = s.value; v.fx.warp.on = true; }, 'Warp style'); b.append(s); sl(b, 'warp', 'amt', 'Amount', -100, 100); }),
    sec('bg', 'Background', (b) => { col(b, 'bg', 'Colour'); sl(b, 'bg', 'pad', 'Padding', 0, 80, 'px'); sl(b, 'bg', 'radius', 'Corner radius', 0, 80, 'px'); }),
    sec('outline', 'Outline', (b) => { col(b, 'outline', 'Colour'); sl(b, 'outline', 'width', 'Width', 1, 30, 'px'); }),
    sec('shadow', 'Shadow', (b) => { col(b, 'shadow', 'Colour'); sl(b, 'shadow', 'opacity', 'Opacity', 0, 100, '%'); sl(b, 'shadow', 'blur', 'Blur', 0, 40, 'px'); sl(b, 'shadow', 'dist', 'Distance', 0, 40, 'px'); sl(b, 'shadow', 'angle', 'Angle', 0, 359, '°'); }),
  );
  return p;
}

tools.shape = shapeToolV; tools.text = textToolV;

// ------------------------------------------------------------------ zip + Pixlr (.pxz) import/export
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), files = new Map();
  let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  let p = dv.getUint32(eocd + 16, true); const n = dv.getUint16(eocd + 10, true), dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), loc = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen)); p += 46 + nlen + elen + clen;
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true), raw = u8.slice(start, start + csize);
    files.set(name, method === 0 ? raw : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  }
  return files;
}
function zipStore(entries) {
  const enc = new TextEncoder(), parts = [], cd = []; let off = 0;
  for (const { name, data } of entries) {
    const nm = enc.encode(name), crc = crc32(data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cd.push(new Uint8Array(c.buffer), nm); off += 30 + nm.length + data.length;
  }
  const cdSize = cd.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
const BLENDS = ['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'destination-out', 'destination-in', 'source-atop'];
function pxzPaint(f) {
  if (!f) return { type: 'none' };
  if (f.type === 'color' || typeof f.value === 'string') return { type: 'color', color: (f.value || f.color || '#000000').slice(0, 7) };
  if (f.type === 'gradient' && f.value) {
    const g = f.value, stops = (g.stops || g.colors || []).map((s, i, a) => ({ pos: s.offset ?? s.pos ?? s.position ?? i / Math.max(1, a.length - 1), color: (s.color || s.value || '#000000').slice(0, 7), alpha: s.alpha ?? s.opacity ?? 1 }));
    if (stops.length >= 2) return { type: 'gradient', kind: g.type === 'radial' ? 'radial' : 'linear', angle: g.angle || g.direction || 0, stops };
  }
  return { type: 'color', color: '#000000' };
}
async function readPxz(buf, fileName, tw = W, th = H) {
  const files = await unzip(buf); const man = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  const layers = [], skipped = [];
  const sx = man.width && man.width !== tw ? tw / man.width : 1, sy = man.height && man.height !== th ? th / man.height : 1;
  for (const it of man.stack || []) {
    const l = makeLayer(it.name || 'Layer', tw, th); l.opacity = it.opacity ?? 1; l.visible = it.visible !== false; l.locked = !!it.locked;
    const bm = it.blendmode || it.blend; if (bm && BLENDS.includes(bm)) l.blend = bm;
    const r = it.rect || { x: 0, y: 0, w: tw, h: th, r: 0 }, rx = r.x * sx, ry = r.y * sy, rw = r.w * sx, rh = r.h * sy, ang = ((r.r || 0) % 360) * Math.PI / 180;
    if (it.type === 'image' && files.has(it.content)) {
      const img = new Image(); img.src = URL.createObjectURL(new Blob([files.get(it.content)], { type: 'image/png' })); await img.decode();
      const c = l.ctx; c.save(); c.translate(rx + rw / 2, ry + rh / 2); c.rotate(ang); c.drawImage(img, -rw / 2, -rh / 2, rw, rh); c.restore(); URL.revokeObjectURL(img.src);
      l.kind = 'Image';
    } else if (it.type === 'shape') {
      const fm = it.format || {}, v = String(fm.variant || 'rectangle').toLowerCase(), out = it.style?.outline;
      l.kind = 'Shape';
      l.vec = { type: 'shape', shape: v.includes('ellipse') || v.includes('circle') ? 'ellipse' : v.includes('round') ? 'round' : v.includes('star') ? 'star' : 'rect',
        x: rx, y: ry, w: Math.max(1, rw), h: Math.max(1, rh), angle: ang, fill: pxzPaint(fm.fill), stroke: out ? { type: 'color', color: (out.color || '#000000').slice(0, 7) } : { type: 'none' },
        strokeW: out ? (out.size || 1) : 0, radius: fm.radius || fm.cornerRadius || 12, points: fm.points || 5, inner: 45 };
      if (v === 'line') { l.vec.fill = out ? { type: 'color', color: (out.color || '#000000').slice(0, 7) } : l.vec.fill; l.vec.stroke = { type: 'none' }; l.vec.strokeW = 0; } // Pixlr lines are solid bars the size of their box
      renderVec(l);
    } else if (it.type === 'text') {
      const fm = it.format || {}; l.kind = 'Text';
      l.vec = { type: 'text', ...clone(state.textDef), text: it.text || it.content || fm.text || 'Text', x: rx, y: ry, angle: ang, family: fm.font || fm.fontFamily || 'Oswald', size: (fm.size || fm.fontSize || 40) * sy, fill: pxzPaint(fm.fill || (fm.color ? { type: 'color', value: fm.color } : null)), align: fm.align || 'left', bold: !!fm.bold, italic: !!fm.italic, underline: !!fm.underline };
      await loadFont(l.vec.family); renderVec(l);
    } else { skipped.push(it.name || it.type); continue; }
    layers.push(l);
  }
  if (!layers.length) throw new Error('No layers found');
  return { layers, name: man.name || fileName, skipped };

}
// A Pixlr file the size of a template (585 x 559) can open as a normal canvas, as the shirt or pants of a new template,
// or replace that part of the open template; any other size opens as a normal canvas at its own size
async function askPxz(file) {
  const name = file.name.replace(/\.pxz$/i, '');
  let buf, man;
  try { buf = await file.arrayBuffer(); man = JSON.parse(new TextDecoder().decode((await unzip(buf)).get('manifest.json'))); }
  catch (err) { toast('Could not open: ' + err.message); return; }
  const w = clampSide(man.width, TW), h = clampSide(man.height, TH);
  const open = async (size, fn) => {
    try { endTextEdit(); const r = await readPxz(buf, name, ...size); fn(r); if (r.skipped.length) toast('Skipped: ' + r.skipped.join(', ')); }
    catch (err) { toast('Could not open: ' + err.message); }
  };
  // a new project: text and shapes are drawn again once the project's size is the current one
  const fillNew = (st, key, r) => { const d = st.docs[key]; d.layers = r.layers; d.activeId = r.layers[r.layers.length - 1].id; d.counter = r.layers.length; normalizeGroups(d); addSet(st); for (const l of r.layers) if (l.vec) renderVec(l); requestRender(); };
  const asCanvas = () => open([w, h], (r) => { fillNew(makeSet(r.name, 'canvas', w, h), 'canvas', r); toast(`Opened ${r.name} (${w} × ${h})`); });
  if (w !== TW || h !== TH) { asCanvas(); return; }
  let kind = /pant|leg|trouser|jean|short/i.test(name) ? 'pants' : /shirt|top|hood|jacket|torso/i.test(name) ? 'shirt' : (isTemplate() ? state.mode : 'shirt');
  const body = el('div', 'openimg');
  const p = el('p'); p.textContent = `“${name}” is the size of a shirt/pants template. Open it as…`;
  const row = el('div', 'openimg-row');
  const big = (svg, label, sub, fn) => { const b = el('button', 'openimg-btn np-type', svg); const t = el('span'), sm = el('small'); t.textContent = label; sm.textContent = sub; b.append(t, sm); b.onclick = () => { h_.close(); fn(); }; return b; };
  const subs = [];
  const tplB = big(TEMPLATE_ICON, 'Template', '', () => open([TW, TH], (r) => { const st = makeSet(r.name); st.mode = kind; fillNew(st, kind, r); toast(`Opened ${r.name} as the ${kind} of a new project`); }));
  const addB = big('<svg viewBox="0 0 48 48"><rect x="6" y="16" width="26" height="22" rx="1"/><path d="M12 16v-6h30v22h-10"/><path d="M15 27h8M19 23l4 4-4 4"/></svg>', 'Replace in this project', '', () => open([TW, TH], (r) => {
    if (state.mode !== kind) setMode(kind);
    structOp(() => { const d = doc(); d.layers = r.layers; d.groups = []; d.activeGroup = null; d.activeId = r.layers[r.layers.length - 1].id; d.counter = r.layers.length; }, `Open ${r.name}`);
    toast(`Opened ${r.name} as the ${kind} (Ctrl+Z to undo)`);
  }));
  const syncKind = () => { tplB.querySelector('small').textContent = `New project, as the ${kind}`; addB.querySelector('small').textContent = `Replaces the ${kind} (undoable)`; };
  row.append(big(CANVAS_ICON, 'Normal', `A plain canvas, ${w} × ${h}`, asCanvas), tplB);
  if (!homeOpen() && isTemplate()) row.append(addB); // replacing only makes sense inside an open template
  row.classList.toggle('three', row.children.length > 2);
  const seg = obSeg([{ v: 'shirt', text: 'Shirt' }, { v: 'pants', text: 'Pants' }], () => kind, v => { kind = v; syncKind(); }); seg.classList.add('pxz-kind');
  const segRow = el('div', 'pxz-kind-row'); segRow.append(Object.assign(el('span'), { textContent: 'As a template it is the' }), seg);
  syncKind(); body.append(p, row, segRow);
  const h_ = dlg('Open Pixlr file', body, { noFoot: true, center: true, outsideClose: true });
}
async function blobToB64(blob) { const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
const canvasBlob = (c, type = 'image/png', q) => new Promise(res => c.toBlob(res, type, q));
async function exportPxz() {
  endTextEdit(); flushVecEdit();
  const d = doc(), entries = [], stack = [];
  for (const l of d.layers) {
    const b = contentBounds(l) || [0, 0, 1, 1], c = mkCanvas(b[2], b[3]); c.getContext('2d').drawImage(layerSource(l), -b[0], -b[1]);
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0') + '.png';
    entries.push({ name: id, data: new Uint8Array(await (await canvasBlob(c)).arrayBuffer()) });
    const item = { name: l.name, type: 'image', rect: { x: b[0], y: b[1], w: b[2], h: b[3], r: 0 }, opacity: l.opacity, locked: !!l.locked, visible: l.visible, link: '', content: id };
    if (l.blend !== 'source-over') item.blendmode = l.blend;
    stack.push(item);
  }
  compositeDoc(d); const th = mkCanvas(292, 280); th.getContext('2d').drawImage(d.comp, 0, 0, 292, 280);
  const name = isTemplate() ? `${state.mode === 'pants' ? 'Pants' : 'Shirt'} template` : state.sets[state.setIdx].name;
  const pxzName = isTemplate() ? `${state.mode}-template.pxz` : fileSafe(name) + '.pxz';
  const man = { id: crypto.randomUUID(), name, type: 'document', unit: 'pixel', width: W, height: H, stack };
  const all = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(man)) }, { name: 'thumbnail.webp', data: new Uint8Array(await (await canvasBlob(th, 'image/webp', .8)).arrayBuffer()) }, ...entries];
  const blob = zipStore(all), b64 = await blobToB64(blob);
  if (native) { const p = await native.saveFile({ defaultPath: pxzName, filters: [{ name: 'Pixlr document', extensions: ['pxz'] }], data: b64, encoding: 'base64' }); if (p) toast('Saved ' + p); }
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = pxzName; a.click(); }
}

// ------------------------------------------------------------------ colour fill layers + matching colours
state.swatches = [
  { id: 'sw1', name: 'Main', paint: { type: 'color', color: '#372a57' } },
  { id: 'sw2', name: 'Accent', paint: { type: 'color', color: '#d5cfff' } },
  { id: 'sw3', name: 'Trim', paint: { type: 'color', color: '#111111' } },
];
// placeholder until a project is opened from Home; never saved
state.sets = [{ id: 'set0', temp: true, name: 'Untitled', kind: 'template', w: TW, h: TH, mode: 'shirt', docs: state.docs, swatches: state.swatches }]; state.setIdx = 0;
const swatchById = (id) => state.swatches.find(s => s.id === id);
const maskCache = new Map();
function maskCanvas(url) {
  if (maskCache.has(url)) return maskCache.get(url);
  const c = mkCanvas(); maskCache.set(url, c);
  const img = new Image(); img.onload = () => { c.getContext('2d').drawImage(img, 0, 0); rerenderFills(); }; img.src = url;
  if (maskCache.size > 60) maskCache.delete(maskCache.keys().next().value);
  return c;
}
// opening a project: the mask has to be decoded before the fill renders, or the layer stays blank
// (maskCanvas's own reload only re-renders the open tab, not the project still being built)
async function loadFillMask(url, w, h) {
  if (!url || maskCache.get(url)?._ready) return;
  const img = new Image(); img.src = url; await img.decode();
  const c = mkCanvas(w, h); c.getContext('2d').drawImage(img, 0, 0); c._ready = true; maskCache.set(url, c);
}
function fillPaint(v) { return (v.link && swatchById(v.link)?.paint) || v.paint; }
function renderFill(l, live) {
  const v = l.vec, c = l.ctx, m = live || maskCanvas(v.mask), w = l.canvas.width, h = l.canvas.height;
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, w, h);
  c.fillStyle = paintStyle(c, fillPaint(v), v.bb || [0, 0, w, h]); c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in'; c.drawImage(m, 0, 0); c.restore();
}
function rerenderFills() { for (const d of Object.values(state.docs)) for (const l of d.layers) if (l.vec?.type === 'fill') renderFill(l); requestRender(); renderSwatches(); }
function maskFromLayer(l, mode) {
  const m = mkCanvas(), x = m.getContext('2d');
  if (mode === 'luma') {
    const src = l.ctx.getImageData(0, 0, W, H), d = src.data, out = x.createImageData(W, H), o = out.data;
    for (let i = 0; i < d.length; i += 4) { o[i] = o[i + 1] = o[i + 2] = 255; o[i + 3] = Math.round((d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) * d[i + 3] / 255); }
    x.putImageData(out, 0, 0);
  } else { x.drawImage(l.canvas, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); }
  return m;
}
function setFillVec(l, maskC, link, paint) {
  const url = maskC.toDataURL(); maskCache.set(url, maskC);
  l.kind = 'Fill'; l.vec = { type: 'fill', mask: url, link: link || null, paint: paint || { type: 'color', color: state.fg }, bb: contentBounds({ ctx: maskC.getContext('2d') }) || [0, 0, W, H] };
  renderFill(l);
}
function newFillFromSelection() {
  if (!hasSel) { toast('Make a selection first'); return; }
  const m = mkCanvas(); m.getContext('2d').drawImage(selC, 0, 0);
  structOp(() => { const l = addLayer('Colour fill'); setFillVec(l, m, null); }, 'New colour fill'); deselect();
}
function convertToFill(mode, link) {
  const l = activeLayer(); if (l.locked) { toast(`“${l.name}” is locked`); return; }
  if (!contentBounds(l)) { toast('This layer is empty'); return; }
  endTextEdit(); flushVecEdit();
  structOp(() => { const m = maskFromLayer(l, mode); const keep = l.vec?.type === 'fill' ? l.vec : null; setFillVec(l, m, link ?? keep?.link, keep?.paint); }, 'Convert to colour fill');
  toast(`“${l.name}” is now a colour fill - change its colour in the Colours panel`);
}
function editSwatch(sw) {
  const orig = clone(sw.paint);
  openFillDialog(orig, { title: `Colour: ${sw.name}`, allowNone: false }, (p) => { sw.paint = p; rerenderFills(); }, (ok, p) => {
    sw.paint = ok ? p : orig; rerenderFills();
    if (ok && JSON.stringify(orig) !== JSON.stringify(p)) pushHistory({ t: 'sw', id: sw.id, before: orig, after: clone(p), label: `Colour “${sw.name}”` });
  });
}
function editFillLayerColour(l) {
  if (l.vec.link && swatchById(l.vec.link)) { editSwatch(swatchById(l.vec.link)); return; }
  const orig = clone(l.vec.paint);
  openFillDialog(orig, { title: 'Fill colour', allowNone: false }, (p) => { l.vec.paint = p; renderFill(l); requestRender(); }, (ok, p) => { l.vec.paint = orig; renderFill(l); if (ok) vecEdit(l, v => { v.paint = clone(p); }, 'Fill colour'); requestRender(); });
}
function linkActive(sw) {
  const l = activeLayer();
  if (l.vec?.type === 'fill') { vecEdit(l, v => { v.link = sw ? sw.id : null; if (!sw) v.paint = clone(fillPaint(l.vec)); }, sw ? `Link to “${sw.name}”` : 'Unlink colour'); flushVecEdit(); rerenderFills(); return; }
  if (!sw) return;
  convertToFill('alpha', sw.id); rerenderFills();
}
function renderSwatches() {
  const list = $('#swatchList'); if (!list) return; list.innerHTML = '';
  const al = activeLayer(), counts = {};
  for (const d of Object.values(state.docs)) for (const l of d.layers) if (l.vec?.type === 'fill' && l.vec.link) counts[l.vec.link] = (counts[l.vec.link] || 0) + 1;
  for (const sw of state.swatches) {
    const row = el('div', 'sw-row' + (al?.vec?.type === 'fill' && al.vec.link === sw.id ? ' on' : ''));
    const chip = el('button', 'sw-chip'); chip.style.background = paintCSS(sw.paint); chip.title = 'Change this colour everywhere it is used'; chip.onclick = () => editSwatch(sw);
    const name = el('span', 'sw-name'); name.textContent = sw.name; name.title = 'Double-click to rename';
    name.ondblclick = () => { const inp = el('input', 'sw-rename'); inp.value = sw.name; name.replaceWith(inp); inp.focus(); inp.select(); const done = () => { sw.name = inp.value.trim() || sw.name; renderSwatches(); rebuildLayers(); scheduleAutosave(); }; inp.onblur = done; inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); }; };
    const cnt = el('span', 'sw-count'); cnt.textContent = counts[sw.id] ? `${counts[sw.id]} layer${counts[sw.id] > 1 ? 's' : ''}` : '';
    const link = el('button', 'ph-icon', '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>');
    link.title = al?.vec?.type === 'fill' ? `Link “${al.name}” to this colour` : `Turn “${al?.name}” into a colour fill using this colour (keeps its shape)`;
    link.onclick = () => linkActive(sw);
    const del = el('button', 'ph-icon sw-del', '×'); del.title = 'Remove colour (linked layers keep it)';
    del.onclick = () => { for (const d of Object.values(state.docs)) for (const l of d.layers) if (l.vec?.link === sw.id) { l.vec.paint = clone(sw.paint); l.vec.link = null; } state.swatches = state.swatches.filter(s => s !== sw); rerenderFills(); rebuildLayers(); scheduleAutosave(); };
    const grip = el('span', 'sw-grip'); grip.title = 'Drag to reorder';
    row.dataset.id = sw.id; row.onpointerdown = (e) => swDragStart(e, row, sw);
    row.append(grip, chip, name, cnt, link, del); list.append(row);
  }
}
// drag a colour row (anywhere except its buttons / rename box) to reorder the list
function swDragStart(e, row, sw) {
  if (e.button !== 0 || e.target.closest('button, input')) return;
  const list = $('#swatchList'), sx = e.clientX, sy = e.clientY; let drag = false, drop = null, to = -1;
  const move = (ev) => {
    if (!drag) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return; drag = true; row.classList.add('dragging'); document.body.classList.add('sw-list-dragging'); drop = el('div', 'sw-drop'); }
    const rows = [...list.querySelectorAll('.sw-row')]; to = rows.length;
    for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { to = i; break; } }
    if (to < rows.length) list.insertBefore(drop, rows[to]); else list.append(drop);
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    document.body.classList.remove('sw-list-dragging'); if (!drag) return;
    const from = state.swatches.indexOf(sw); let dest = to > from ? to - 1 : to;
    if (from >= 0 && dest !== from && to >= 0) { const before = state.swatches.map(x => x.id); state.swatches.splice(from, 1); state.swatches.splice(dest, 0, sw); pushHistory({ t: 'swo', before, after: state.swatches.map(x => x.id), label: 'Reorder colours' }); scheduleAutosave(); }
    renderSwatches();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
$('#swAdd').onclick = () => { const n = state.swatches.length + 1; state.swatches.push({ id: 'sw' + Date.now().toString(36), name: 'Colour ' + n, paint: { type: 'color', color: state.fg } }); renderSwatches(); scheduleAutosave(); };
$('#swUnlink').onclick = () => { const l = activeLayer(); if (l.vec?.type === 'fill' && l.vec.link) linkActive(null); else toast('Select a linked colour fill layer first'); };
$('#swFromSel').onclick = newFillFromSelection;
$('#swConvert').onclick = () => convertToFill('luma');

// ------------------------------------------------------------------ pen tool: editable bezier paths (several paths per layer)
state.pen = { stroke: { type: 'color', color: '#000000' }, strokeW: 3, fill: { type: 'none' }, closed: false, addTo: true };
// a path layer holds vec.paths = [{ pts, closed }]; older files stored a single { pts, closed }
function normPath(v) { if (v && !v.paths) { v.paths = v.pts ? [{ pts: v.pts, closed: !!v.closed }] : []; delete v.pts; delete v.closed; } return v; }
const allPts = (v) => normPath(v).paths.flatMap(sp => sp.pts);
function subPath(c, sp) {
  const P = sp.pts; if (!P.length) return;
  c.moveTo(P[0].x, P[0].y);
  const seg = (a, b) => (a.hout || b.hin) ? c.bezierCurveTo((a.hout || a).x, (a.hout || a).y, (b.hin || b).x, (b.hin || b).y, b.x, b.y) : c.lineTo(b.x, b.y);
  for (let i = 1; i < P.length; i++) seg(P[i - 1], P[i]);
  if (sp.closed && P.length > 2) { seg(P[P.length - 1], P[0]); c.closePath(); }
}
function pathOf(c, v, onlyClosed) { for (const sp of normPath(v).paths) if (!onlyClosed || (sp.closed && sp.pts.length > 2)) subPath(c, sp); }
function pathBBox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) for (const q of [p, p.hin, p.hout]) if (q) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  if (x0 === Infinity) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
function renderPath(l) {
  const v = normPath(l.vec), c = l.ctx; c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
  const b = pathBBox(allPts(v)), box = [b.x, b.y, b.w, b.h];
  if (v.fill?.type !== 'none' && v.paths.some(sp => sp.closed)) { c.beginPath(); pathOf(c, v, true); c.fillStyle = paintStyle(c, v.fill, box); c.fill('evenodd'); }
  if (v.strokeW > 0 && v.stroke?.type !== 'none') { c.beginPath(); pathOf(c, v); c.lineWidth = v.strokeW; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = paintStyle(c, v.stroke, box); c.stroke(); }
  c.restore();
}
let penDraw = null, penSel = -1, penSub = -1, penOwner = null, penHover = null;
const activePath = () => { const d = doc(), l = activeLayer(); return !d.noSel && l?.vec?.type === 'path' ? (normPath(l.vec), l) : null; };
function penHit(l, p) {
  const tol = 6 / state.zoom, S = l.vec.paths;
  for (let s = 0; s < S.length; s++) { const P = S[s].pts; for (let i = 0; i < P.length; i++) for (const k of ['hin', 'hout']) if (P[i][k] && (penSel < 0 || penOwner !== l.id || (s === penSub && Math.abs(i - penSel) <= 1)) && Math.hypot(P[i][k].x - p.x, P[i][k].y - p.y) < tol) return { s, i, k }; }
  for (let s = 0; s < S.length; s++) { const P = S[s].pts; for (let i = 0; i < P.length; i++) if (Math.hypot(P[i].x - p.x, P[i].y - p.y) < tol + 1) return { s, i, k: 'a' }; }
  return null;
}
const curSub = () => penDraw ? penDraw.l.vec.paths[penDraw.s] : null;
// a path's mirror twin on a layer with Mirror on (index, or -1). Twins share a `tw` id; twins from before 0.12.1 have
// none and are found by shape (call this before editing, while the two still match)
function twinOf(l, s) {
  if (!l.mirror) return -1;
  const S = l.vec.paths, sp = S[s]; if (!sp) return -1;
  if (sp.tw) return S.findIndex((o, j) => j !== s && o.tw === sp.tw);
  const m = mirrorSub(sp); if (!m) return -1;
  const near = (a, b) => (!a && !b) || (a && b && Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01);
  const j = S.findIndex((o, j) => j !== s && !o.tw && o.pts.length === m.pts.length && o.pts.every((q, i) => near(q, m.pts[i]) && near(q.hin, m.pts[i].hin) && near(q.hout, m.pts[i].hout)));
  if (j >= 0) sp.tw = S[j].tw = Math.random().toString(36).slice(2, 10);
  return j;
}
// redraw path j as the mirror of path s after s was edited
function syncTwin(l, s, j) {
  if (j < 0) return; const S = l.vec.paths, m = mirrorSub(S[s]);
  if (m) { S[j].pts = m.pts; S[j].closed = S[s].closed; }
}
function finishPath() {
  const pd = penDraw; if (!pd) return; penDraw = null; penHover = null;
  const sp = pd.l.vec.paths[pd.s];
  if (!sp || sp.pts.length < 2) { restoreStruct(pd.struct); rebuildLayers(); requestRender(); drawOverlay(); buildOptions(); return; }
  if (pd.l.mirror) { const m = mirrorSub(sp); if (m) { sp.tw = m.tw = Math.random().toString(36).slice(2, 10); pd.l.vec.paths.push(m); } } // Mirror on: a twin path on the other side
  renderPath(pd.l); pushHistory({ t: 'st', label: pd.added ? 'Add path' : 'Draw path', before: pd.struct, after: snapStruct() }); penSub = pd.s; penOwner = pd.l.id; penSel = -1; rebuildLayers(); buildOptions(); drawOverlay();
}
const penTool = {
  down(p, e) {
    if (penDraw) {
      const P = curSub().pts, f = P[0];
      if (P.length > 2 && Math.hypot(p.x - f.x, p.y - f.y) < 7 / state.zoom) { curSub().closed = true; renderPath(penDraw.l); finishPath(); return; }
      P.push({ x: p.x, y: p.y, hin: null, hout: null }); op = { dragNew: P.length - 1 }; renderPath(penDraw.l); requestRender(); return;
    }
    const lp = activePath();
    if (lp) {
      const h = penHit(lp, p);
      if (h) {
        if (h.k === 'a' && e.altKey) { const o = beginOp({ vec: true }); if (!o) return; const tw = twinOf(lp, h.s), P = lp.vec.paths[h.s].pts, pt = P[h.i]; if (pt.hin || pt.hout) { pt.hin = pt.hout = null; } else { const nx = P[h.i + 1] || P[h.i - 1]; if (nx) { const dx = (nx.x - pt.x) / 3, dy = (nx.y - pt.y) / 3; pt.hout = { x: pt.x + dx, y: pt.y + dy }; pt.hin = { x: pt.x - dx, y: pt.y - dy }; } } syncTwin(lp, h.s, tw); renderPath(lp); labelled('Path point type', () => commitOp(o)); penSub = h.s; penOwner = lp.id; penSel = h.i; drawOverlay(); return; }
        const o = beginOp({ vec: true }); if (!o) return; penSub = h.s; penOwner = lp.id; penSel = h.i; op = { edit: h, o, start: p, tw: twinOf(lp, h.s) }; drawOverlay(); buildOptions(); return;
      }
    }
    penSel = -1;
    const struct = snapStruct(), d = doc(), pt0 = { x: p.x, y: p.y, hin: null, hout: null };
    // with a path layer selected, new paths go onto that layer (Shift+click makes a new layer instead, or the other way round)
    const addTo = lp && !lp.locked && (state.pen.addTo !== e.shiftKey);
    if (addTo) {
      lp.vec.paths.push({ pts: [pt0], closed: false });
      penDraw = { l: lp, struct, s: lp.vec.paths.length - 1, added: true }; penSub = penDraw.s; penOwner = lp.id; op = { dragNew: 0 }; renderPath(lp); requestRender(); buildOptions(); drawOverlay(); return;
    }
    const l = makeLayer('Path'); l.kind = 'Path';
    l.vec = { type: 'path', paths: [{ pts: [pt0], closed: false }], stroke: clone(state.pen.stroke), strokeW: state.pen.strokeW, fill: clone(state.pen.fill) };
    const a = activeLayer(); if (!d.noSel && a?.group) l.group = a.group;
    if (!d.noSel && a?.mirror) l.mirror = true; // started from a mirrored layer: keep mirroring
    d.layers.splice(d.layers.indexOf(a) + 1, 0, l); d.activeId = l.id; d.noSel = false; d.activeGroup = null; d.sel = new Set([l.id]);
    penDraw = { l, struct, s: 0 }; penSub = 0; penOwner = l.id; op = { dragNew: 0 }; rebuildLayers(); buildOptions();
  },
  move(p, e) {
    if (!op) return;
    if (op.dragNew != null && penDraw) { const pt = curSub().pts[op.dragNew]; if (Math.hypot(p.x - pt.x, p.y - pt.y) > 1.5) { pt.hout = { x: p.x, y: p.y }; pt.hin = { x: 2 * pt.x - p.x, y: 2 * pt.y - p.y }; } renderPath(penDraw.l); requestRender(); drawOverlay(); return; }
    if (op.edit) {
      const l = op.o.l, pt = l.vec.paths[op.edit.s].pts[op.edit.i];
      if (op.edit.k === 'a') { const dx = p.x - pt.x, dy = p.y - pt.y; pt.x += dx; pt.y += dy; for (const k of ['hin', 'hout']) if (pt[k]) { pt[k].x += dx; pt[k].y += dy; } }
      else {
        const k = op.edit.k, other = k === 'hin' ? 'hout' : 'hin'; pt[k] = { x: p.x, y: p.y };
        if (!e.altKey && pt[other]) { const len = Math.hypot(pt[other].x - pt.x, pt[other].y - pt.y), ang = Math.atan2(pt.y - p.y, pt.x - p.x); pt[other] = { x: pt.x + Math.cos(ang) * len, y: pt.y + Math.sin(ang) * len }; }
      }
      syncTwin(l, op.edit.s, op.tw);
      renderPath(l); requestRender(); drawOverlay();
    }
  },
  up(p) {
    if (!op) return; const o = op; op = null;
    if (o.edit) { if (Math.hypot(p.x - o.start.x, p.y - o.start.y) < .5) { restoreOp(o.o); requestRender(); return; } labelled('Edit path', () => commitOp(o.o)); arr = null; }
  },
  hover(p) { if (penDraw) { penHover = p; } else { const lp = activePath(); stack.style.cursor = lp && penHit(lp, p) ? 'pointer' : ''; } },
  dbl() { if (penDraw) { curSub().pts.pop(); finishPath(); } },
};
function deletePenPoint() {
  const lp = activePath(); if (!lp || penSel < 0 || penOwner !== lp.id || !lp.vec.paths[penSub]) return false;
  const S = lp.vec.paths, sp = S[penSub], tw = twinOf(lp, penSub);
  if (sp.pts.length <= 2 && S.length <= (tw >= 0 ? 2 : 1)) { $('#lyDel').click(); penSel = penSub = -1; return true; }
  const o = beginOp({ vec: true }); if (!o) return true;
  if (sp.pts.length <= 2) { for (const j of [penSub, tw].filter(j => j >= 0).sort((a, b) => b - a)) S.splice(j, 1); penSub = -1; }
  else { sp.pts.splice(penSel, 1); syncTwin(lp, penSub, tw); }
  penSel = -1; renderPath(lp); labelled('Delete path point', () => commitOp(o)); drawOverlay(); return true;
}
function drawPenOverlay(o) {
  const l = penDraw?.l || (state.tool === 'pen' ? activePath() : null); if (!l) return;
  const v = normPath(l.vec), z = state.zoom, s = 3.5 / z;
  o.save(); o.lineWidth = 1 / z; o.strokeStyle = '#00b4ff'; o.beginPath(); pathOf(o, v); o.stroke();
  const cs = curSub();
  if (cs && penHover && cs.pts.length) { const a = cs.pts[cs.pts.length - 1]; o.setLineDash([4 / z, 3 / z]); o.beginPath(); o.moveTo(a.x, a.y); if (a.hout) o.quadraticCurveTo(a.hout.x, a.hout.y, penHover.x, penHover.y); else o.lineTo(penHover.x, penHover.y); o.stroke(); o.setLineDash([]); }
  v.paths.forEach((sp, si) => sp.pts.forEach((pt, i) => {
    for (const k of ['hin', 'hout']) if (pt[k]) { o.strokeStyle = 'rgba(0,180,255,.8)'; o.beginPath(); o.moveTo(pt.x, pt.y); o.lineTo(pt[k].x, pt[k].y); o.stroke(); o.fillStyle = '#fff'; o.beginPath(); o.arc(pt[k].x, pt[k].y, s * .8, 0, Math.PI * 2); o.fill(); o.stroke(); }
    o.fillStyle = penOwner === l.id && si === penSub && i === penSel ? '#00b4ff' : '#fff'; o.strokeStyle = '#00b4ff'; o.fillRect(pt.x - s, pt.y - s, s * 2, s * 2); o.strokeRect(pt.x - s, pt.y - s, s * 2, s * 2);
  }));
  o.restore();
}
function penOptions(add) {
  const l = activePath(), S = state.pen, cur = () => l?.vec || S;
  const edit = (fn, label) => { fn(S); if (l) vecEdit(l, fn, label); };
  // "Closed" acts on the path being drawn / the selected path, or on every path of the layer
  const targets = (v) => { const P = normPath(v).paths; const i = penDraw ? penDraw.s : penOwner === l.id ? penSub : -1; return P[i] ? [P[i]] : P; };
  const isClosed = () => l ? targets(l.vec).every(sp => sp.closed) : S.closed;
  add(obLabel('Stroke:'), paintSwatch(() => cur().stroke, (p) => edit(s => { s.stroke = clone(p); }, 'Path stroke'), { title: 'Stroke' }),
    obNum(() => cur().strokeW, v => edit(s => { s.strokeW = v; }, 'Path width'), { min: 0, max: 100, suffix: 'px' }),
    obLabel('Fill:'), paintSwatch(() => cur().fill, (p) => edit(s => { s.fill = clone(p); }, 'Path fill'), { title: 'Fill (closed paths)' }),
    obToggle('Closed', isClosed, v => { S.closed = v; if (l) { if (penDraw) { curSub().closed = v; renderPath(l); requestRender(); } else vecEdit(l, s => { if (s.type === 'path') targets(s).forEach(sp => { sp.closed = v; }); }, v ? 'Close path' : 'Open path'); } }));
  if (l && !penDraw) add(obToggle('Add to layer', () => S.addTo, v => { S.addTo = v; buildOptions(); }));
  if (penDraw) { const b = el('button', 'ob-outline'); b.textContent = 'Finish'; b.onclick = () => { finishPath(); }; add(el('span', 'ob-gap'), b); }
  add(el('span', 'ob-hint', penDraw ? 'Click to add points · drag to curve · click the first point to close · Enter/double-click to finish' : l ? `Drag points or handles · click empty space: ${S.addTo ? 'new path on this layer (Shift: new layer)' : 'new path layer (Shift: add to this layer)'} · Alt+click a point: smooth/corner · Delete removes a point` : 'Click to place points · drag while placing to make curves'));
}

tools.pen = penTool;

// ------------------------------------------------------------------ fixed right-hand options
const bindCheck = (id, key, after) => { $(id).onchange = () => { state[key] = $(id).checked; after?.(); }; };
bindCheck('#optUnderlay', 'underlay', requestRender); bindCheck('#optGuides', 'guides', drawOverlay); bindCheck('#optShade', 'shade', drawOverlay);
bindCheck('#optSeams', 'seams', () => { if (state.seams && isTemplate()) toast('Seams on: Brush, Pencil and Eraser strokes that run off a face carry on where that edge joins on the body'); });
$('#colFg').oninput = () => { state.fg = $('#colFg').value; };
$('#colBg').oninput = () => { state.bg = $('#colBg').value; };
for (const [id, key, title] of [['#colFg', 'fg', 'Primary colour'], ['#colBg', 'bg', 'Secondary colour']]) {
  $(id).addEventListener('click', (e) => {
    e.preventDefault(); const orig = state[key];
    openFillDialog({ type: 'color', color: orig }, { colorOnly: true, allowNone: false, title }, (p) => { if (p.type === 'color') { state[key] = p.color; $(id).value = p.color; } }, (ok, p) => { const c = ok && p.type === 'color' ? p.color : orig; state[key] = c; $(id).value = c; if (ok && key === 'fg') addRecent(c); });
  });
}
function swapColors() { [state.fg, state.bg] = [state.bg, state.fg]; $('#colFg').value = state.fg; $('#colBg').value = state.bg; }
$('#btnSwap').onclick = swapColors;

function buildRegionSelect() {
  const sel = $('#optRegion'); if (!sel) return; sel.innerHTML = '';
  let group, gEl = null;
  for (const r of regionsFor(state.mode)) {
    if (r.group !== group) { group = r.group; gEl = group ? document.createElement('optgroup') : sel; if (group) { gEl.label = group; sel.appendChild(gEl); } }
    const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; gEl.appendChild(o);
  }
  sel.value = state.region;
}


// ------------------------------------------------------------------ layers panel (groups, multi-select, drag & drop)
const eyeOn = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const eyeOff = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.2 6.2A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/></svg>';
const lockSvg = '<svg viewBox="0 0 24 24"><rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/></svg>';
const mirrorSvg = '<svg viewBox="0 0 24 24"><path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6L3 18h6z"/><path d="M15 6l6 12h-6z" fill="currentColor"/></svg>';
const MIRROR_TIP = () => isTemplate() ? 'Mirror is on: strokes and paths on one arm, leg or half of the torso are also made on the other side' : 'Mirror is on: strokes and paths are also made flipped across the middle of the canvas';
function toggleMirror(l = activeLayer()) {
  if (!l || doc().activeGroup) { toast('Mirror goes on layers, not groups'); return; }
  propChange(l, 'mirror', !l.mirror, l.mirror ? 'Mirror off' : 'Mirror on'); requestRender();
  toast(`Mirror ${l.mirror ? 'on' : 'off'} for “${l.name}”`);
}
const folderSvg = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const thumbs = new Map();
const groupOf = (l, d = doc()) => l.group ? (d.groups || []).find(g => g.id === l.group) : null;
const layerVisible = (l, d = doc()) => l.visible && (!l.group || groupOf(l, d)?.visible !== false);
const groupMembers = (gid, d = doc()) => d.layers.filter(l => l.group === gid);
function normalizeGroups(d = doc()) {
  d.groups = d.groups || [];
  for (const g of [...d.groups]) {
    const mem = d.layers.filter(l => l.group === g.id);
    if (!mem.length) { d.groups = d.groups.filter(x => x !== g); if (d.activeGroup === g.id) d.activeGroup = null; continue; }
    const top = Math.max(...mem.map(l => d.layers.indexOf(l)));
    const above = d.layers.slice(top + 1).find(l => l.group !== g.id), rest = d.layers.filter(l => l.group !== g.id);
    const at = above ? rest.indexOf(above) : rest.length; rest.splice(at, 0, ...mem); d.layers = rest;
  }
}
function selectedIds() {
  const d = doc(); if (d.activeGroup) return groupMembers(d.activeGroup).map(l => l.id);
  if (d.sel && d.sel.size > 1) return [...d.sel];
  return [d.activeId];
}
function selectLayer(l, mode) {
  const d = doc(); if (textEdit && textEdit.l !== l) endTextEdit(); flushVecEdit();
  d.noSel = false; d.activeGroup = null;
  if (mode === 'toggle') { d.sel = d.sel || new Set([d.activeId]); if (d.sel.has(l.id) && d.sel.size > 1) d.sel.delete(l.id); else d.sel.add(l.id); d.activeId = l.id; }
  else if (mode === 'range') { const order = [...d.layers].reverse(), i0 = order.findIndex(x => x.id === d.activeId), i1 = order.indexOf(l); d.sel = new Set(order.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map(x => x.id)); }
  else { d.activeId = l.id; d.sel = new Set([l.id]); }
  rebuildLayers(); buildOptions(); drawOverlay();
}
function selectGroup(g) { const d = doc(), mem = groupMembers(g.id); endTextEdit(); flushVecEdit(); d.noSel = false; d.activeGroup = g.id; d.activeId = mem[mem.length - 1].id; d.sel = new Set(mem.map(l => l.id)); rebuildLayers(); buildOptions(); drawOverlay(); }
function deselectLayers() { const d = doc(); endTextEdit(); flushVecEdit(); d.noSel = true; d.activeGroup = null; d.sel = new Set(); rebuildLayers(); buildOptions(); drawOverlay(); }

let dragInfo = null;
function rowDnD(row, item) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => { dragInfo = item; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'layer'); row.classList.add('dragging'); });
  row.addEventListener('dragend', () => { dragInfo = null; row.classList.remove('dragging'); $$('.layer.drop-above, .layer.drop-below, .layer.drop-into').forEach(x => x.classList.remove('drop-above', 'drop-below', 'drop-into')); });
  row.addEventListener('dragover', (e) => {
    if (!dragInfo) return; e.preventDefault(); e.stopPropagation();
    const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
    row.classList.remove('drop-above', 'drop-below', 'drop-into');
    row.classList.add(item.group && !dragInfo.group && y > .3 && y < .75 && !item.group.collapsed === false ? 'drop-into' : item.group && !dragInfo.group && y >= .5 ? 'drop-into' : y < .5 ? 'drop-above' : 'drop-below');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below', 'drop-into'));
  row.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); if (!dragInfo) return;
    const where = row.classList.contains('drop-into') ? 'into' : row.classList.contains('drop-above') ? 'above' : 'below';
    const src = dragInfo; dragInfo = null; dropLayer(src, item, where);
  });
}
function dropLayer(src, tgt, where) {
  structOp(() => {
    const d = doc();
    const moving = src.group ? groupMembers(src.group.id) : (d.sel && d.sel.size > 1 && d.sel.has(src.layer.id) ? d.layers.filter(l => d.sel.has(l.id)) : [src.layer]);
    if (tgt.layer && moving.includes(tgt.layer)) return false;
    if (src.group && tgt.layer && tgt.layer.group === src.group.id) return false;
    let rest = d.layers.filter(l => !moving.includes(l)), newGroup = src.group ? src.group.id : null;
    let anchorIdx;
    if (tgt.group) {
      const mem = rest.filter(l => l.group === tgt.group.id);
      if (where === 'into' && !src.group) { anchorIdx = rest.indexOf(mem[mem.length - 1]) + 1; newGroup = tgt.group.id; }
      else if (where === 'above' || where === 'into') { anchorIdx = rest.indexOf(mem[mem.length - 1]) + 1; }
      else anchorIdx = rest.indexOf(mem[0]);
    } else {
      const t = tgt.layer, ti = rest.indexOf(t);
      if (src.group && t.group) { const mem = rest.filter(l => l.group === t.group); anchorIdx = where === 'above' ? rest.indexOf(mem[mem.length - 1]) + 1 : rest.indexOf(mem[0]); }
      else { anchorIdx = where === 'above' ? ti + 1 : ti; if (!src.group) newGroup = t.group || null; }
    }
    if (!src.group) moving.forEach(l => { l.group = newGroup; });
    rest.splice(anchorIdx, 0, ...moving); d.layers = rest; normalizeGroups(d);
  }, src.group ? 'Move group' : 'Move layer');
}
function renameInline(nameEl, current, save) {
  const inp = document.createElement('input'); inp.value = current; nameEl.textContent = ''; nameEl.appendChild(inp); inp.focus(); inp.select();
  let done = false; const finish = (ok) => { if (done) return; done = true; const v = inp.value.trim(); if (ok && v && v !== current) save(v); else rebuildLayers(); };
  inp.onblur = () => finish(true); inp.onkeydown = (k) => { k.stopPropagation(); if (k.key === 'Enter') finish(true); if (k.key === 'Escape') finish(false); };
  inp.onclick = (e) => e.stopPropagation();
}
function rebuildLayers() {
  const list = $('#layerList'); list.innerHTML = ''; thumbs.clear();
  const d = doc(); d.groups = d.groups || []; d.sel = d.sel || new Set([d.activeId]);
  // a layer created between two members of a group joins that group, so groups stay in one piece
  for (let i = 1; i < d.layers.length - 1; i++) { const g0 = d.layers[i - 1].group; if (g0 && d.layers[i].group !== g0) { const nxt = d.layers.slice(i + 1).find(l => l.group === g0); if (nxt && d.layers.slice(i, d.layers.indexOf(nxt)).every(l => !l.group || l.group === g0 || true)) { const between = d.layers.slice(i, d.layers.indexOf(nxt)); if (between.every(l => l.group !== g0)) between.forEach(l => { if (!l.group) l.group = g0; }); } } }
  normalizeGroups(d);
  let lastG = null;
  for (const l of [...d.layers].reverse()) {
    const g = groupOf(l);
    if (g && l.group !== lastG) {
      const gr = el('div', 'layer group-row' + (d.activeGroup === g.id && !d.noSel ? ' active' : '') + (g.visible === false ? ' hidden' : ''));
      const chev = el('button', 'g-chev' + (g.collapsed ? ' closed' : ''), '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="currentColor"/></svg>');
      chev.onclick = (e) => { e.stopPropagation(); g.collapsed = !g.collapsed; rebuildLayers(); };
      const icon = el('span', 'g-icon', folderSvg);
      const info = el('div', 'info'); const name = el('div', 'name'); name.textContent = g.name; const sub = el('div', 'sub'); sub.textContent = `Group · ${groupMembers(g.id).length} layers` + ((g.opacity ?? 1) < 1 ? ` · ${Math.round(g.opacity * 100)}%` : '');
      name.ondblclick = (e) => { e.stopPropagation(); renameInline(name, g.name, (v) => structOp(() => { g.name = v; }, 'Rename group')); };
      info.append(name, sub);
      const eye = el('button', 'eye', g.visible === false ? eyeOff : eyeOn); eye.title = 'Show / hide group';
      eye.onclick = (e) => { e.stopPropagation(); structOp(() => { g.visible = g.visible === false; }, 'Group visibility'); };
      gr.append(chev, icon, info, eye); gr.onclick = () => selectGroup(g);
      rowDnD(gr, { group: g }); list.append(gr);
    }
    lastG = l.group || null;
    if (g && g.collapsed) continue;
    const row = el('div', 'layer' + (l.id === d.activeId && !d.noSel && !d.activeGroup ? ' active' : '') + (!d.noSel && d.sel.size > 1 && d.sel.has(l.id) && !d.activeGroup ? ' multi' : '') + (l.visible ? '' : ' hidden') + (g ? ' in-group' : '') + (d.activeGroup && l.group === d.activeGroup ? ' group-sel' : ''));
    const th = mkCanvas(80, 76); thumbs.set(l.id, th);
    let mth = null;
    if (l.mask) {
      const editing = maskEditing(l, d);
      th.classList.add('ly-th'); th.classList.toggle('on', l.id === d.activeId && !d.noSel && !editing); th.title = 'Layer - click to paint on the layer';
      th.onclick = (ev) => { ev.stopPropagation(); d.maskEdit = null; selectLayer(l); };
      mth = mkCanvas(80, 76); mth.className = 'ly-th mask-th' + (editing ? ' on' : '') + (l.maskOff ? ' off' : ''); thumbs.set(l.id + ':mask', mth);
      mth.title = 'Mask - click to paint on it (black hides, white shows). Shift+click turns it off and on.';
      mth.onclick = (ev) => { ev.stopPropagation(); if (ev.shiftKey) { propChange(l, 'maskOff', !l.maskOff, l.maskOff ? 'Enable mask' : 'Disable mask'); return; } editMask(l); };
    }
    const info = el('div', 'info'); const name = el('div', 'name'); name.textContent = l.name; name.title = 'Double-click to rename';
    const sub = el('div', 'sub');
    sub.textContent = (l.vec?.type === 'fill' ? 'Colour fill' + (l.vec.link && swatchById(l.vec.link) ? ' · ' + swatchById(l.vec.link).name : '') : l.kind) + (l.opacity < 1 ? ' · ' + Math.round(l.opacity * 100) + '%' : '') + (l.blend !== 'source-over' ? ' · ' + ($('#lyBlend').querySelector(`[value="${l.blend}"]`)?.textContent || l.blend) : '') + (l.mirror ? ' · Mirror on' : '');
    name.ondblclick = (ev) => { ev.stopPropagation(); renameInline(name, l.name, (v) => propChange(l, 'name', v, 'Rename layer')); };
    info.append(name, sub);
    const eye = el('button', 'eye', l.visible ? eyeOn : eyeOff); eye.title = 'Show / hide';
    eye.onclick = (ev) => { ev.stopPropagation(); propChange(l, 'visible', !l.visible, 'Visibility'); };
    if (l.vec?.type === 'fill') { th.title = 'Double-click to change the colour'; th.ondblclick = (ev) => { ev.stopPropagation(); editFillLayerColour(l); }; }
    const ths = mth ? [th, mth] : [th], marks = [];
    if (l.mirror) { const mb = el('button', 'eye mirror', mirrorSvg); mb.title = MIRROR_TIP() + ' - click to turn it off'; mb.onclick = (ev) => { ev.stopPropagation(); toggleMirror(l); }; marks.push(mb); }
    if (l.locked) { const lk = el('button', 'eye lock', lockSvg); lk.title = 'Locked - click to unlock'; lk.onclick = (ev) => { ev.stopPropagation(); propChange(l, 'locked', false, 'Unlock layer'); }; marks.push(lk); }
    row.append(...ths, info, ...marks, eye);
    row.onclick = (e) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && l.id !== d.activeId) d.maskEdit = null; selectLayer(l, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : null); };
    rowDnD(row, { layer: l }); list.appendChild(row);
  }
  const ag = d.activeGroup && d.groups.find(x => x.id === d.activeGroup), a = activeLayer();
  const op_ = ag ? (ag.opacity ?? 1) : a.opacity;
  $('#lyOpacity').value = Math.round(op_ * 100); $('#lyOpacityVal').textContent = Math.round(op_ * 100) + '%';
  $('#lyBlend').value = a.blend; $('#lyBlend').disabled = !!ag;
  $('#lyDel').disabled = false;
  $('#lyMerge').disabled = !ag && d.layers.indexOf(a) === 0;
  $('#lyMerge').title = ag ? 'Merge group into one layer' : 'Merge down (Ctrl+M)';
  $('#btnUndo').disabled = !d.undo.length; $('#btnRedo').disabled = !d.redo.length;
  updateThumbs(); renderHistory(); renderSwatches();
}
$('#layerList').addEventListener('click', (e) => { if (e.target === $('#layerList')) deselectLayers(); });
$('#layerList').addEventListener('dragover', (e) => { if (dragInfo) e.preventDefault(); });
$('#layerList').addEventListener('drop', (e) => { if (!dragInfo || e.target !== $('#layerList')) return; e.preventDefault(); const d = doc(), bottom = d.layers[0]; const src = dragInfo; dragInfo = null; const g = groupOf(bottom); dropLayer(src, g ? { group: g } : { layer: bottom }, 'below'); });
function updateThumbs() {
  for (const l of doc().layers) {
    const th = thumbs.get(l.id); if (!th) continue;
    const c = th.getContext('2d'); c.clearRect(0, 0, th.width, th.height); c.drawImage(l.canvas, 0, 0, th.width, th.height);
    const mt = l.mask && thumbs.get(l.id + ':mask');
    if (mt) { const x = mt.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, mt.width, mt.height); x.drawImage(l.mask, 0, 0, mt.width, mt.height); }
  }
}
$('#lyOpacity').oninput = () => { const d = doc(), ag = d.activeGroup && d.groups.find(x => x.id === d.activeGroup), v = $('#lyOpacity').value / 100; if (ag) ag.opacity = v; else activeLayer().opacity = v; $('#lyOpacityVal').textContent = $('#lyOpacity').value + '%'; requestRender(); };
let opacityStart = null;
$('#lyOpacity').onpointerdown = () => { const d = doc(), ag = d.activeGroup && d.groups.find(x => x.id === d.activeGroup); opacityStart = ag ? (ag.opacity ?? 1) : activeLayer().opacity; };
$('#lyOpacity').onchange = () => {
  const d = doc(), ag = d.activeGroup && d.groups.find(x => x.id === d.activeGroup);
  if (ag) { const v = ag.opacity; ag.opacity = opacityStart ?? v; if (opacityStart !== null && opacityStart !== v) structOp(() => { ag.opacity = v; }, 'Group opacity'); }
  else { const a = activeLayer(), v = a.opacity; if (opacityStart !== null && opacityStart !== v) { a.opacity = opacityStart; propChange(a, 'opacity', v, 'Layer opacity'); } else rebuildLayers(); }
  opacityStart = null; scheduleAutosave();
};
$('#lyBlend').onchange = () => propChange(activeLayer(), 'blend', $('#lyBlend').value, 'Blend mode');

// ---- mask commands
function editMask(l, fresh) {
  const d = doc(); if (!l.mask) return;
  const first = fresh || d.maskEdit !== l.id; selectLayer(l); d.maskEdit = l.id; rebuildLayers(); buildOptions();
  if (first) {
    if (!['brush', 'pencil', 'eraser', 'fill', 'gradient'].includes(state.tool)) setTool('brush');
    state.fg = '#000000'; state.bg = '#ffffff'; $('#colFg').value = state.fg; $('#colBg').value = state.bg;
    toast('Painting on the mask: black hides the layer, white brings it back, grey hides it partly');
  }
}
function addMask(fromSel) {
  const l = activeLayer(); if (doc().activeGroup) { toast('Masks go on layers, not groups'); return; }
  if (l.mask) { editMask(l); return; }
  structOp(() => {
    l.mask = newMask(W, H, fromSel ? '#000' : '#fff');
    if (fromSel) { const x = l.mask.getContext('2d'); const t = mkCanvas(), tx = t.getContext('2d'); tx.fillStyle = '#fff'; tx.fillRect(0, 0, W, H); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(selC, 0, 0); x.drawImage(t, 0, 0); }
    l.maskOff = false; doc().maskEdit = l.id;
  }, fromSel ? 'Mask from selection' : 'Add mask');
  if (fromSel) deselect();
  editMask(l, true);
}
function applyMask() {
  const l = activeLayer(); if (!l.mask) return;
  if (l.vec) { toast('Rasterize the layer first (Layer → Rasterize layer), or keep the mask - it already hides those parts'); return; }
  structOp(() => { if (!l.maskOff) { const c = l.ctx; c.globalCompositeOperation = 'destination-in'; c.drawImage(maskAlpha(l), 0, 0); c.globalCompositeOperation = 'source-over'; } delete l.mask; delete l.maskOff; delete l._ma; doc().maskEdit = null; }, 'Apply mask');
}
function deleteMask() { const l = activeLayer(); if (!l.mask) return; structOp(() => { delete l.mask; delete l.maskOff; delete l._ma; doc().maskEdit = null; }, 'Delete mask'); }
function invertMask() {
  const l = activeLayer(); if (!l.mask) return;
  labelled('Invert mask', () => {
    const d = doc(), keep = d.maskEdit; d.maskEdit = l.id; const o = beginOp(); d.maskEdit = keep; if (!o) return;
    const x = o.l.ctx, id = x.getImageData(0, 0, W, H), p = id.data;
    for (let i = 0; i < p.length; i += 4) { const a = p[i + 3] / 255, v = 255 - Math.round(p[i] * a + 255 * (1 - a)); p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255; }
    x.putImageData(id, 0, 0); commitOp(o); requestRender();
  });
}
function addLayer(name) {
  const d = doc(); const a = activeLayer(), l = makeLayer(name || 'Layer ' + (++d.counter));
  if (!d.noSel && a?.group) l.group = a.group;
  d.layers.splice(d.layers.indexOf(a) + 1, 0, l); d.activeId = l.id; d.activeGroup = null; d.noSel = false; d.sel = new Set([l.id]); return l;
}
function copyLayer(a, nameSuffix = ' copy') {
  const l = makeLayer(a.name + nameSuffix);
  Object.assign(l, { opacity: a.opacity, blend: a.blend, visible: a.visible, kind: a.kind, locked: a.locked, mirror: !!a.mirror, group: a.group || null }); if (a.vec) l.vec = clone(a.vec); l.ctx.drawImage(a.canvas, 0, 0);
  if (a.mask) { l.mask = mkCanvas(); l.mask.getContext('2d', { willReadFrequently: true }).drawImage(a.mask, 0, 0); l.maskOff = !!a.maskOff; }
  return l;
}
$('#lyAdd').onclick = () => structOp(() => { addLayer(); }, 'New layer');
$('#lyMask').onclick = () => { const l = activeLayer(); if (l.mask) editMask(l); else addMask(false); };
$('#lyDup').onclick = () => structOp(() => {
  const d = doc();
  if (d.activeGroup) {
    const g = d.groups.find(x => x.id === d.activeGroup), mem = groupMembers(g.id), ng = { ...clone(g), id: 'g' + Date.now().toString(36), name: g.name + ' copy' };
    const copies = mem.map(l => { const c = copyLayer(l, ''); c.group = ng.id; return c; });
    d.groups.push(ng); d.layers.splice(d.layers.indexOf(mem[mem.length - 1]) + 1, 0, ...copies); d.activeGroup = ng.id; d.activeId = copies[copies.length - 1].id; d.sel = new Set(copies.map(c => c.id)); return;
  }
  const a = activeLayer(), l = copyLayer(a);
  d.layers.splice(d.layers.indexOf(a) + 1, 0, l); d.activeId = l.id; d.sel = new Set([l.id]);
}, 'Duplicate');
$('#lyDel').onclick = () => structOp(() => {
  const d = doc(), ids = new Set(selectedIds());
  const lo = Math.min(...d.layers.map((l, i) => ids.has(l.id) ? i : 1e9));
  d.layers = d.layers.filter(l => !ids.has(l.id));
  if (!d.layers.length) d.layers.push(makeLayer('Layer ' + (++d.counter))); // deleting the last layer leaves a blank one
  d.activeId = d.layers[Math.max(0, Math.min(d.layers.length - 1, lo - 1))].id; d.activeGroup = null; d.sel = new Set([d.activeId]); normalizeGroups(d);
}, selectedIds().length > 1 ? 'Delete layers' : 'Delete layer');
function moveItem(dir) {
  structOp(() => {
    const d = doc(), a = activeLayer();
    let block = d.activeGroup ? groupMembers(d.activeGroup) : [a];
    let lo = d.layers.indexOf(block[0]), hi = d.layers.indexOf(block[block.length - 1]);
    const n = dir > 0 ? hi + 1 : lo - 1; if (n < 0 || n >= d.layers.length) { if (!d.activeGroup && a.group) { a.group = null; normalizeGroups(d); return; } return false; }
    const nb = d.layers[n];
    if (!d.activeGroup && a.group && nb.group !== a.group) { a.group = null; normalizeGroups(d); return; } // step out of the group
    let nlo = n, nhi = n;
    if (nb.group && nb.group !== (d.activeGroup || a.group)) { const mem = groupMembers(nb.group); nlo = d.layers.indexOf(mem[0]); nhi = d.layers.indexOf(mem[mem.length - 1]); }
    const rest = d.layers.filter(l => !block.includes(l));
    const at = dir > 0 ? rest.indexOf(d.layers[nhi]) + 1 : rest.indexOf(d.layers[nlo]);
    rest.splice(at, 0, ...block); d.layers = rest;
  }, doc().activeGroup ? 'Move group' : 'Move layer');
}
$('#lyUp').onclick = () => moveItem(1);
$('#lyDown').onclick = () => moveItem(-1);
function flattenInto(target, layers) {
  const c = target.ctx; c.clearRect(0, 0, W, H);
  compositeLayers(c, layers.map(l => ({ ...l, group: null, visible: layerVisible(l) })), []); // merging a group: its own blend modes stay inside it
}
$('#lyMerge').onclick = () => structOp(() => {
  const d = doc();
  if (d.activeGroup) { const g = d.groups.find(x => x.id === d.activeGroup), mem = groupMembers(g.id), m = makeLayer(g.name); flattenInto(m, mem); d.layers.splice(d.layers.indexOf(mem[mem.length - 1]) + 1, 0, m); d.layers = d.layers.filter(l => !mem.includes(l)); d.activeId = m.id; d.activeGroup = null; d.sel = new Set([m.id]); normalizeGroups(d); return; }
  const a = activeLayer(), i = d.layers.indexOf(a); if (i === 0) return false;
  const below = d.layers[i - 1], c = below.ctx; delete below.vec; below.kind = 'Layer';
  if (below.mask) { if (!below.maskOff) { c.globalCompositeOperation = 'destination-in'; c.drawImage(maskAlpha(below), 0, 0); c.globalCompositeOperation = 'source-over'; } delete below.mask; delete below.maskOff; delete below._ma; }
  if (a.visible) { c.globalAlpha = a.opacity; c.globalCompositeOperation = a.blend; c.drawImage(layerSource(a), 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; }
  d.layers.splice(i, 1); d.activeId = below.id; d.sel = new Set([below.id]);
}, doc().activeGroup ? 'Merge group' : 'Merge down');
$('#lyClear').onclick = () => hasSel ? clearSelectedPixels() : labelled('Clear', () => { const o = beginOp(); if (!o) return; withClip(o.l.ctx, c => c.clearRect(0, 0, W, H)); commitOp(o); });
function groupLayers() {
  const ids = new Set(selectedIds()); if (doc().activeGroup) { toast('That is already a group'); return; }
  structOp(() => {
    const d = doc(), g = { id: 'g' + Date.now().toString(36), name: 'Group ' + (d.groups.length + 1), visible: true, opacity: 1, collapsed: false };
    d.groups.push(g); for (const l of d.layers) if (ids.has(l.id)) l.group = g.id;
    normalizeGroups(d); d.activeGroup = g.id; d.sel = ids;
  }, 'Group layers');
}
function ungroupLayers() {
  const d = doc(), gid = d.activeGroup || activeLayer().group; if (!gid) { toast('Select a group first'); return; }
  structOp(() => { for (const l of d.layers) if (l.group === gid) l.group = null; d.groups = d.groups.filter(g => g.id !== gid); d.activeGroup = null; }, 'Ungroup');
}
function layerAtPoint(p) {
  const x = Math.floor(p.x), y = Math.floor(p.y); if (x < 0 || y < 0 || x >= W || y >= H) return null;
  for (const l of [...doc().layers].reverse()) { if (!layerVisible(l) || l.locked) continue; if (l.ctx.getImageData(x, y, 1, 1).data[3] > 10) return l; }
  return null;
}
function unionBounds(layers) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (const l of layers) { const b = contentBounds(l); if (!b) continue; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]); }
  return x1 < 0 ? null : [x0, y0, x1 - x0, y1 - y0];
}
function shiftVec(v, dx, dy) {
  if (v.type === 'path') for (const pt of allPts(v)) { pt.x += dx; pt.y += dy; if (pt.hin) { pt.hin.x += dx; pt.hin.y += dy; } if (pt.hout) { pt.hout.x += dx; pt.hout.y += dy; } }
  else if (v.type === 'shape' || v.type === 'text') { v.x += dx; v.y += dy; }
  if (v.bb) v.bb = [v.bb[0] + dx, v.bb[1] + dy, v.bb[2], v.bb[3]];
}

function contentBounds(l) {
  const data = l.ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}
$('#lyFit').onclick = () => labelled('Fit to selection', () => {
  const o = beginOp(); if (!o) return;
  const b = contentBounds(o.l); if (!b) { toast('This layer is empty'); return; }
  let tgt = [0, 0, W, H];
  if (hasSel) { const sb = (() => { const a = selX.getImageData(0, 0, W, H).data; let x0 = W, y0 = H, x1 = -1, y1 = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[(y * W + x) * 4 + 3] >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1]; })(); if (sb) tgt = sb; }
  const [tx, ty, tw, th] = tgt, sc = Math.min(tw / b[2], th / b[3]);
  const w = b[2] * sc, h = b[3] * sc, snap = snapCanvas(o.before);
  o.l.ctx.clearRect(0, 0, W, H); o.l.ctx.imageSmoothingQuality = 'high';
  o.l.ctx.drawImage(snap, b[0], b[1], b[2], b[3], Math.round(tx + (tw - w) / 2), Math.round(ty + (th - h) / 2), Math.round(w), Math.round(h));
  commitOp(o);
});
function mirrorLimb(from, to) {
  const o = beginOp(); if (!o) return;
  const snap = snapCanvas(o.before), c = o.l.ctx, src = PARTS[from], dst = PARTS[to];
  for (const k of FACE_ORDER) {
    const dk = k === 'L' ? 'R' : k === 'R' ? 'L' : k;
    const [sx, sy, sw, sh] = src[k], [dx, dy, dw, dh] = dst[dk];
    c.clearRect(dx, dy, dw, dh);
    c.save(); c.translate(dx + dw, dy); c.scale(-1, 1); c.drawImage(snap, sx, sy, sw, sh, 0, 0, dw, dh); c.restore();
  }
  commitOp(o);
  toast(`Copied ${from} ${state.mode === 'pants' ? 'leg' : 'arm'} onto the ${to}, mirrored`);
}
// Symmetrize: make the layer match on both sides by copying one side onto the other, flipped. Templates go by the
// character's sides (as labelled on the template: the Right Arm block is the right); a normal canvas by its halves.
function symmetrize(from) {
  const o = beginOp(); if (!o) return;
  const snap = snapCanvas(o.before), c = o.l.ctx;
  const copy = (sx, sy, sw, sh, dx, dy) => { c.clearRect(dx, dy, sw, sh); c.save(); c.translate(dx + sw, dy); c.scale(-1, 1); c.drawImage(snap, sx, sy, sw, sh, 0, 0, sw, sh); c.restore(); };
  if (!isTemplate()) { const hw = Math.floor(W / 2); if (from === 'left') copy(0, 0, hw, H, W - hw, 0); else copy(W - hw, 0, hw, H, 0, 0); }
  else ALL_FACES.forEach((f, i) => {
    const { from: [fx, fy, fw, fh], to: [tx, ty] } = MIRROR_FACES[i];
    const side = f.part === 'torso' ? { R: 'right', L: 'left' }[f.face] : f.part;
    if (side) { if (side === from) copy(fx, fy, fw, fh, tx, ty); return; }
    // a face down the middle of the body (torso front, back, top, bottom): one half onto the other
    const half = fw / 2, rightOnLeft = FACES[f.face].c[0][0] < 0; // the character's right is the half at the face's -X corner
    const srcLeft = (from === 'right') === rightOnLeft;
    copy(srcLeft ? fx : fx + half, fy, half, fh, srcLeft ? fx + half : fx, fy);
  });
  commitOp(o);
  toast(isTemplate() ? `Copied the ${from} ${state.mode === 'pants' ? 'leg' : 'arm'} and the ${from} side of the torso onto the other side, flipped` : `Copied the ${from} half onto the other half, flipped`);
}
$('#lySymRL').onclick = () => labelled('Symmetrize', () => symmetrize('right'));
$('#lySymLR').onclick = () => labelled('Symmetrize', () => symmetrize('left'));
$('#lyMirrorRL').onclick = () => labelled('Mirror limb', () => mirrorLimb('right', 'left'));
$('#lyMirrorLR').onclick = () => labelled('Mirror limb', () => mirrorLimb('left', 'right'));

// adjust colours
const adj = { hue: $('#adjHue'), sat: $('#adjSat'), bri: $('#adjBri'), con: $('#adjCon'), inv: $('#adjInvert') };
let adjOp = null;
function adjPreview() {
  if (!adjOp) return;
  adj.hue.nextElementSibling.textContent = adj.hue.value + '°';
  for (const k of ['sat', 'bri', 'con']) adj[k].nextElementSibling.textContent = adj[k].value + '%';
  restoreOp(adjOp);
  withClip(adjOp.l.ctx, c => {
    c.clearRect(0, 0, W, H);
    c.filter = `hue-rotate(${adj.hue.value}deg) saturate(${adj.sat.value}%) brightness(${adj.bri.value}%) contrast(${adj.con.value}%)${adj.inv.checked ? ' invert(1)' : ''}`;
    c.drawImage(adjOp.snap, 0, 0); c.filter = 'none';
  });
  requestRender();
}
$('#lyAdjust').onclick = () => {
  adjOp = beginOp(); if (!adjOp) return; adjOp.snap = snapCanvas(adjOp.before);
  adj.hue.value = 0; adj.sat.value = 100; adj.bri.value = 100; adj.con.value = 100; adj.inv.checked = false;
  $('#adjModal').hidden = false; adjPreview();
};
for (const k in adj) adj[k].addEventListener('input', adjPreview);
$('#adjOk').onclick = () => { $('#adjModal').hidden = true; if (adjOp) { labelled('Adjust colours', () => commitOp(adjOp)); adjOp = null; } };
$('#adjCancel').onclick = () => { $('#adjModal').hidden = true; if (adjOp) { restoreOp(adjOp); adjOp = null; requestRender(); } };

// ------------------------------------------------------------------ mode tabs & preview controls
function setMode(m) {
  if (penDraw) finishPath(); endTextEdit(); flushVecEdit(); // pending edits belong to the part being left
  cancelOp(); state.mode = m; document.body.classList.toggle('canvas-mode', m === 'canvas');
  $('#btnExport').title = m === 'canvas' ? 'Export the canvas as a PNG (Ctrl+E)' : 'Export the current template as a 585×559 PNG (Ctrl+E)';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  otherView.classList.toggle('before', m === 'pants'); otherView.title = m === 'pants' ? 'Shirt - click to edit it' : 'Pants - click to edit them';
  if (!regionsFor(m).some(r => r.id === state.region)) state.region = 'all';
  buildRegionSelect(); rebuildLayers(); changed();
}
$$('.tab').forEach(t => t.onclick = () => setMode(t.dataset.mode));
function setPair(v) {
  pairPref = v; try { localStorage.setItem('stitch-pair', v ? '1' : '0'); } catch { /* storage unavailable */ }
  document.body.classList.toggle('pair-view', v); $('#btnPair').classList.toggle('on', v);
  $('#btnPair').title = v ? 'Show only the part you are editing' : 'Show shirt and pants side by side';
  requestRender(); requestAnimationFrame(zoomFit);
}
$('#btnPair').onclick = () => setPair(!pairPref);
document.body.classList.toggle('pair-view', pairPref); $('#btnPair').classList.toggle('on', pairPref);
// body type for the preview, remembered between launches
{
  let rig = 'Woman'; try { rig = localStorage.getItem('stitch-rig') || rig; } catch { /* storage unavailable */ }
  if (![...$('#rigSel').options].some(o => o.value === rig)) rig = 'Woman';
  $('#rigSel').value = rig; if (rig !== 'Woman') preview?.setRig(rig);
  $('#rigSel').onchange = () => { const v = $('#rigSel').value; preview?.setRig(v); try { localStorage.setItem('stitch-rig', v); } catch { /* storage unavailable */ } };
}
$('#skinCol').oninput = () => preview?.setSkin($('#skinCol').value);
const syncShow = () => preview?.setShow($('#showShirt').checked, $('#showPants').checked);
$('#showShirt').onchange = syncShow; $('#showPants').onchange = syncShow;
$('#autoRot').onchange = () => preview?.setAutoRotate($('#autoRot').checked);
$('#btnShot').onclick = () => openRenderDialog();

// ---- Save preview image: a clean render of the model from a chosen side, for thumbnails and adverts
// pairs list [front, back] angles; the three-quarter back is the same pose seen from behind
const RENDER_VIEWS = [['front', 'Front', 0], ['back', 'Back', Math.PI], ['pair', 'Front + back', [0, Math.PI]], ['pair3', '3/4 front + back', [0.6, Math.PI + 0.6]], ['three', 'Three-quarter', 0.6], ['left', 'Left side', Math.PI / 2], ['right', 'Right side', -Math.PI / 2], ['current', 'As shown', null]];
const renderOpts = { view: 'front', size: 1024, bg: 'none', color: '#ffffff', shadow: true };
function renderPreview(size) {
  const o = renderOpts, bg = o.bg === 'color' ? o.color : null;
  const v = RENDER_VIEWS.find(r => r[0] === o.view);
  if (Array.isArray(v[2])) {
    const out = mkCanvas(size, size), x = out.getContext('2d'); if (bg) { x.fillStyle = bg; x.fillRect(0, 0, size, size); }
    const half = Math.round(size / 2);
    x.drawImage(preview.renderImage({ w: half, h: size, view: { theta: v[2][0] }, shadow: o.shadow }), 0, 0);
    x.drawImage(preview.renderImage({ w: size - half, h: size, view: { theta: v[2][1] }, shadow: o.shadow }), half, 0);
    return out;
  }
  return preview.renderImage({ w: size, h: size, view: o.view === 'current' ? null : { theta: v[2] }, shadow: o.shadow, background: bg });
}
function openRenderDialog() {
  if (!preview || !isTemplate()) return;
  const body = el('div', 'render-dlg'), img = el('img', 'render-prev'), side = el('div', 'render-opts');
  const refresh = () => { img.src = renderPreview(320).toDataURL('image/png'); img.classList.toggle('checker', renderOpts.bg === 'none'); };
  const views = obSeg(RENDER_VIEWS.map(([v, text]) => ({ v, text })), () => renderOpts.view, v => { renderOpts.view = v; refresh(); }); views.classList.add('render-views');
  const sizes = obSeg([512, 1024, 2048].map(n => ({ v: String(n), text: n + ' px' })), () => String(renderOpts.size), v => { renderOpts.size = +v; });
  const col = el('input'); col.type = 'color'; col.value = renderOpts.color; col.oninput = () => { renderOpts.color = col.value; renderOpts.bg = 'color'; bgs.sync(); refresh(); };
  const bgs = obSeg([{ v: 'none', text: 'Transparent' }, { v: 'color', text: 'Colour' }], () => renderOpts.bg, v => { renderOpts.bg = v; refresh(); });
  const shadow = obToggle('Ground shadow', () => renderOpts.shadow, v => { renderOpts.shadow = v; refresh(); });
  const row = (label, ...x) => { const r = el('div', 'render-row'); r.append(obLabel(label), ...x); return r; };
  side.append(row('View'), views, row('Size', sizes), row('Background', bgs, col), shadow);
  const note = el('p', 'render-note'); note.textContent = 'Uses the Skin, Shirt and Pants settings under the preview.'; side.append(note);
  body.append(img, side); refresh();
  const copy = async () => {
    try {
      const blob = await canvasBlob(renderPreview(renderOpts.size), 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied preview image');
    } catch { toast('Could not copy the image'); }
  };
  dlg('Save preview image', body, { okLabel: 'Save PNG', extra: [{ label: 'Copy image', run: copy, keepOpen: true }], onOk: () => {
    const name = fileSafe(state.sets[state.setIdx]?.name) + '-' + renderOpts.view + '.png';
    saveDataUrl(renderPreview(renderOpts.size).toDataURL('image/png'), name, 'PNG image', ['png']);
  } });
}

// ------------------------------------------------------------------ files
function toast(msg) { setStatusMsg(msg); }
let msgTimer;
// shown in the status bar, and on Home too (which covers the status bar)
function setStatusMsg(msg) {
  const els = [$('#stMsg'), $('#homeMsg')]; for (const e of els) { e.textContent = msg; e.style.opacity = 1; }
  clearTimeout(msgTimer); msgTimer = setTimeout(() => { for (const e of els) e.style.opacity = 0; }, 3500);
}

async function saveDataUrl(dataUrl, name, label, ext) {
  const b64 = dataUrl.split(',')[1];
  if (native) { const p = await native.saveFile({ defaultPath: name, filters: [{ name: label, extensions: ext }], data: b64, encoding: 'base64' }); if (p) toast('Saved ' + p); return; }
  const a = document.createElement('a'); a.href = dataUrl; a.download = name; a.click();
}
async function saveText(text, name, label, ext) {
  if (native) { const p = await native.saveFile({ defaultPath: name, filters: [{ name: label, extensions: ext }], data: text, encoding: 'utf8' }); if (p) toast('Saved ' + p); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click();
}

const fileSafe = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Untitled';
function exportPng() {
  compositeDoc(doc());
  const out = mkCanvas(), c = out.getContext('2d');
  c.drawImage(doc().comp, 0, 0);
  if (!isTemplate()) { saveDataUrl(out.toDataURL('image/png'), fileSafe(state.sets[state.setIdx].name) + '.png', 'PNG image', ['png']); return; }
  if (templateReady()) c.drawImage(templateImg, 0, 0, W, H); // always stamp the Roblox template on top
  saveDataUrl(out.toDataURL('image/png'), `${state.mode}-template.png`, 'PNG image', ['png']);
}
$('#btnExport').onclick = exportPng;
function docPng(d) {
  compositeDoc(d);
  const out = mkCanvas(), c = out.getContext('2d'); c.drawImage(d.comp, 0, 0);
  if (templateReady()) c.drawImage(templateImg, 0, 0, W, H);
  return out.toDataURL('image/png');
}
// exports the shirt and the pants of the current set as "<set name>-Shirt.png" / "<set name>-Pants.png"
async function exportSet() {
  if (!isTemplate()) return exportPng();
  const set = stashSet(), base = (set.name || 'Untitled').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Untitled';
  const files = [{ name: `${base}-Shirt.png`, data: docPng(set.docs.shirt).split(',')[1] }, { name: `${base}-Pants.png`, data: docPng(set.docs.pants).split(',')[1] }];
  if (native?.saveFiles) { const r = await native.saveFiles({ title: `Export “${set.name}” - choose a folder`, files }); if (r) toast(`Saved ${files.map(f => f.name).join(' and ')} to ${r}`); return; }
  for (const f of files) { const a = document.createElement('a'); a.href = 'data:image/png;base64,' + f.data; a.download = f.name; a.click(); }
}

function serializeSet(set) {
  // "kind" tells a template (shirt + pants, 585 x 559) from a normal canvas; files without it are templates
  const out = { app: 'stitch-studio', version: 1, kind: set.kind || 'template', width: set.w || TW, height: set.h || TH, name: set.name, mode: set.mode, docs: {}, swatches: set.swatches };
  for (const k of Object.keys(set.docs)) {
    const d = set.docs[k];
    out.docs[k] = { active: d.layers.findIndex(l => l.id === d.activeId), counter: d.counter, groups: d.groups || [], layers: d.layers.map(l => ({ name: l.name, kind: l.kind, vec: l.vec || null, group: l.group || null, locked: !!l.locked, ...(l.mirror ? { mirror: true } : {}), visible: l.visible, opacity: l.opacity, blend: l.blend, png: l.canvas.toDataURL('image/png'), ...(l.mask ? { mask: l.mask.toDataURL('image/png'), maskOff: !!l.maskOff } : {}) })) };
  }
  return out;
}
function stashSet() { const s = state.sets[state.setIdx]; if (!s) return null; s.docs = state.docs; s.swatches = state.swatches; s.mode = state.mode; return s; }
function serialize() { return JSON.stringify(serializeSet(stashSet())); }
const defaultSwatches = () => [{ id: 'sw1', name: 'Main', paint: { type: 'color', color: '#372a57' } }, { id: 'sw2', name: 'Accent', paint: { type: 'color', color: '#d5cfff' } }, { id: 'sw3', name: 'Trim', paint: { type: 'color', color: '#111111' } }];
const newProjectId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MAX_SIDE = 8000;
const clampSide = (v, d) => Math.max(1, Math.min(MAX_SIDE, Math.round(+v) || d));
// a set is one project (one tab). kind 'template' = Roblox shirt + pants, always 585 x 559; 'canvas' = one plain image of any size
function makeSet(name, kind = 'template', w = TW, h = TH) {
  const canvas = kind === 'canvas'; if (!canvas) { w = TW; h = TH; }
  const docs = canvas ? { canvas: newDoc('canvas', w, h) } : { shirt: newDoc('shirt', w, h), pants: newDoc('pants', w, h) };
  return { id: newProjectId(), name: name || 'Untitled', kind: canvas ? 'canvas' : 'template', w, h, mode: canvas ? 'canvas' : 'shirt', docs, swatches: defaultSwatches() };
}
const placeholderSet = () => ({ ...makeSet('Untitled'), temp: true }); // shown behind Home when no project is open; never saved
// builds a set (tab) from saved .stitch data
async function buildSet(data, name, id) {
  if (data.app !== 'stitch-studio') throw new Error('Not a Stitch Editor project');
  const canvas = data.kind === 'canvas';
  const set = canvas ? makeSet(data.name || name, 'canvas', clampSide(data.width, 1920), clampSide(data.height, 1080)) : makeSet(data.name || name);
  if (id) set.id = id; if (data.updated) set.updated = data.updated;
  if (Array.isArray(data.swatches)) set.swatches = data.swatches; if (data.mode && !canvas) set.mode = data.mode;
  const prevSw = state.swatches; state.swatches = set.swatches; // fill layers look up their colours while loading
  try { await fillDocs(set, data); } finally { state.swatches = prevSw; }
  return set;
}
async function deserialize(text) { const set = await buildSet(JSON.parse(text)); state.docs = set.docs; state.swatches = set.swatches; }
async function fillDocs(set, data) {
  for (const k of Object.keys(set.docs)) {
    const src = data.docs?.[k]; if (!src) continue;
    const d = newDoc(k, set.w, set.h); d.layers = []; d.counter = src.counter || src.layers.length;
    for (const o of src.layers) {
      const l = makeLayer(o.name, set.w, set.h); Object.assign(l, { kind: o.kind || 'Layer', group: o.group || null, locked: !!o.locked, mirror: !!o.mirror, visible: o.visible, opacity: o.opacity, blend: o.blend });
      const img = new Image(); img.src = o.png; await img.decode(); l.ctx.drawImage(img, 0, 0);
      if (o.mask) { const mi = new Image(); mi.src = o.mask; await mi.decode(); l.mask = mkCanvas(set.w, set.h); l.mask.getContext('2d', { willReadFrequently: true }).drawImage(mi, 0, 0); l.maskOff = !!o.maskOff; } if (o.vec) { l.vec = o.vec; if (o.vec.type === 'fill') { await loadFillMask(o.vec.mask, set.w, set.h); renderFill(l); } if (o.vec.type === 'text') loadFont(o.vec.family).then(() => { renderVec(l); requestRender(); }); } d.layers.push(l);
    }
    if (!d.layers.length) d.layers.push(makeLayer('Layer 1', set.w, set.h));
    d.groups = src.groups || []; normalizeGroups(d);
    d.activeId = (d.layers[src.active] || d.layers[d.layers.length - 1]).id;
    set.docs[k] = d;
  }
}
$('#btnSave').onclick = () => saveText(serialize(), (state.sets[state.setIdx].name || 'my-outfit').replace(/[\\/:*?"<>|]+/g, '') + '.stitch', 'Stitch Editor project', ['stitch']);
$('#btnOpen').onclick = () => $('#fileProject').click();
$('#fileProject').onchange = async (e) => { const fl = [...e.target.files]; e.target.value = ''; if (fl.length) await openFiles(fl); };
$('#btnNew').onclick = () => {
  if (!confirm(`Clear ${isTemplate() ? `the ${state.mode} template` : 'the canvas'} and start fresh? (You can undo this.)`)) return;
  structOp(() => { const d = doc(); d.layers = [makeLayer('Layer 1')]; d.activeId = d.layers[0].id; d.counter = 1; }, 'New');
};

async function importImage(file, fresh) {
  const img = new Image(); img.src = URL.createObjectURL(file);
  try { await img.decode(); } catch { toast('Could not read ' + file.name); return; }
  structOp(() => {
    const d0 = doc(), blank = fresh && d0.layers.length === 1 && !contentBounds(d0.layers[0]);
    const l = blank ? d0.layers[0] : addLayer(file.name.replace(/\.[^.]+$/, '')), c = l.ctx; l.kind = 'Image'; l.name = file.name.replace(/\.[^.]+$/, '');
    if (img.width === W && img.height === H) c.drawImage(img, 0, 0);
    else {
      const r = currentRegion(); const [tx, ty, tw, th] = r.id === 'all' ? [0, 0, W, H] : boundsOf(r.rects);
      const s = Math.min(1, tw / img.width, th / img.height), w = img.width * s, h = img.height * s;
      c.imageSmoothingQuality = 'high'; c.drawImage(img, Math.round(tx + (tw - w) / 2), Math.round(ty + (th - h) / 2), Math.round(w), Math.round(h));
    }
  }, 'Import image');
  URL.revokeObjectURL(img.src);
  toast(img.width === W && img.height === H ? 'Imported template ' + file.name : `Imported ${file.name} - use Arrange or “Fit to selection” to place it`);
}
$('#btnImport').onclick = () => $('#fileImage').click();
$('#fileImage').onchange = async (e) => { for (const f of e.target.files) await importImage(f); e.target.value = ''; };
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => { e.preventDefault(); if (e.dataTransfer.files.length) await openFiles([...e.dataTransfer.files]); });

// ------------------------------------------------------------------ project library + autosave
// every tab is a project saved on its own (main.js "Project library"); autosave.stitch only remembers which ones are open
const lib = native?.projectsList ? {
  list: () => native.projectsList(), read: (id) => native.projectRead(id),
  write: (id, data, meta) => native.projectWrite(id, data, meta), remove: (id) => native.projectDelete(id),
  setFolder: (id, folder) => native.projectSetFolder(id, folder),
  versions: (id) => native.projectVersions(id), versionRead: (id, file) => native.projectVersionRead(id, file), snapshot: (id) => native.projectSnapshot(id),
} : { // plain browser: projects live in localStorage (no version history)
  async setFolder(id, folder) { const k = 'stitch-meta:' + id, m = JSON.parse(localStorage.getItem(k)); if (folder) m.folder = folder; else delete m.folder; localStorage.setItem(k, JSON.stringify(m)); },
  async list() { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('stitch-meta:')) try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } } return out.sort((a, b) => (b.updated || 0) - (a.updated || 0)); },
  async read(id) { return localStorage.getItem('stitch-proj:' + id); },
  async write(id, data, meta) { const old = JSON.parse(localStorage.getItem('stitch-meta:' + id) || '{}'); if (!('folder' in meta) && old.folder) meta = { ...meta, folder: old.folder }; localStorage.setItem('stitch-proj:' + id, data); localStorage.setItem('stitch-meta:' + id, JSON.stringify(meta)); },
  async remove(id) { localStorage.removeItem('stitch-proj:' + id); localStorage.removeItem('stitch-meta:' + id); },
};
// the picture on a Home card: shirt and pants side by side for templates, the whole image for a normal canvas
function projectThumb(set) {
  if (set.kind === 'canvas') {
    const d = set.docs.canvas; compositeDoc(d);
    const s = Math.min(1, 360 / set.w, 225 / set.h), c = mkCanvas(Math.max(1, Math.round(set.w * s)), Math.max(1, Math.round(set.h * s))), x = c.getContext('2d');
    x.imageSmoothingQuality = 'high'; x.drawImage(d.comp, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', .85);
  }
  const pw = 176, ph = Math.round(pw * TH / TW), gap = 8, c = mkCanvas(pw * 2 + gap, ph), x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  ['shirt', 'pants'].forEach((k, i) => { const d = set.docs[k]; compositeDoc(d); x.drawImage(d.comp, i * (pw + gap), 0, pw, ph); if (templateReady()) x.drawImage(templateImg, i * (pw + gap), 0, pw, ph); });
  return c.toDataURL('image/webp', .85);
}
async function saveProject(st) {
  st.updated = Date.now();
  const data = serializeSet(st); data.updated = st.updated;
  await lib.write(st.id, JSON.stringify(data), { id: st.id, name: st.name, kind: st.kind, width: st.w, height: st.h, updated: st.updated, thumb: projectThumb(st) });
}
let autosaveTimer, sessionReady = false, saving = Promise.resolve();
// marks a project as changed; it's saved (with the list of open tabs) shortly after
function scheduleAutosave(st = state.sets[state.setIdx]) { if (st && !st.temp) st.dirty = true; saveSessionSoon(); }
function saveSessionSoon() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(saveDirty, 1500); }
function saveDirty() {
  clearTimeout(autosaveTimer);
  const run = async () => {
    stashSet();
    for (const st of state.sets) if (st.dirty && !st.temp) { st.dirty = false; try { await saveProject(st); } catch (err) { st.dirty = true; console.error('save failed', err); } }
    await saveSession();
  };
  return (saving = saving.then(run, run)); // one save at a time
}
async function saveSession() {
  if (!sessionReady) return;
  const cur = state.sets[state.setIdx];
  const data = JSON.stringify({ app: 'stitch-studio', session: 1, open: state.sets.filter(s => !s.temp).map(s => s.id), active: cur && !cur.temp ? cur.id : null });
  try { if (native) await native.autosaveWrite(data); else localStorage.setItem('stitch-autosave', data); } catch { /* storage full or unavailable */ }
}
// reopens last time's tabs. A 0.3.x autosave (every tab in one file) is moved into the library as separate projects.
async function loadSession() {
  let raw = null, j = null;
  try { raw = native ? await native.autosaveRead() : localStorage.getItem('stitch-autosave'); } catch { raw = null; }
  try { j = raw ? JSON.parse(raw) : null; } catch { j = null; }
  if (!j || j.app !== 'stitch-studio') return { hadData: false };
  const sets = []; let active = null;
  if (j.session) {
    for (const id of j.open || []) { try { const txt = await lib.read(id); if (txt) sets.push(await buildSet(JSON.parse(txt), 'Untitled', id)); } catch (err) { console.error('could not reopen', id, err); } }
    active = j.active;
  } else {
    const used = (st) => Object.values(st.docs).some(d => d.layers.length > 1 || d.layers.some(l => l.vec || contentBounds(l)));
    for (const sd of j.version === 2 && Array.isArray(j.sets) ? j.sets : [j]) {
      try { const st = await buildSet(sd, 'Untitled'); if (used(st)) { await saveProject(st); sets.push(st); } } catch (err) { console.error('could not move project', err); }
    }
    active = sets[Math.min(j.active || 0, sets.length - 1)]?.id;
  }
  if (sets.length) { state.sets = sets; state.setIdx = Math.max(0, sets.findIndex(s => s.id === active)); }
  return { hadData: true };
}
// ------------------------------------------------------------------ keyboard
// Every shortcut is a command with a default key; Help → Keyboard shortcuts (or ?) lists them and lets you change them.
// Changed keys are kept in localStorage "stitch-keys" ({ command id: key, or '' for none }).
const stepSize = (dir) => { const v = curSize(); setSize(dir < 0 ? v - (v > 50 ? 10 : v > 10 ? 2 : 1) : v + (v >= 50 ? 10 : v >= 10 ? 2 : 1)); };
const toggleLock = () => { const l = activeLayer(); propChange(l, 'locked', !l.locked, l.locked ? 'Unlock layer' : 'Lock layer'); };
const TOOL_NAMES = { move: 'Move', select: 'Select', lasso: 'Lasso', wand: 'Magic select', brush: 'Brush', eraser: 'Eraser', pencil: 'Pencil', fill: 'Fill bucket', gradient: 'Gradient', eyedropper: 'Eyedropper', shape: 'Shape', pen: 'Pen', text: 'Text', hand: 'Hand' };
const COMMANDS = [
  ...Object.entries({ move: 'V', select: 'M', lasso: 'L', wand: 'W', brush: 'B', eraser: 'E', pencil: 'P', fill: 'G', gradient: 'D', eyedropper: 'I', shape: 'U', pen: 'K', text: 'T', hand: 'H' })
    .map(([t, key]) => ({ id: 'tool.' + t, group: 'Tools', label: TOOL_NAMES[t], key, run: () => setTool(t) })),
  { id: 'swap', group: 'Tools', label: 'Swap colours', key: 'X', run: swapColors },
  { id: 'sizeDown', group: 'Tools', label: 'Smaller brush', key: '[', run: () => stepSize(-1) },
  { id: 'sizeUp', group: 'Tools', label: 'Bigger brush', key: ']', run: () => stepSize(1) },
  { id: 'undo', group: 'Edit', label: 'Undo', key: 'Ctrl+Z', run: undo },
  { id: 'redo', group: 'Edit', label: 'Redo', key: 'Ctrl+Y', also: ['Ctrl+Shift+Z'], run: redo },
  { id: 'copy', group: 'Edit', label: 'Copy', key: 'Ctrl+C', run: () => copySel(false) },
  { id: 'cut', group: 'Edit', label: 'Cut', key: 'Ctrl+X', run: () => copySel(true) },
  { id: 'delete', group: 'Edit', label: 'Delete layer or selected pixels', key: 'Delete', also: ['Backspace'], run: () => { if (hasSel) clearSelectedPixels(); else $('#lyDel').click(); } },
  { id: 'selectAll', group: 'Select', label: 'Select all', key: 'Ctrl+A', run: selectAll },
  { id: 'deselect', group: 'Select', label: 'Deselect', key: 'Ctrl+Shift+A', run: deselect },
  { id: 'invert', group: 'Select', label: 'Invert selection', key: 'Ctrl+Shift+I', run: invertSelection },
  { id: 'newLayer', group: 'Layers', label: 'New layer', key: 'Ctrl+Shift+N', run: () => $('#lyAdd').click() },
  { id: 'dup', group: 'Layers', label: 'Duplicate layer', key: 'Ctrl+J', also: ['Ctrl+D'], run: () => $('#lyDup').click() },
  { id: 'rename', group: 'Layers', label: 'Rename layer', key: 'F2', run: renameActive },
  { id: 'merge', group: 'Layers', label: 'Merge down', key: 'Ctrl+M', run: () => $('#lyMerge').click() },
  { id: 'mergeVisible', group: 'Layers', label: 'Merge visible', key: 'Ctrl+Shift+M', run: mergeVisible },
  { id: 'group', group: 'Layers', label: 'Group layers', key: 'Ctrl+G', run: groupLayers },
  { id: 'ungroup', group: 'Layers', label: 'Ungroup', key: 'Ctrl+Shift+G', run: ungroupLayers },
  { id: 'layerUp', group: 'Layers', label: 'Move layer up', key: 'Ctrl+]', run: () => $('#lyUp').click() },
  { id: 'layerDown', group: 'Layers', label: 'Move layer down', key: 'Ctrl+[', run: () => $('#lyDown').click() },
  { id: 'lock', group: 'Layers', label: 'Lock / unlock layer', key: 'Ctrl+/', run: toggleLock },
  { id: 'mirror', group: 'Layers', label: 'Mirror on / off', key: 'Shift+M', run: () => toggleMirror() },
  { id: 'symRL', group: 'Layers', label: 'Symmetrize right → left', key: '', run: () => $('#lySymRL').click() },
  { id: 'symLR', group: 'Layers', label: 'Symmetrize left → right', key: '', run: () => $('#lySymLR').click() },
  { id: 'zoomIn', group: 'View', label: 'Zoom in', key: '=', also: ['+'], run: () => setZoom(state.zoom * 1.25) },
  { id: 'zoomOut', group: 'View', label: 'Zoom out', key: '-', run: () => setZoom(state.zoom / 1.25) },
  { id: 'zoomFit', group: 'View', label: 'Fit to window', key: '0', also: ['Ctrl+0'], run: zoomFit },
  { id: 'zoom100', group: 'View', label: 'Actual size', key: '1', run: () => setZoom(1) },
  { id: 'pairView', group: 'View', label: 'Shirt and pants side by side', key: '', run: () => { if (isTemplate()) setPair(!pairPref); } },
  { id: 'toggleMode', group: 'View', label: 'Switch Shirt / Pants', key: 'Tab', run: () => { if (isTemplate()) setMode(state.mode === 'shirt' ? 'pants' : 'shirt'); } },
  { id: 'shortcuts', group: 'View', label: 'Keyboard shortcuts', key: '?', run: () => openShortcuts() },
  { id: 'newProject', group: 'Files', label: 'New project', key: 'Ctrl+N', run: () => openNewProjectDialog() },
  { id: 'open', group: 'Files', label: 'Open', key: 'Ctrl+O', run: () => $('#btnOpen').click() },
  { id: 'save', group: 'Files', label: 'Save project (.stitch)', key: 'Ctrl+S', run: () => $('#btnSave').click() },
  { id: 'import', group: 'Files', label: 'Import image as layer', key: 'Ctrl+I', run: () => $('#btnImport').click() },
  { id: 'exportPng', group: 'Files', label: 'Export PNG', key: 'Ctrl+E', run: () => exportPng() },
  { id: 'exportSet', group: 'Files', label: 'Export set (shirt + pants)', key: 'Ctrl+Shift+E', run: () => exportSet() },
  { id: 'closeTab', group: 'Files', label: 'Close tab', key: 'Ctrl+W', run: () => closeSet(state.setIdx) },
  { id: 'nextTab', group: 'Files', label: 'Next tab', key: 'Ctrl+Tab', run: () => switchSet((state.setIdx + 1) % state.sets.length) },
  { id: 'prevTab', group: 'Files', label: 'Previous tab', key: 'Ctrl+Shift+Tab', run: () => switchSet((state.setIdx + state.sets.length - 1) % state.sets.length) },
];
// keys that always do the same thing, shown in the list but not changeable
const FIXED_KEYS = [
  ['Paste as a new layer', 'Ctrl+V'], ['Pan the canvas', 'Hold Space'], ['Pick a colour with most tools', 'Alt+click'],
  ['Straight line (brush, pencil)', 'Shift+click'], ['Nudge the layer (Move)', 'Arrow keys'], ['Cancel / deselect', 'Esc'],
  ['Skip snapping while moving', 'Hold Ctrl'], ['Full screen', 'F11'],
];
const RESERVED = new Set(['Ctrl+V', 'Space', 'Escape', 'Enter', 'F11', 'F12', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown']);
let keyOverrides = null; // read at boot (rebuildKeyMap), once the storage helpers exist
const keysOf = (c) => c.id in keyOverrides ? (keyOverrides[c.id] ? [keyOverrides[c.id]] : []) : [c.key, ...(c.also || [])].filter(Boolean); // a command may start with no key
const keyOf = (id) => { const c = COMMANDS.find(x => x.id === id); return c ? keysOf(c)[0] || '' : ''; };
let keyMap = new Map();
function rebuildKeyMap() { keyOverrides ??= store.get('stitch-keys') || {}; keyMap = new Map(); for (const c of COMMANDS) for (const k of keysOf(c)) if (!keyMap.has(k)) keyMap.set(k, c); refreshKeyHints(); }
// "Ctrl+Shift+Z", "?", "F2" ... Shift is left out for symbols it already changes (Shift+/ is "?")
function comboOf(e) {
  let k = e.key; if (!k || ['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  if (k === ' ') k = 'Space'; else if (k === 'Del') k = 'Delete'; else if (k.length === 1) k = k.toUpperCase();
  const symbol = k.length === 1 && !/[A-Z0-9]/.test(k);
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && !symbol ? 'Shift+' : '') + k;
}
// tooltips that mention a shortcut follow the current keys
const KEY_HINTS = { btnUndo: 'undo', btnRedo: 'redo', btnExport: 'exportPng', zoomFit: 'zoomFit', zoom100: 'zoom100', lyMerge: 'merge', lyAdd: 'newLayer', lyDup: 'dup', btnSwap: 'swap', zoomIn: 'zoomIn', zoomOut: 'zoomOut' };
function refreshKeyHints() {
  for (const [id, cmd] of Object.entries(KEY_HINTS)) { const b = document.getElementById(id); if (!b?.title) continue; const k = keyOf(cmd); b.title = b.title.replace(/\s*\([^)]*\)$/, '') + (k ? ` (${k})` : ''); }
  for (const t of Object.keys(TOOL_NAMES)) if (TIPS[t]) TIPS[t][2] = keyOf('tool.' + t);
}
const TEXT_EDIT_KEYS = new Set(['Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Delete', 'Backspace']);
document.addEventListener('keydown', e => {
  if (homeOpen()) {
    if (document.querySelector('.modal')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'n') { e.preventDefault(); openNewProjectDialog(); }
    else if (mod && k === 'o') { e.preventDefault(); $('#btnOpen').click(); }
    else if ((mod && k === 'f') || (k === '/' && !e.target.matches('input, textarea'))) { e.preventDefault(); $('#homeSearch').focus(); }
    else if (k === 'escape' && !$('#homeBack').hidden) hideHome();
    return;
  }
  const inField = e.target.matches('input, textarea, select');
  if (inField && !(e.ctrlKey || e.metaKey)) return;
  if (!$('#textModal').hidden || !$('#adjModal').hidden || document.querySelector('.modal.dlg-open, .modal:not([id])')) return;
  const k = e.key.toLowerCase();
  // keys that depend on what is going on right now
  if (!inField) {
    if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
    if ((k === 'delete' || k === 'backspace') && state.tool === 'pen' && deletePenPoint()) { e.preventDefault(); return; }
    if (k === 'enter' && penDraw) { finishPath(); return; }
    if (k === 'enter' && lasso) { finishLasso(); return; }
    if (k === 'escape') { if (penDraw) finishPath(); else if (lasso) { lasso = null; selPreview = null; drawOverlay(); } else if (op) cancelOp(); else if (hasSel) deselect(); return; }
    // arrows nudge with Move, and with Shape/Text when they have their layer grabbed
    const nudges = state.tool === 'move' || (state.tool === 'shape' && state.shape.mode === 'design' && activeVec('shape')) || (state.tool === 'text' && activeVec('text'));
    if (nudges && k.startsWith('arrow') && !(e.ctrlKey || e.metaKey)) {
      e.preventDefault(); const s = e.shiftKey ? 10 : 1;
      nudge(k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, k === 'arrowup' ? -s : k === 'arrowdown' ? s : 0); return;
    }
  }
  const combo = comboOf(e); if (!combo) return;
  if (inField && TEXT_EDIT_KEYS.has(combo)) return; // let text boxes copy, paste and undo their own text
  const cmd = keyMap.get(combo);
  if (cmd) { e.preventDefault(); cmd.run(e); }
  else if (e.ctrlKey || e.metaKey) { if (combo !== 'Ctrl+V' && /^Ctrl\+(Shift\+)?[A-Z0-9]$/.test(combo) && !inField) e.preventDefault(); } // no browser shortcuts (print, find...) inside the editor
});
document.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });

function openShortcuts() {
  const body = el('div', 'keys');
  const intro = el('p', 'np-note'); intro.textContent = 'Click a shortcut to change it, then press the new keys. Esc cancels.'; body.append(intro);
  const list = el('div', 'keys-list'); body.append(list);
  let capturing = null;
  const stopCapture = () => { if (!capturing) return; window.removeEventListener('keydown', capturing.fn, true); capturing.btn.classList.remove('listening'); capturing = null; };
  const draw = () => {
    stopCapture(); list.innerHTML = '';
    for (const g of [...new Set(COMMANDS.map(c => c.group))]) {
      const h = el('div', 'keys-h'); h.textContent = g; list.append(h);
      for (const c of COMMANDS.filter(x => x.group === g)) {
        const row = el('div', 'keys-row'), lab = el('span'); lab.textContent = c.label;
        const keys = keysOf(c), btn = el('button', 'kbd-btn' + (keys.length ? '' : ' none')); btn.textContent = keys.length ? keys.join('  or  ') : 'None';
        btn.title = 'Click, then press the new keys';
        btn.onclick = () => {
          if (capturing?.btn === btn) { stopCapture(); return; } stopCapture();
          btn.classList.add('listening'); btn.textContent = 'Press keys…';
          const fn = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') { draw(); return; }
            const k = comboOf(e); if (!k) return;
            if (RESERVED.has(k)) { toast(`${k} can't be changed`); return; }
            const other = COMMANDS.find(x => x !== c && keysOf(x).includes(k));
            if (other) { keyOverrides[other.id] = keysOf(other).filter(x => x !== k)[0] || ''; toast(`${k} was “${other.label}” - that one has no shortcut now`); }
            keyOverrides[c.id] = k; saveKeys(); draw();
          };
          capturing = { btn, fn }; window.addEventListener('keydown', fn, true); // window: ahead of the dialog's own Esc/Enter keys
        };
        const clear = el('button', 'keys-x', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'); clear.title = 'No shortcut';
        clear.onclick = () => { keyOverrides[c.id] = ''; saveKeys(); draw(); };
        const reset = el('button', 'keys-x', '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/></svg>'); reset.title = `Back to ${[c.key, ...(c.also || [])].join(' or ')}`;
        reset.onclick = () => { delete keyOverrides[c.id]; for (const k of [c.key, ...(c.also || [])]) for (const x of COMMANDS) if (x !== c && x.id in keyOverrides && keyOverrides[x.id] === k) keyOverrides[x.id] = ''; saveKeys(); draw(); };
        reset.hidden = !(c.id in keyOverrides); clear.hidden = !keys.length;
        row.append(lab, reset, clear, btn); list.append(row);
      }
    }
    const h = el('div', 'keys-h'); h.textContent = 'Always'; list.append(h);
    for (const [label, key] of FIXED_KEYS) { const row = el('div', 'keys-row fixed'), lab = el('span'), kb = el('kbd'); lab.textContent = label; kb.textContent = key; row.append(lab, kb); list.append(row); }
  };
  const saveKeys = () => { store.set('stitch-keys', keyOverrides); rebuildKeyMap(); };
  draw();
  dlg('Keyboard shortcuts', body, { noFoot: false, okLabel: 'Done', cancelLabel: 'Reset all', center: true, outsideClose: true,
    onOk: () => stopCapture(),
    onCancel: () => { stopCapture(); },
    extra: [],
  });
  // "Reset all" is the left button: it asks first, then puts every key back
  const resetAll = [...document.querySelectorAll('.dlg .pill.ghost')].at(-1);
  if (resetAll) resetAll.onclick = () => confirmDlg('Reset all shortcuts', 'Put every keyboard shortcut back to how it came?', 'Reset', () => { keyOverrides = {}; saveKeys(); draw(); });
}

// ------------------------------------------------------------------ menu bar
let dlgPos = null;
const openDlgs = new Set(); // cancel functions of the dialogs on screen
function makeDraggable(handle, onMove, onEnd) {
  handle.style.cursor = 'move'; handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return;
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY;
    const mv = (ev) => { onMove(ev.clientX - lx, ev.clientY - ly); lx = ev.clientX; ly = ev.clientY; };
    const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); onEnd?.(); };
    handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up);
  });
}
// center: fixed in the middle of the window (not draggable); outsideClose: clicking outside the dialog cancels it
function dlg(title, bodyEl, { onOk, onCancel, okLabel = 'Apply', cancelLabel = 'Cancel', onClose, compare, extra, noFoot, center, outsideClose } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'modal';
  const box = document.createElement('div'); box.className = 'dlg';
  const head = document.createElement('div'); head.className = 'dlg-head';
  const h = document.createElement('span'); h.textContent = title;
  const x = document.createElement('button'); x.className = 'dlg-x'; x.title = 'Close'; x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  head.append(h, x);
  bodyEl.classList.add('dlg-body');
  const foot = document.createElement('div'); foot.className = 'dlg-foot';
  if (compare) {
    const cmp = document.createElement('button'); cmp.className = 'dlg-compare'; cmp.title = 'Hold to compare with the original';
    cmp.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 3v18"/><path d="M12 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7z" fill="currentColor" stroke="none" opacity=".55"/></svg>';
    cmp.addEventListener('pointerdown', (e) => { cmp.setPointerCapture(e.pointerId); cmp.classList.add('on'); compare.down(); });
    const up = () => { if (cmp.classList.contains('on')) { cmp.classList.remove('on'); compare.up(); } };
    cmp.addEventListener('pointerup', up); cmp.addEventListener('pointercancel', up);
    foot.append(cmp);
  }
  const sp = document.createElement('span'); sp.style.flex = '1'; foot.append(sp);
  if (extra) for (const ex of extra) { const b = document.createElement('button'); b.className = 'dlg-link'; b.textContent = ex.label; b.onclick = () => { ex.run(); if (!ex.keepOpen) close(); }; foot.append(b); }
  const cancel = document.createElement('button'); cancel.className = 'pill ghost'; cancel.textContent = cancelLabel;
  const ok = document.createElement('button'); ok.className = 'pill primary'; ok.textContent = okLabel;
  foot.append(cancel, ok);
  if (noFoot) foot.hidden = true;
  box.append(head, bodyEl, foot); wrap.append(box); document.body.append(wrap);
  wrap.classList.add('dlg-wrap');
  // place at the last position the user dragged a dialog to, or centred
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let px = dlgPos ? dlgPos.x : (window.innerWidth - bw) / 2, py = dlgPos ? dlgPos.y : (window.innerHeight - bh) / 2;
  const place = () => { px = Math.max(0, Math.min(window.innerWidth - bw, px)); py = Math.max(0, Math.min(window.innerHeight - 46, py)); box.style.left = px + 'px'; box.style.top = py + 'px'; };
  place();
  if (center) box.classList.add('dlg-center');
  else makeDraggable(head, (dx, dy) => { px += dx; py += dy; place(); }, () => { dlgPos = { x: px, y: py }; });
  const outside = (e) => { if (!box.contains(e.target)) doCancel(); };
  if (outsideClose) setTimeout(() => document.addEventListener('pointerdown', outside, true));
  const close = () => { openDlgs.delete(doCancel); fadeOut(box, () => wrap.remove()); document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside, true); };
  const doCancel = () => { onCancel?.(); close(); };
  const doOk = () => { if (onOk?.() !== false) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); doCancel(); } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.target.matches('input[type=text], input:not([type])')) { e.stopPropagation(); e.preventDefault(); doOk(); } };
  document.addEventListener('keydown', key, true);
  cancel.onclick = doCancel; x.onclick = () => { if (onClose) { onClose(); close(); } else doCancel(); }; ok.onclick = doOk;
  openDlgs.add(doCancel);
  return { wrap, close, cancel: doCancel };
}
const isModalOpen = () => !!document.querySelector('.modal:not([hidden])');

// Pixlr-style slider: label + value on top, full-width track below. track = CSS background for the track.
function slider(label, min, max, value, unit = '', track = '') {
  const row = document.createElement('div'); row.className = 'sl';
  row.innerHTML = `<div class="sl-top"><span></span><span class="sl-val"><input type="number" min="${min}" max="${max}" value="${value}"><em>${unit}</em></span></div><input class="sl-range" type="range" min="${min}" max="${max}" value="${value}">`;
  row.querySelector('span').textContent = label;
  const n = row.querySelector('input[type=number]'), r = row.querySelector('input[type=range]');
  if (track) r.style.setProperty('--trk', track);
  const fire = () => row.dispatchEvent(new Event('change', { bubbles: true }));
  r.oninput = () => { n.value = r.value; fire(); };
  n.oninput = () => { r.value = n.value; fire(); };
  row.value = () => +r.value;
  row.set = (v) => { r.value = n.value = v; };
  row.reset = () => row.set(value);
  r.ondblclick = () => { row.reset(); fire(); };
  return row;
}

// ---- pixel helpers
const clamp8 = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h, s, l];
}
function hsl2rgb(h, s, l) {
  if (!s) { const v = l * 255; return [v, v, v]; }
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t % 1 + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const ADJ = {
  bc: { title: 'Brightness and contrast', sliders: [['brightness', 'Brightness', -100, 100, 0], ['contrast', 'Contrast', -100, 100, 0]],
    lut(p) { const c = p.contrast * 2.55, f = (259 * (c + 255)) / (255 * (259 - c)), L = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) L[i] = clamp8(f * (i - 128) + 128 + p.brightness * 1.5); return [L, L, L]; } },
  hs: { title: 'Hue / Saturation', sliders: [['hue', 'Hue', -180, 180, 0, '°'], ['sat', 'Saturation', -100, 100, 0], ['light', 'Lightness', -100, 100, 0]],
    px(d, p) {
      const hs = p.hue / 360, sf = 1 + p.sat / 100, lf = p.light / 100;
      for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue;
        let [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]); h += hs; s = Math.min(1, s * sf); l = lf > 0 ? l + (1 - l) * lf : l + l * lf;
        const o = hsl2rgb(h, s, l); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; } } },
  vib: { title: 'Vibrance', sliders: [['vib', 'Vibrance', -100, 100, 0, '', 'linear-gradient(90deg,#8a8a8a,#3aa0c8 55%,#d9c03a 78%,#d2382f)'], ['sat', 'Saturation', -100, 100, 0, '', 'linear-gradient(90deg,#8a8a8a,#3aa0c8 55%,#d9c03a 78%,#d2382f)']],
    px(d, p) {
      const v = p.vib / 100, sf = 1 + p.sat / 100;
      for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), avg = (r + g + b) / 3;
        const sat = mx ? (mx - mn) / mx : 0, f = sf * (1 + v * (1 - sat) * (v > 0 ? 1.5 : 1));
        d[i] = avg + (r - avg) * f; d[i + 1] = avg + (g - avg) * f; d[i + 2] = avg + (b - avg) * f; } } },
  temp: { title: 'Temperature and tint', sliders: [['temp', 'Temperature', -100, 100, 0, '', 'linear-gradient(90deg,#3d7bd9,#9a9a9a,#e0a030)'], ['tint', 'Tint', -100, 100, 0, '', 'linear-gradient(90deg,#3fae5a,#9a9a9a,#c0479a)']],
    lut(p) { const t = p.temp * .45, n = p.tint * .45, mk = (o) => { const L = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) L[i] = clamp8(i + o); return L; };
      return [mk(t + n * .3), mk(-n), mk(-t + n * .3)]; } },
};

// monotone cubic interpolation through points [[x,y],...] -> 256 LUT
function curveLUT(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0]), n = P.length, L = new Uint8ClampedArray(256);
  if (n < 2) { for (let i = 0; i < 256; i++) L[i] = i; return L; }
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0] || 1e-6; m[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) { if (!m[i]) { t[i] = t[i + 1] = 0; continue; } const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b; if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; } }
  for (let x = 0; x < 256; x++) {
    if (x <= P[0][0]) { L[x] = P[0][1]; continue; } if (x >= P[n - 1][0]) { L[x] = P[n - 1][1]; continue; }
    let i = 0; while (x > P[i + 1][0]) i++;
    const h = dx[i], u = (x - P[i][0]) / h, u2 = u * u, u3 = u2 * u;
    L[x] = (2 * u3 - 3 * u2 + 1) * P[i][1] + (u3 - 2 * u2 + u) * h * t[i] + (-2 * u3 + 3 * u2) * P[i + 1][1] + (u3 - u2) * h * t[i + 1];
  }
  return L;
}

function blendW(d, src, w) {
  for (let p = 0, i = 0; p < w.length; p++, i += 4) { const k = w[p] / 255; if (k >= 1) continue; for (let c = 0; c < 4; c++) d[i + c] = src[i + c] + (d[i + c] - src[i + c]) * k; }
}
function runAdjust(title, buildBody, compute) {
  const o = beginOp({ raster: true }); if (!o) return;
  const wts = combinedWeights(), src = o.before.data;
  let raf = 0;
  const preview = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => {
    const out = new ImageData(new Uint8ClampedArray(src), W, H), d = out.data; compute(d);
    if (wts) blendW(d, src, wts);
    o.l.ctx.putImageData(out, 0, 0); requestRender();
  }); };
  const body = buildBody(preview);
  body.addEventListener('change', preview);
  dlg(title, body, {
    compare: { down: () => { cancelAnimationFrame(raf); restoreOp(o); requestRender(); }, up: preview },
    onOk: () => { cancelAnimationFrame(raf); const out = new ImageData(new Uint8ClampedArray(src), W, H); compute(out.data);
      if (wts) blendW(out.data, src, wts);
      o.l.ctx.putImageData(out, 0, 0); labelled(title, () => commitOp(o)); },
    onCancel: () => { cancelAnimationFrame(raf); restoreOp(o); requestRender(); },
  });
  preview();
}
function openAdjust(kind) {
  const A = ADJ[kind];
  let rows;
  runAdjust(A.title, () => {
    const body = document.createElement('div'); body.className = 'adj-body';
    rows = A.sliders.map(([k, label, mn, mx, v, u, trk]) => { const r = slider(label, mn, mx, v, u, trk); r.dataset.k = k; body.append(r); return r; });
    const reg = currentRegion();
    if (reg.id !== 'all' || hasSel) { const note = document.createElement('p'); note.className = 'adj-note'; note.textContent = 'Only inside ' + [hasSel ? 'the selection' : '', reg.id !== 'all' ? reg.label : ''].filter(Boolean).join(' and '); body.append(note); }
    return body;
  }, (d) => {
    const p = {}; for (const r of rows) p[r.dataset.k] = r.value();
    if (A.lut) { const [R, G, B] = A.lut(p); for (let i = 0; i < d.length; i += 4) { d[i] = R[d[i]]; d[i + 1] = G[d[i + 1]]; d[i + 2] = B[d[i + 2]]; } }
    else A.px(d, p);
  });
}

// ---- Hue and saturation (Pixlr style: ranges + colorize)
const HS_RANGES = [['master', '#d8d8d8', null], ['reds', '#d8361e', 0], ['yellows', '#c9bd1f', 60], ['greens', '#5fae2a', 120], ['cyans', '#2fb3b8', 180], ['blues', '#3a5be6', 240], ['magentas', '#c43a8f', 300]];
const HUE_TRACK = 'linear-gradient(90deg,hsl(180,75%,50%),hsl(240,75%,55%),hsl(300,75%,50%),hsl(360,75%,50%),hsl(420,75%,50%),hsl(480,75%,45%),hsl(540,75%,50%))';
function openHueSat() {
  const vals = Object.fromEntries(HS_RANGES.map(([k]) => [k, { hue: 0, sat: 0, light: 0 }]));
  let cur = 'master', colorize = false, hue, sat, light, swatches;
  runAdjust('Hue and saturation', () => {
    const body = document.createElement('div'); body.className = 'adj-body';
    const rl = document.createElement('div'); rl.className = 'sl-label'; rl.textContent = 'Range';
    swatches = document.createElement('div'); swatches.className = 'swatches';
    for (const [k, c] of HS_RANGES) {
      const b = document.createElement('button'); b.className = 'swatch' + (k === cur ? ' on' : ''); b.style.setProperty('--c', c); b.title = k[0].toUpperCase() + k.slice(1);
      b.onclick = () => { if (colorize) return; cur = k; swatches.querySelectorAll('.swatch').forEach(x => x.classList.toggle('on', x === b)); sync(); };
      swatches.append(b);
    }
    hue = slider('Hue', -180, 180, 0, '', HUE_TRACK);
    sat = slider('Saturation', -100, 100, 0, '', 'linear-gradient(90deg,#8a8a8a,#3aa0c8 55%,#d9c03a 78%,#d2382f)');
    light = slider('Lightness', -100, 100, 0, '', 'linear-gradient(90deg,#111,#666,#e8e8e8)');
    const sync = () => { hue.set(vals[cur].hue); sat.set(vals[cur].sat); light.set(vals[cur].light); };
    for (const [row, k] of [[hue, 'hue'], [sat, 'sat'], [light, 'light']]) row.addEventListener('change', () => { vals[cur][k] = row.value(); });
    const cz = document.createElement('label'); cz.className = 'switch-row';
    cz.innerHTML = '<span>Colorize</span><input type="checkbox" class="switch">';
    cz.querySelector('input').onchange = (e) => {
      colorize = e.target.checked; cur = 'master'; swatches.classList.toggle('disabled', colorize);
      swatches.querySelectorAll('.swatch').forEach((x, i) => x.classList.toggle('on', i === 0));
      hue.querySelector('.sl-range').min = hue.querySelector('input[type=number]').min = colorize ? 0 : -180;
      hue.querySelector('.sl-range').max = hue.querySelector('input[type=number]').max = colorize ? 360 : 180;
      hue.querySelector('.sl-range').style.setProperty('--trk', colorize ? 'linear-gradient(90deg,hsl(0,75%,50%),hsl(60,75%,50%),hsl(120,75%,45%),hsl(180,75%,50%),hsl(240,75%,55%),hsl(300,75%,50%),hsl(360,75%,50%))' : HUE_TRACK);
      if (colorize) { vals.master = { hue: 200, sat: 25, light: 0 }; } else { vals.master = { hue: 0, sat: 0, light: 0 }; }
      sync(); body.dispatchEvent(new Event('change'));
    };
    body.append(rl, swatches, hue, sat, light, cz);
    const reg = currentRegion();
    if (reg.id !== 'all' || hasSel) { const note = document.createElement('p'); note.className = 'adj-note'; note.textContent = 'Only inside ' + [hasSel ? 'the selection' : '', reg.id !== 'all' ? reg.label : ''].filter(Boolean).join(' and '); body.append(note); }
    return body;
  }, (d) => {
    const M = vals.master;
    if (colorize) {
      const h = ((M.hue % 360) + 360) % 360 / 360, s = Math.max(0, Math.min(1, (M.sat + 100) / 200)), lf = M.light / 100;
      for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue;
        let l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255; l = lf > 0 ? l + (1 - l) * lf : l + l * lf;
        const o = hsl2rgb(h, s, l); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; }
      return;
    }
    const ranges = HS_RANGES.slice(1).filter(([k]) => vals[k].hue || vals[k].sat || vals[k].light);
    if (!M.hue && !M.sat && !M.light && !ranges.length) return;
    for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue;
      let [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
      let dh = M.hue, ds = M.sat, dl = M.light;
      if (ranges.length && s > 0.02) {
        const deg = h * 360;
        for (const [k, , c] of ranges) {
          let dist = Math.abs(deg - c); if (dist > 180) dist = 360 - dist;
          const w = Math.max(0, Math.min(1, 1 - (dist - 15) / 30)) * Math.min(1, s * 4);
          if (w) { dh += vals[k].hue * w; ds += vals[k].sat * w; dl += vals[k].light * w; }
        }
      }
      h += dh / 360; s = ds >= 0 ? s + (1 - s) * Math.min(1, ds / 100) * (s > 0 ? 1 : 0) : s * (1 + ds / 100);
      const lf = dl / 100; l = lf > 0 ? l + (1 - l) * lf : l + l * lf;
      const o = hsl2rgb(h, Math.max(0, Math.min(1, s)), l); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
    }
  });
}
function openCurves() {
  const curves = { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] };
  let ch = 'rgb';
  runAdjust('Curves', (preview) => {
    const body = document.createElement('div'); body.className = 'adj-body curves';
    const sel = document.createElement('div'); sel.className = 'seg';
    for (const [k, t] of [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]) { const b = document.createElement('button'); b.textContent = t; b.className = k === ch ? 'on' : ''; b.onclick = () => { ch = k; sel.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); draw(); }; sel.append(b); }
    const cv = document.createElement('canvas'); cv.width = cv.height = 512; cv.className = 'curve-canvas';
    const g = cv.getContext('2d');
    const hint = document.createElement('p'); hint.className = 'adj-note'; hint.textContent = 'Click to add a point · drag to move · drag a point off the graph or double-click it to remove';
    const reset = document.createElement('button'); reset.className = 'mini'; reset.textContent = 'Reset channel'; reset.onclick = () => { curves[ch] = [[0, 0], [255, 255]]; draw(); preview(); };
    const top = document.createElement('div'); top.className = 'curve-top'; top.append(sel, reset);
    body.append(top, cv, hint);
    const col = { rgb: '#e6e8ee', r: '#ff5c5c', g: '#4fd67a', b: '#5b8cff' };
    function draw() {
      g.clearRect(0, 0, 512, 512); g.fillStyle = '#16181d'; g.fillRect(0, 0, 512, 512);
      g.strokeStyle = '#2c303a'; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 512); g.moveTo(0, i * 128); g.lineTo(512, i * 128); g.stroke(); }
      g.strokeStyle = '#3a3f4b'; g.beginPath(); g.moveTo(0, 512); g.lineTo(512, 0); g.stroke();
      for (const k of ['r', 'g', 'b', 'rgb']) { if (k !== ch && (k === 'rgb' || curves[k].length === 2 && curves[k][0][1] === 0 && curves[k][1][1] === 255)) continue;
        const L = curveLUT(curves[k]); g.strokeStyle = col[k]; g.globalAlpha = k === ch ? 1 : .35; g.lineWidth = 2.5; g.beginPath();
        for (let x = 0; x < 256; x++) { const px = x * 2 + 1, py = 511 - L[x] * 2; x ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke(); }
      g.globalAlpha = 1;
      for (const [x, y] of curves[ch]) { g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.arc(x * 2 + 1, 511 - y * 2, 7, 0, Math.PI * 2); g.fill(); g.stroke(); }
    }
    const toPt = (e) => { const r = cv.getBoundingClientRect(); return [Math.round(clamp8((e.clientX - r.left) / r.width * 255)), Math.round(clamp8(255 - (e.clientY - r.top) / r.height * 255))]; };
    const hit = (p) => curves[ch].findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 10);
    let drag = -1;
    cv.addEventListener('pointerdown', (e) => {
      const p = toPt(e); let i = hit(p);
      if (i < 0) { curves[ch].push(p); curves[ch].sort((a, b) => a[0] - b[0]); i = curves[ch].indexOf(p); }
      drag = i; cv.setPointerCapture(e.pointerId); draw(); preview();
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const r = cv.getBoundingClientRect(), pts = curves[ch], p = toPt(e);
      const out = e.clientY < r.top - 30 || e.clientY > r.bottom + 30 || e.clientX < r.left - 30 || e.clientX > r.right + 30;
      if (out && pts.length > 2) { pts.splice(drag, 1); drag = -1; draw(); preview(); return; }
      const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255;
      pts[drag] = [Math.max(lo, Math.min(hi, p[0])), p[1]]; draw(); preview();
    });
    cv.addEventListener('pointerup', () => { drag = -1; });
    cv.addEventListener('dblclick', (e) => { const i = hit(toPt(e)); if (i >= 0 && curves[ch].length > 2) { curves[ch].splice(i, 1); draw(); preview(); } });
    draw(); return body;
  }, (d) => {
    const M = curveLUT(curves.rgb), R = curveLUT(curves.r), G = curveLUT(curves.g), B = curveLUT(curves.b);
    for (let i = 0; i < d.length; i += 4) { d[i] = M[R[d[i]]]; d[i + 1] = M[G[d[i + 1]]]; d[i + 2] = M[B[d[i + 2]]]; }
  });
}

// ---- canvas (whole document) transforms
function transformAll(label, fn) {
  structOp(() => {
    for (const l of doc().layers) {
      delete l.vec; if (l.kind !== 'Image') l.kind = 'Layer';
      for (const t of l.mask ? [l.canvas, l.mask] : [l.canvas]) { const snap = mkCanvas(); snap.getContext('2d').drawImage(t, 0, 0); const c = t.getContext('2d'); c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H); fn(c, snap); c.restore(); }
      l._maDirty = true;
    }
  }, label);
}
const rotateCanvas = (dir) => transformAll(dir > 0 ? 'Rotate right' : 'Rotate left', (c, s) => { c.translate(W / 2, H / 2); c.rotate(dir * Math.PI / 2); c.drawImage(s, -W / 2, -H / 2); });
const flipCanvas = (h) => transformAll(h ? 'Flip horizontal' : 'Flip vertical', (c, s) => { if (h) { c.translate(W, 0); c.scale(-1, 1); } else { c.translate(0, H); c.scale(1, -1); } c.drawImage(s, 0, 0); });
function flipLayer(h) {
  const vl = activeLayer();
  if (vl.vec && vl.vec.type !== 'fill') { // editable layers flip as themselves (mirrored across the canvas, like pixels)
    arrApply(h ? 'Flip layer horizontal' : 'Flip layer vertical', s => { if (h) { s.flipX = !s.flipX; s.x = W - s.x - s.w; } else { s.flipY = !s.flipY; s.y = H - s.y - s.h; } s.angle = -s.angle; });
    return;
  }
  labelled(h ? 'Flip layer horizontal' : 'Flip layer vertical', () => {
    const o = beginOp(); if (!o) return; const s = snapCanvas(o.before), c = o.l.ctx;
    c.save(); c.clearRect(0, 0, W, H); if (h) { c.translate(W, 0); c.scale(-1, 1); } else { c.translate(0, H); c.scale(1, -1); } c.drawImage(s, 0, 0); c.restore(); commitOp(o);
  });
}
function anchorGrid(initial = 4) {
  const g = document.createElement('div'); g.className = 'anchor-grid'; g.value = initial;
  for (let i = 0; i < 9; i++) { const b = document.createElement('button'); b.type = 'button'; b.className = i === initial ? 'on' : ''; b.onclick = () => { g.value = i; g.querySelectorAll('button').forEach((x, j) => x.classList.toggle('on', j === i)); g.dispatchEvent(new Event('change', { bubbles: true })); }; g.append(b); }
  return g;
}
// ---- real resizing for normal canvases (templates must stay 585 x 559, so they use sizeDialog below)
// changes the size of the open project: its docs, the view and the scratch canvases
function setProjectSize(w, h) {
  const st = state.sets[state.setIdx]; st.w = w; st.h = h;
  for (const d of Object.values(st.docs)) d.comp = mkCanvas(w, h);
  applySize(w, h); if (hasSel) deselect(false); // resizing the selection canvas empties it
  requestAnimationFrame(zoomFit);
}
// kind 'image' scales everything to nw x nh; 'canvas' adds/trims space around it, keeping the anchor (0-8, like anchorGrid) in place
function resizeProject(kind, nw, nh, anchor) {
  if (penDraw) finishPath(); endTextEdit(); flushVecEdit(); cancelOp(); if (hasSel) deselect(); arr = null;
  const ow = W, oh = H, sx = nw / ow, sy = nh / oh;
  const dx = Math.round((nw - ow) * (anchor % 3) / 2), dy = Math.round((nh - oh) * Math.floor(anchor / 3) / 2);
  const before = { w: ow, h: oh, struct: snapStruct() };
  const redraw = (src) => { const c = mkCanvas(nw, nh), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; if (kind === 'image') x.drawImage(src, 0, 0, nw, nh); else x.drawImage(src, dx, dy); return c; };
  for (const l of doc().layers) {
    const v = l.vec;
    if (v?.type === 'fill') { // colour fills keep working: move their mask along with the pixels
      const m = redraw(maskCanvas(v.mask)), url = m.toDataURL(); maskCache.set(url, m); v.mask = url;
      if (v.bb) v.bb = kind === 'image' ? [v.bb[0] * sx, v.bb[1] * sy, v.bb[2] * sx, v.bb[3] * sy] : [v.bb[0] + dx, v.bb[1] + dy, v.bb[2], v.bb[3]];
    } else if (v && kind === 'image') { delete l.vec; if (l.kind !== 'Image') l.kind = 'Layer'; } // scaled text/shapes become pixels, like rotate/flip
    else if (v) shiftVec(v, dx, dy);
    l.canvas = redraw(l.canvas); l.ctx = ctxOf(l.canvas);
    if (l.mask) { l.mask = redraw(l.mask); l._maDirty = true; }
  }
  setProjectSize(nw, nh);
  pushHistory({ t: 'sz', label: kind === 'image' ? 'Image size' : 'Canvas size', before, after: { w: nw, h: nh, struct: snapStruct() } });
  rebuildLayers(); buildOptions(); requestRender();
  toast(`${kind === 'image' ? 'Image' : 'Canvas'} is now ${nw} × ${nh} (Ctrl+Z to undo)`);
}
function resizeDialog(kind) {
  const body = el('div', 'adj-body size-body'), note = el('p', 'adj-note');
  note.textContent = kind === 'image'
    ? `Scales the whole picture, every layer included. It's ${W} × ${H} now.`
    : `Adds or trims space around the picture without scaling it. The anchor is the part that stays put. It's ${W} × ${H} now.`;
  const wRow = slider('Width', 1, MAX_SIDE, W, 'px'), hRow = slider('Height', 1, MAX_SIDE, H, 'px');
  wRow.querySelector('input[type=range]').max = hRow.querySelector('input[type=range]').max = Math.min(MAX_SIDE, Math.max(4000, W * 2, H * 2));
  const lock = el('label', 'switch-row'); lock.innerHTML = '<span>Keep proportions</span><input type="checkbox" class="switch" checked>';
  const keep = () => lock.querySelector('input').checked;
  wRow.addEventListener('change', () => { if (keep()) hRow.set(Math.max(1, Math.round(wRow.value() * H / W))); });
  hRow.addEventListener('change', () => { if (keep()) wRow.set(Math.max(1, Math.round(hRow.value() * W / H))); });
  const pct = el('div', 'pct-row');
  for (const v of [50, 75, 100, 125, 150, 200]) { const b = el('button', 'mini'); b.textContent = v + '%'; b.onclick = () => { wRow.set(clampSide(W * v / 100, W)); hRow.set(clampSide(H * v / 100, H)); }; pct.append(b); }
  body.append(note, wRow, hRow, lock, pct);
  let anchor = null;
  if (kind === 'canvas') { anchor = anchorGrid(4); const a = el('div', 'anchor-row', '<span class="sl-label">Anchor</span>'); a.append(anchor); body.append(a); }
  dlg(kind === 'image' ? 'Image size' : 'Canvas size', body, { onOk: () => {
    const nw = clampSide(wRow.value(), W), nh = clampSide(hRow.value(), H);
    if (nw !== W || nh !== H) resizeProject(kind, nw, nh, anchor ? anchor.value : 0);
  } });
}
function sizeDialog(kind) {
  if (!isTemplate()) return resizeDialog(kind);
  const body = document.createElement('div'); body.className = 'adj-body size-body';
  const note = document.createElement('p'); note.className = 'adj-note';
  note.textContent = !isTemplate()
    ? (kind === 'image' ? 'Scales the artwork on every layer. The canvas itself keeps its size.' : 'Places the artwork as if the canvas were this size, at the chosen anchor. The canvas itself keeps its size.')
    : kind === 'image'
    ? 'Scales the artwork on every layer. Roblox needs templates at exactly 585 × 559, so the canvas itself stays that size.'
    : 'Places the artwork as if the canvas were this size, at the chosen anchor. The template stays 585 × 559 for Roblox.';
  const wRow = slider('Width', 1, 2340, W, 'px'), hRow = slider('Height', 1, 2236, H, 'px');
  wRow.querySelector('input[type=range]').max = hRow.querySelector('input[type=range]').max = 1200;
  const lock = document.createElement('label'); lock.className = 'switch-row'; lock.innerHTML = '<span>Keep proportions</span><input type="checkbox" class="switch" checked>';
  const pct = document.createElement('div'); pct.className = 'pct-row';
  for (const v of [50, 75, 100, 125, 150, 200]) { const b = document.createElement('button'); b.className = 'mini'; b.textContent = v + '%'; b.onclick = () => { set(wRow, Math.round(W * v / 100)); set(hRow, Math.round(H * v / 100)); body.dispatchEvent(new Event('change')); }; pct.append(b); }
  const set = (row, v) => row.querySelectorAll('input').forEach(i => { i.value = v; });
  let last = 'w';
  wRow.addEventListener('change', (e) => { last = 'w'; if (lock.querySelector('input').checked) set(hRow, Math.round(wRow.value() * H / W)); });
  hRow.addEventListener('change', (e) => { last = 'h'; if (lock.querySelector('input').checked) set(wRow, Math.round(hRow.value() * W / H)); });
  const anchor = anchorGrid(kind === 'image' ? 0 : 4);
  const aLabel = document.createElement('div'); aLabel.className = 'anchor-row'; aLabel.innerHTML = '<span class="sl-label">Anchor</span>'; aLabel.append(anchor);
  body.append(note, wRow, hRow, lock, pct, aLabel);
  // every layer, and every mask, scales or shifts the same way
  const targets = doc().layers.flatMap(l => (l.mask ? [l.canvas, l.mask] : [l.canvas]).map(t => ({ l, t, snap: (() => { const s = mkCanvas(); s.getContext('2d').drawImage(t, 0, 0); return s; })() })));
  const snaps = targets.map(x => x.snap);
  const before = snapStruct();
  const apply = () => {
    const nw = Math.max(1, wRow.value()), nh = Math.max(1, hRow.value()), ax = (anchor.value % 3) / 2, ay = Math.floor(anchor.value / 3) / 2;
    targets.forEach(({ l, t }, i) => {
      l._maDirty = true; const c = t.getContext('2d'); c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H); c.imageSmoothingQuality = 'high';
      if (kind === 'image') c.drawImage(snaps[i], Math.round((W - nw) * ax), Math.round((H - nh) * ay), nw, nh);
      else c.drawImage(snaps[i], Math.round((nw - W) * ax), Math.round((nh - H) * ay));
      c.restore();
    });
    requestRender();
  };
  body.addEventListener('change', () => requestAnimationFrame(apply));
  dlg(kind === 'image' ? 'Image size' : 'Canvas size', body, {
    onOk: () => { apply(); pushHistory({ t: 'st', label: kind === 'image' ? 'Image size' : 'Canvas size', before, after: snapStruct() }); rebuildLayers(); },
    onCancel: () => { restoreStruct(before); rebuildLayers(); requestRender(); },
  });
}

// ---- layer helpers for the Layer menu
function mergeVisible() {
  structOp(() => {
    const d = doc(), vis = d.layers.filter(l => layerVisible(l)); if (vis.length < 2) { toast('Need at least two visible layers'); return false; }
    const m = makeLayer('Merged'), c = m.ctx;
    compositeLayers(c, d.layers.filter(l => layerVisible(l)), d.groups);
    const at = d.layers.indexOf(vis[vis.length - 1]);
    d.layers.splice(at + 1, 0, m); d.layers = d.layers.filter(l => !vis.includes(l)); d.activeId = m.id;
  }, 'Merge visible');
}
function flatten() {
  structOp(() => {
    const d = doc(), m = makeLayer('Background'), c = m.ctx;
    compositeLayers(c, d.layers, d.groups);
    d.layers = [m]; d.groups = []; d.activeGroup = null; d.activeId = m.id;
  }, 'Flatten image');
}
function renameActive() {
  const row = [...document.querySelectorAll('#layerList .layer')].find(r => r.classList.contains('active'));
  row?.querySelector('.name')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

const MENUS = [
  { label: 'File', items: [
    { label: 'Home', run: () => showHome() },
    { label: 'New project…', key: 'Ctrl+N', run: () => openNewProjectDialog() },
    { label: 'Clear current template', run: () => $('#btnNew').click() },
    { label: 'Open (.stitch, Pixlr .pxz or image)…', key: 'Ctrl+O', run: () => $('#btnOpen').click() },
    { label: 'Save project (.stitch)…', key: 'Ctrl+S', run: () => $('#btnSave').click() },
    { label: 'Version history…', run: async () => { await saveDirty(); const st = state.sets[state.setIdx], m = (await lib.list()).find(x => x.id === st.id); if (m) openVersions(m); else toast('This project hasn’t been saved yet'); }, off: () => !lib.versions || !!state.sets[state.setIdx]?.temp },
    '-',
    { label: 'Import image as layer…', key: 'Ctrl+I', run: () => $('#btnImport').click() },
    '-',
    { label: 'Export', sub: [
      { label: 'Export PNG…', key: 'Ctrl+E', run: () => exportPng() },
      { label: 'Export set (shirt + pants)…', key: 'Ctrl+Shift+E', run: () => exportSet(), off: () => !isTemplate() },
      { label: 'Export as Pixlr file (.pxz)…', run: exportPxz },
      { label: 'Save preview image…', run: () => openRenderDialog(), off: () => !isTemplate() },
    ] },
    '-',
    { label: 'Check for updates…', run: () => checkUpdates(true) },
  ] },
  { label: 'Canvas', items: [
    { label: 'Image size…', run: () => sizeDialog('image') },
    { label: 'Canvas size…', run: () => sizeDialog('canvas') },
    { label: 'Smart resize (fit layer to selection)', run: () => $('#lyFit').click() },
    '-',
    { label: 'Rotate', sub: [
      { label: 'Rotate left', run: () => rotateCanvas(-1) },
      { label: 'Rotate right', run: () => rotateCanvas(1) },
    ] },
    { label: 'Flip', sub: [
      { label: 'Flip horizontal', run: () => flipCanvas(true) },
      { label: 'Flip vertical', run: () => flipCanvas(false) },
    ] },
  ] },
  { label: 'Layer', items: [
    { label: 'New layer', key: 'Ctrl+Shift+N', run: () => $('#lyAdd').click() },
    { label: 'Duplicate layer', key: 'Ctrl+D', run: () => $('#lyDup').click() },
    { label: 'Add image as layer…', run: () => $('#btnImport').click() },
    { label: 'Rename layer', key: 'F2', run: renameActive },
    { label: 'Delete layer', key: 'Del', run: () => $('#lyDel').click() },
    '-',
    { label: 'Colour fill', sub: [
      { label: 'New colour fill from selection', run: newFillFromSelection, off: () => !hasSel },
      { label: 'Convert to colour fill (keep shape)', run: () => convertToFill('alpha') },
      { label: 'Convert to colour fill (black & white mask)', run: () => convertToFill('luma') },
      { label: 'Change fill colour…', run: () => editFillLayerColour(activeLayer()), off: () => activeLayer().vec?.type !== 'fill' },
    ] },
    { label: 'Mask', sub: [
      { label: 'Add mask', run: () => addMask(false), off: () => !!activeLayer().mask || !!doc().activeGroup },
      { label: 'Add mask from selection', run: () => addMask(true), off: () => !hasSel || !!activeLayer().mask || !!doc().activeGroup },
      { label: 'Edit mask', run: () => editMask(activeLayer()), off: () => !activeLayer().mask || maskEditing(activeLayer()) },
      { label: 'Invert mask', run: invertMask, off: () => !activeLayer().mask },
      { label: 'Turn mask off / on', run: () => { const l = activeLayer(); propChange(l, 'maskOff', !l.maskOff, l.maskOff ? 'Enable mask' : 'Disable mask'); }, off: () => !activeLayer().mask },
      { label: 'Apply mask', run: applyMask, off: () => !activeLayer().mask },
      { label: 'Delete mask', run: deleteMask, off: () => !activeLayer().mask },
    ] },
    '-',
    { label: 'Group layers', key: 'Ctrl+G', run: groupLayers },
    { label: 'Ungroup', key: 'Ctrl+Shift+G', run: ungroupLayers, off: () => !doc().activeGroup && !activeLayer().group },
    { label: 'Lock / unlock layer', key: 'Ctrl+/', run: () => { const l = activeLayer(); propChange(l, 'locked', !l.locked, l.locked ? 'Unlock layer' : 'Lock layer'); } },
    { label: 'Mirror on / off', run: () => toggleMirror(), off: () => !!doc().activeGroup },
    { label: 'Rasterize layer', run: () => { const l = activeLayer(); endTextEdit(); flushVecEdit(); structOp(() => { delete l.vec; l.kind = 'Layer'; }, 'Rasterize layer'); buildOptions(); }, off: () => !activeLayer().vec },
    '-',
    { label: 'Merge', sub: [
      { label: 'Merge down', key: 'Ctrl+M', run: () => $('#lyMerge').click(), off: () => doc().layers.indexOf(activeLayer()) === 0 },
      { label: 'Merge visible', key: 'Ctrl+Shift+M', run: mergeVisible },
      { label: 'Flatten image', run: flatten, off: () => doc().layers.length < 2 },
    ] },
    { label: 'Arrange', sub: [
      { label: 'Bring forward / up', key: 'Ctrl+]', run: () => $('#lyUp').click(), off: () => doc().layers.indexOf(activeLayer()) === doc().layers.length - 1 },
      { label: 'Send backward / down', key: 'Ctrl+[', run: () => $('#lyDown').click(), off: () => doc().layers.indexOf(activeLayer()) === 0 },
    ] },
    '-',
    { label: 'Flip', sub: [
      { label: 'Flip horizontal', run: () => flipLayer(true) },
      { label: 'Flip vertical', run: () => flipLayer(false) },
    ] },
    { label: 'Symmetrize', sub: [
      { label: 'Right side → left', cmd: 'symRL', run: () => $('#lySymRL').click(), raster: true },
      { label: 'Left side → right', cmd: 'symLR', run: () => $('#lySymLR').click(), raster: true },
    ] },
    { label: 'Mirror limb', off: () => !isTemplate(), sub: [
      { label: 'Right → left', run: () => $('#lyMirrorRL').click(), off: () => !isTemplate(), raster: true },
      { label: 'Left → right', run: () => $('#lyMirrorLR').click(), off: () => !isTemplate(), raster: true },
    ] },
    { label: 'Clear layer (region)', run: () => $('#lyClear').click(), raster: true },
  ] },
  { label: 'Select', items: [
    { label: 'Select all', key: 'Ctrl+A', run: selectAll },
    { label: 'Deselect', key: 'Ctrl+Shift+A', run: deselect, off: () => !hasSel },
    { label: 'Invert selection', key: 'Ctrl+Shift+I', run: invertSelection },
    '-',
    { label: 'Copy', key: 'Ctrl+C', run: () => copySel(false) },
    { label: 'Cut', key: 'Ctrl+X', run: () => copySel(true) },
    { label: 'Paste', key: 'Ctrl+V', run: () => clip ? pasteClip(clip) : toast('Nothing copied yet'), off: () => !clip },
    { label: 'Delete selected pixels', key: 'Del', run: clearSelectedPixels, off: () => !hasSel },
  ] },
  { label: 'Adjustment', items: [
    { label: 'Brightness & contrast…', run: () => openAdjust('bc') },
    { label: 'Hue & saturation…', run: openHueSat },
    { label: 'Vibrance…', run: () => openAdjust('vib') },
    { label: 'Curves…', run: openCurves },
    { label: 'Temperature & tint…', run: () => openAdjust('temp') },
  ] },
  { label: 'Filter', items: [{ label: 'No filters yet', off: () => true }] },
  { label: 'Help', items: [
    { label: 'Keyboard shortcuts…', cmd: 'shortcuts', run: () => openShortcuts() },
    { label: 'What’s new', run: async () => { const v = (native?.version ? await native.version().catch(() => null) : null) || CHANGELOG[0]?.version; showWhatsNew(v, CHANGELOG.filter(c => c.version === v).concat(CHANGELOG.some(c => c.version === v) ? [] : CHANGELOG.slice(0, 1))); } },
    { label: 'Check for updates…', run: () => checkUpdates(true) },
  ] },
];
// which command each menu entry runs, so the menus show the keys the user picked
const MENU_CMDS = { 'New project…': 'newProject', 'Open (.stitch, Pixlr .pxz or image)…': 'open', 'Save project (.stitch)…': 'save', 'Import image as layer…': 'import', 'Export PNG…': 'exportPng', 'Export set (shirt + pants)…': 'exportSet',
  'New layer': 'newLayer', 'Duplicate layer': 'dup', 'Rename layer': 'rename', 'Delete layer': 'delete', 'Group layers': 'group', 'Ungroup': 'ungroup', 'Lock / unlock layer': 'lock', 'Mirror on / off': 'mirror', 'Merge down': 'merge', 'Merge visible': 'mergeVisible',
  'Bring forward / up': 'layerUp', 'Send backward / down': 'layerDown', 'Select all': 'selectAll', 'Deselect': 'deselect', 'Invert selection': 'invert', 'Copy': 'copy', 'Cut': 'cut', 'Delete selected pixels': 'delete' };
// every entry, including those in submenus
const menuEntries = (items) => items.flatMap(it => it === '-' ? [] : [it, ...(it.sub ? menuEntries(it.sub) : [])]);
for (const m of MENUS) for (const it of menuEntries(m.items)) if (MENU_CMDS[it.label]) it.cmd = MENU_CMDS[it.label];

// menu actions that only work on pixels are greyed out while text, a shape or a colour fill is selected
const pixelsOnly = () => !doc().noSel && !!activeLayer()?.vec;
const RASTER_ONLY = ['Cut', 'Delete selected pixels'];
for (const m of MENUS) for (const it of menuEntries(m.items)) if (it.run && (m.label === 'Adjustment' || it.raster || RASTER_ONLY.includes(it.label))) { const prev = it.off; it.rasterOnly = true; it.off = () => pixelsOnly() || !!prev?.(); }
const menubar = $('#menubar');
let openMenu = null;
function closeMenus() { menubar.querySelectorAll('.mb-item').forEach(m => m.classList.remove('open')); closeSubs(0); openMenu = null; }
// submenus open beside their entry; closeSubs(n) closes the ones deeper than level n
const subs = [];
function closeSubs(level) { while (subs.length > level) { const f = subs.pop(); f.entry.classList.remove('sub-open'); f.el.remove(); } }
function fillMenu(box, items, level) {
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'mb-sep'; box.append(s); continue; }
    const b = document.createElement('button'); b.className = 'mb-entry';
    b.innerHTML = `<span></span><kbd></kbd>`; b.firstChild.textContent = it.label;
    if (it.sub) {
      b.lastChild.textContent = '›'; b.classList.add('has-sub');
      b.disabled = !!it.off?.() || menuEntries(it.sub).every(x => x.sub || !x.run || x.off?.());
      const open = () => {
        if (b.disabled || b.classList.contains('sub-open')) return;
        closeSubs(level); const f = document.createElement('div'); f.className = 'mb-drop mb-sub'; fillMenu(f, it.sub, level + 1); menubar.append(f);
        // right of the entry, or left of it if that would run off the window; kept inside the window top to bottom
        const r = b.getBoundingClientRect(), w = f.offsetWidth, h = f.offsetHeight;
        f.style.left = (r.right + w + 4 > innerWidth ? r.left - w + 2 : r.right - 2) + 'px'; f.style.top = Math.max(4, Math.min(innerHeight - h - 4, r.top - 5)) + 'px';
        b.classList.add('sub-open'); subs.push({ el: f, entry: b });
      };
      b.onmouseenter = open; b.onclick = (e) => { e.stopPropagation(); open(); };
    } else {
      b.lastChild.textContent = it.cmd ? keyOf(it.cmd) : it.key || '';
      b.disabled = !!it.off?.() || !it.run;
      if (b.disabled && it.rasterOnly && pixelsOnly()) b.title = 'Needs a plain image layer - use Layer → Rasterize layer first';
      b.onmouseenter = () => closeSubs(level);
      b.onclick = () => { closeMenus(); it.run?.(); };
    }
    box.append(b);
  }
}
for (const m of MENUS) {
  const item = document.createElement('div'); item.className = 'mb-item';
  const btn = document.createElement('button'); btn.className = 'mb-btn'; btn.textContent = m.label;
  const dd = document.createElement('div'); dd.className = 'mb-drop';
  item.append(btn, dd); menubar.append(item);
  const build = () => { dd.innerHTML = ''; fillMenu(dd, m.items, 0); };
  dd.addEventListener('scroll', () => closeSubs(0)); // an open submenu would be left behind by the scroll
  btn.onclick = (e) => { e.stopPropagation(); const was = item.classList.contains('open'); closeMenus(); if (!was) { build(); item.classList.add('open'); openMenu = item; } };
  btn.onmouseenter = () => { if (openMenu && openMenu !== item) { closeMenus(); build(); item.classList.add('open'); openMenu = item; } };
}
document.addEventListener('click', (e) => { if (!e.target.closest('#menubar')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) closeMenus(); });
$('#lyAdjust').onclick = () => openHueSat();


// ------------------------------------------------------------------ rich tooltips for the tool column
const TIPS = {
  move: ['Arrange', 'Move, scale and rotate the active layer. Drag the corner handles to resize, the top dot to rotate.', 'V'],
  select: ['Select', 'Drag a rectangle or ellipse selection. Shift adds, Alt subtracts. Painting stays inside it.', 'M'],
  lasso: ['Lasso select', 'Draw a freehand, polygon or magnetic selection around anything.', 'L'],
  wand: ['Magic select', 'Click to select an area of similar colour. Adjust Tolerance to grow or shrink it.', 'W'],
  hand: ['Hand', 'Drag to pan around the canvas. You can also hold Space with any tool.', 'H'],
  brush: ['Draw', 'Paint with a brush. Click the Brush picker for size, softness, step and presets. Shift+click draws a straight line.', 'B'],
  pencil: ['Pencil', 'Paint hard, pixel-perfect strokes with no anti-aliasing. Great for clean template edges.', 'P'],
  eraser: ['Eraser', 'Erase pixels on the active layer. Tick “Hard edge” for pixel-perfect erasing.', 'E'],
  fill: ['Fill', 'Flood-fill an area with the primary colour. Shift+click fills the whole selection.', 'G'],
  gradient: ['Gradient', 'Drag to fill with a gradient from the primary to the secondary colour (or to transparent).', 'D'],
  eyedropper: ['Eyedropper', 'Click to pick a colour from the canvas. Alt+click does this with most tools.', 'I'],
  pen: ['Pen', 'Draw editable bezier lines and shapes. Click to place points, drag to make curves; edit points and handles afterwards.', 'K'],
  shape: ['Shape', 'Draw editable rectangles, rounded rectangles, ellipses, lines and stars. Design mode keeps them editable; Draw mode paints them straight onto the layer.', 'U'],
  rect: ['Rectangle', 'Drag to draw a rectangle. Hold Shift for a square. Tick “Filled” for a solid shape.', 'U'],
  ellipse: ['Ellipse', 'Drag to draw an ellipse. Hold Shift for a perfect circle.', 'O'],
  line: ['Line', 'Drag to draw a straight line. Hold Shift to snap to 45° angles.', 'N'],
  text: ['Text', 'Click to add an editable text layer, or click existing text to edit it. Font, fill, format and styles are in the options bar.', 'T'],
  zoom: ['Zoom', 'Click to zoom in, Alt+click to zoom out. Scrolling zooms anywhere.', 'Z'],
};
const tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl);
let tipTimer = 0;
function showTip(el, [name, desc, key]) {
  tipEl.innerHTML = '<b></b><p></p>' + (key ? '<small></small>' : '');
  tipEl.querySelector('b').textContent = name; tipEl.querySelector('p').textContent = desc;
  if (key) tipEl.querySelector('small').textContent = `Keyboard shortcut (${key})`;
  const r = el.getBoundingClientRect();
  tipEl.style.left = (r.right + 10) + 'px';
  tipEl.style.top = Math.min(window.innerHeight - tipEl.offsetHeight - 8, Math.max(8, r.top - 4)) + 'px';
  tipEl.classList.add('show');
}
function hideTip() { clearTimeout(tipTimer); tipEl.classList.remove('show'); }
function addTip(el, tip) {
  el.removeAttribute('title');
  el.addEventListener('mouseenter', () => { clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(el, tip), tipEl.classList.contains('show') ? 0 : 350); });
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('pointerdown', hideTip);
}
$$('#toolbar [data-tool]').forEach(b => TIPS[b.dataset.tool] && addTip(b, TIPS[b.dataset.tool]));
addTip($('#colFg'), ['Primary colour', 'Used by the brush, pencil, fill, shapes and text. Click to choose a colour.', '']);
addTip($('#colBg'), ['Secondary colour', 'Used as the end colour of gradients.', '']);
addTip($('#btnSwap'), ['Swap colours', 'Switch the primary and secondary colours.', 'X']);

// ------------------------------------------------------------------ motion helpers (styles.css "motion" has the CSS side)
const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
// a quick fade before a popup is removed (instant when animations are off)
function fadeOut(node, done) {
  if (!motionOK() || !node.isConnected) { done(); return; }
  node.style.pointerEvents = 'none';
  node.animate([{ opacity: 1 }, { opacity: 0, scale: .97 }], { duration: 110, easing: 'ease-in' }).finished.then(done, done);
}
// minimising/restoring a panel slides it like a drawer, and the panels around it glide to their new heights.
// fn makes the change; heights are measured before and after and animated between (only ~220ms of layout work).
function animatePanels(target, fn) {
  if (!motionOK()) { fn(); return; }
  const ps = panels().filter(x => !x.hidden && !x.classList.contains('floating')), h0 = new Map(ps.map(x => [x, x.getBoundingClientRect().height]));
  fn();
  const ease = 'cubic-bezier(.2,.8,.2,1)';
  for (const x of ps) {
    const a = h0.get(x), b = x.getBoundingClientRect().height;
    if (Math.abs(a - b) < 1) continue;
    x._drawer?.cancel(); x.classList.add('drawer-anim');
    const an = x._drawer = x.animate([{ height: a + 'px', flex: 'none', minHeight: '0px' }, { height: b + 'px', flex: 'none', minHeight: '0px' }], { duration: 220, easing: ease });
    const end = () => { if (x._drawer === an) { x._drawer = null; x.classList.remove('drawer-anim'); } };
    an.finished.then(end, end);
  }
  const body = target.querySelector('.panel-body');
  if (target.classList.contains('collapsed')) body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' });
  else body.animate([{ opacity: 0, translate: '0 -6px' }, { opacity: 1, translate: '0 0' }], { duration: 220, easing: ease });
}

// ------------------------------------------------------------------ panels & layout (dockable / floating)
const side = $('#side'), mainEl = $('.main');
const panels = () => $$('.panel[id$="Panel"]');
const docked = () => [...side.querySelectorAll(':scope > .panel')];
const zoomDock = $('#zoomDock');
const FACTORY = { sideW: 390, panels: [
  { id: 'previewPanel', dock: true, hidden: false, collapsed: false, h: null },
  { id: 'layersPanel', dock: true, hidden: false, collapsed: false, h: null },
  { id: 'historyPanel', dock: true, hidden: false, collapsed: false, h: null },
  { id: 'coloursPanel', dock: 'zoom', hidden: false, collapsed: true },
] };
function getLayout() {
  const order = docked().map(p => p.id);
  return { sideW: side.getBoundingClientRect().width | 0, panels: panels().map(p => {
    const fl = p.classList.contains('floating'), r = p.getBoundingClientRect();
    const zd = p.parentNode === zoomDock;
    return { id: p.id, dock: fl ? false : zd ? 'zoom' : true, order: zd ? [...zoomDock.children].indexOf(p) : order.indexOf(p.id), hidden: p.hidden, collapsed: p.classList.contains('collapsed'), h: fl ? Math.round(r.height) || +p.dataset.fh || null : (p.dataset.h ? +p.dataset.h : null), x: fl ? Math.round(r.left) : null, y: fl ? Math.round(r.top) : null, w: fl ? Math.round(r.width) : null };
  }) };
}
function floatPanel(p, x, y, w, h) {
  p.classList.add('floating'); document.body.append(p);
  p.style.flex = ''; delete p.dataset.h;
  const W_ = w || 280, H_ = h || 260;
  p.style.width = W_ + 'px'; if (!p.classList.contains('collapsed')) p.style.height = H_ + 'px'; p.dataset.fh = H_;
  if (x == null || y == null) { // default spot: bottom-right of the canvas, just above the zoom bar
    const ca = $('.canvas-area').getBoundingClientRect(), zb = $('.zoombar').getBoundingClientRect();
    const hh = p.classList.contains('collapsed') ? p.getBoundingClientRect().height || 38 : H_;
    x = ca.right - W_ - 12; y = zb.top - hh - 8;
  }
  placeFloat(p, x, y);
}
function placeFloat(p, x, y) { const r = p.getBoundingClientRect(); x = Math.max(0, Math.min(window.innerWidth - Math.max(60, r.width || 200), x)); y = Math.max(40, Math.min(window.innerHeight - 40, y)); p.style.left = x + 'px'; p.style.top = y + 'px'; }
function dockZoom(p, beforeEl) {
  p.classList.remove('floating'); p.style.left = p.style.top = p.style.width = p.style.height = ''; p.style.flex = ''; delete p.dataset.h;
  if (beforeEl && beforeEl.parentNode === zoomDock) zoomDock.insertBefore(p, beforeEl); else zoomDock.append(p);
}
function dockPanel(p, beforeEl) {
  p.classList.remove('floating'); p.style.left = p.style.top = p.style.width = p.style.height = '';
  if (beforeEl && beforeEl.parentNode === side) side.insertBefore(p, beforeEl); else side.insertBefore(p, side.querySelector('.vsplit'));
}
function applyLayout(L) {
  if (!L) return;
  setSideWidth(L.sideW || FACTORY.sideW);
  const list = [...(L.panels || [])];
  for (const id of ['previewPanel', 'layersPanel', 'historyPanel', 'coloursPanel']) if (!list.find(o => o.id === id)) list.push(FACTORY.panels.find(o => o.id === id));
  const dockList = list.filter(o => o.dock === true).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const o of dockList) { const p = document.getElementById(o.id); if (p) dockPanel(p); }
  for (const o of list.filter(o => o.dock === 'zoom').sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) { const p = document.getElementById(o.id); if (p) dockZoom(p); }
  for (const o of list) {
    const p = document.getElementById(o.id); if (!p) continue;
    p.hidden = !!o.hidden; p.classList.toggle('collapsed', !!o.collapsed);
    if (o.dock === false) floatPanel(p, o.x, o.y, o.w, o.h);
    else if (o.dock === 'zoom') { /* sized by the zoom dock */ }
    else if (o.h) { p.dataset.h = o.h; p.style.flex = `1 1 ${o.h}px`; } else { delete p.dataset.h; p.style.flex = ''; }
  }
  syncPanelMenu();
}
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } } };
const saveLayout = () => store.set('stitch-layout', getLayout());
function setSideWidth(w) { w = Math.max(280, Math.min(Math.round(window.innerWidth * 0.6), w)); mainEl.style.gridTemplateColumns = `78px 1fr ${w}px`; }
function syncPanelMenu() { $$('#panelsMenu [data-panel]').forEach(cb => { cb.checked = !$('#' + cb.dataset.panel).hidden; }); }

const vsplit = document.createElement('div'); vsplit.className = 'vsplit'; vsplit.title = 'Drag to resize'; side.appendChild(vsplit);
vsplit.addEventListener('pointerdown', e => {
  e.preventDefault(); vsplit.setPointerCapture(e.pointerId); vsplit.classList.add('drag');
  const startX = e.clientX, startW = side.getBoundingClientRect().width;
  const mv = ev => setSideWidth(startW + (startX - ev.clientX));
  const up = () => { vsplit.removeEventListener('pointermove', mv); vsplit.classList.remove('drag'); saveLayout(); };
  vsplit.addEventListener('pointermove', mv); vsplit.addEventListener('pointerup', up, { once: true });
});
panels().forEach(p => {
  const h = document.createElement('div'); h.className = 'hsplit'; h.title = 'Drag to resize'; p.appendChild(h);
  h.addEventListener('pointerdown', e => {
    if (p.classList.contains('floating')) return;
    const vis = docked().filter(x => !x.hidden && !x.classList.contains('collapsed'));
    const i = vis.indexOf(p), next = vis[i + 1]; if (i < 0 || !next) return;
    e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag');
    for (const x of vis) { const hh = x.getBoundingClientRect().height; x.dataset.h = hh; x.style.flex = `1 1 ${hh}px`; }
    const startY = e.clientY, a0 = +p.dataset.h, b0 = +next.dataset.h, min = 90;
    const mv = ev => { const d = Math.max(min - a0, Math.min(b0 - min, ev.clientY - startY)); p.dataset.h = a0 + d; next.dataset.h = b0 - d; p.style.flex = `1 1 ${a0 + d}px`; next.style.flex = `1 1 ${b0 - d}px`; };
    const up = () => { h.removeEventListener('pointermove', mv); h.classList.remove('drag'); saveLayout(); };
    h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up, { once: true });
  });
  // drag a panel by its header to undock it, or back onto the right-hand dock to dock it
  const head = p.querySelector('.panel-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return;
    const r0 = p.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, ox = sx - r0.left, oy = sy - r0.top;
    let dragging = false, marker = null, dropBefore = null, overDock = false, overZoom = false;
    head.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      if (!dragging) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return; dragging = true; if (!p.classList.contains('floating')) floatPanel(p, r0.left, r0.top, Math.min(320, r0.width), Math.max(160, r0.height)); p.classList.add('moving'); }
      placeFloat(p, ev.clientX - ox, ev.clientY - oy);
      const sr = side.getBoundingClientRect(); overDock = ev.clientX >= sr.left - 10 && ev.clientX <= sr.right && ev.clientY >= sr.top && ev.clientY <= sr.bottom;
      const zr = zoomDock.getBoundingClientRect(), zb = $('.zoombar').getBoundingClientRect();
      overZoom = !overDock && ev.clientX >= zr.right - 320 && ev.clientX <= zr.right + 10 && ev.clientY >= Math.min(zr.top, zb.top - 140) - 90 && ev.clientY <= zb.bottom + 10;
      marker?.remove(); marker = null; dropBefore = null;
      if (overZoom) { const others = [...zoomDock.children].filter(x => x !== p && !x.hidden); dropBefore = others.find(x => { const rr = x.getBoundingClientRect(); return ev.clientY < rr.top + rr.height / 2; }) || null; marker = el('div', 'dock-marker'); if (dropBefore) zoomDock.insertBefore(marker, dropBefore); else zoomDock.append(marker); }
      if (overDock) {
        const others = docked().filter(x => !x.hidden); dropBefore = others.find(x => { const rr = x.getBoundingClientRect(); return ev.clientY < rr.top + rr.height / 2; }) || null;
        marker = el('div', 'dock-marker'); if (dropBefore) side.insertBefore(marker, dropBefore); else side.insertBefore(marker, vsplit);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      marker?.remove(); p.classList.remove('moving');
      if (dragging && overDock) dockPanel(p, dropBefore);
      else if (dragging && overZoom) dockZoom(p, dropBefore);
      if (dragging) saveLayout();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  new ResizeObserver(() => { if (p.classList.contains('floating') && !p.classList.contains('collapsed')) p.dataset.fh = p.getBoundingClientRect().height; }).observe(p);
  p.addEventListener('pointerup', () => { if (p.classList.contains('floating')) saveLayout(); });
  p.querySelector('[data-collapse]').onclick = () => animatePanels(p, () => {
    const fl = p.classList.contains('floating'), r0 = p.getBoundingClientRect();
    p.classList.toggle('collapsed');
    if (fl) { p.style.height = p.classList.contains('collapsed') ? '' : (p.dataset.fh || 260) + 'px'; const r1 = p.getBoundingClientRect(); placeFloat(p, r0.left, r0.bottom - r1.height); } // keep the bottom edge where it was
    saveLayout();
  });
  p.querySelector('[data-close]').onclick = () => { p.hidden = true; syncPanelMenu(); saveLayout(); };
  head.ondblclick = (e) => { if (!e.target.closest('button')) p.querySelector('[data-collapse]').click(); };
});
$$('#panelsMenu [data-panel]').forEach(cb => cb.onchange = () => { const p = $('#' + cb.dataset.panel); p.hidden = !cb.checked; if (cb.checked) p.classList.remove('collapsed'); saveLayout(); });
$('#btnPanels').onclick = (e) => { e.stopPropagation(); syncPanelMenu(); $('#panelsMenu').hidden = !$('#panelsMenu').hidden; };
$('#layoutDock').onclick = () => { applyLayout(FACTORY); saveLayout(); $('#panelsMenu').hidden = true; toast('Panels reset to the dock'); };
$('#layoutSave').onclick = () => { store.set('stitch-layout-default', getLayout()); $('#panelsMenu').hidden = true; toast('Saved this layout as your default'); };
$('#layoutReset').onclick = () => { applyLayout(store.get('stitch-layout-default') || FACTORY); saveLayout(); $('#panelsMenu').hidden = true; toast(store.get('stitch-layout-default') ? 'Reset to your default layout' : 'Reset to the original layout'); };
$('#lyMenuBtn').onclick = (e) => {
  e.stopPropagation(); const m = $('#lyMenu'); m.hidden = !m.hidden;
  const px = pixelsOnly(); // these change pixels, so they're greyed out on text/shape/fill layers
  for (const id of ['lyAdjust', 'lyClear']) { $('#' + id).disabled = px; $('#' + id).title = px ? 'Needs a plain image layer - use Layer → Rasterize layer first' : ''; }
  for (const id of ['lyMirrorRL', 'lyMirrorLR']) $('#' + id).disabled = px || !isTemplate();
  for (const id of ['lySymRL', 'lySymLR']) $('#' + id).disabled = px;
};
$('#lyMenu').addEventListener('click', () => { $('#lyMenu').hidden = true; });
document.addEventListener('click', (e) => {
  if (!e.target.closest('#panelsMenu')) $('#panelsMenu').hidden = true;
  if (!e.target.closest('#lyMenu, #lyMenuBtn')) $('#lyMenu').hidden = true;
});
window.addEventListener('resize', () => panels().forEach(p => { if (p.classList.contains('floating')) placeFloat(p, parseFloat(p.style.left), parseFloat(p.style.top)); }));
{ // Colours sits in the dock just above the zoom bar, collapsed until you open it
  let L = store.get('stitch-layout') || store.get('stitch-layout-default');
  if (L && !store.get('stitch-layout-v3')) { L = { ...L, panels: [...(L.panels || []).filter(o => o.id !== 'coloursPanel'), FACTORY.panels[3]] }; store.set('stitch-layout-v3', true); }
  applyLayout(L || FACTORY);
}

// ------------------------------------------------------------------ right-click layer properties
let ctxPop = null;
function closeLayerPop() { if (ctxPop) { const p = ctxPop; fadeOut(p, () => p.remove()); } ctxPop = null; }
function openLayerPop(item, x, y) {
  closeLayerPop();
  const isG = !!item.group, obj = isG ? item.group : item.layer, d = doc();
  const box = el('div', 'layer-pop');
  const x_ = el('button', 'dlg-x', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'); x_.onclick = closeLayerPop;
  const lab = (t) => { const s = el('div', 'lp-label'); s.textContent = t; return s; };
  const name = el('input', 'lp-input'); name.value = obj.name;
  name.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); };
  name.onchange = () => { const v = name.value.trim(); if (!v) return; if (isG) structOp(() => { obj.name = v; }, 'Rename group'); else propChange(obj, 'name', v, 'Rename layer'); };
  box.append(x_, lab('Name'), name);
  if (!isG) {
    const bl = el('select', 'lp-input'); bl.innerHTML = $('#lyBlend').innerHTML; bl.value = obj.blend; bl.options[0].textContent = 'None';
    bl.onchange = () => propChange(obj, 'blend', bl.value, 'Blend mode');
    box.append(lab('Blend Mode'), bl);
  }
  const opac = slider('Opacity', 0, 100, Math.round((obj.opacity ?? 1) * 100)); opac.classList.add('lp-sl');
  let opStart = null;
  opac.querySelector('.sl-range').onpointerdown = () => { opStart = obj.opacity ?? 1; };
  opac.addEventListener('change', () => { obj.opacity = opac.value() / 100; requestRender(); });
  const commitOp_ = () => { const v = obj.opacity, s0 = opStart ?? v; opStart = null; if (s0 === v) return; obj.opacity = s0; if (isG) structOp(() => { obj.opacity = v; }, 'Group opacity'); else propChange(obj, 'opacity', v, 'Layer opacity'); };
  opac.querySelector('.sl-range').onchange = commitOp_; opac.querySelector('input[type=number]').onchange = () => { opStart = opStart ?? obj.opacity; commitOp_(); };
  box.append(opac);
  const seg2 = (a, b, get, set) => { const g = el('div', 'lp-seg'); for (const [v, t] of [[false, a], [true, b]]) { const btn = el('button', get() === v ? 'on' : ''); btn.textContent = t; btn.onclick = () => { set(v); g.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', (i === 1) === get())); }; g.append(btn); } return g; };
  if (!isG) box.append(seg2('Unlocked', 'Locked', () => !!obj.locked, (v) => propChange(obj, 'locked', v, v ? 'Lock layer' : 'Unlock layer')));
  if (!isG) { const ms = seg2('Mirror off', 'Mirror on', () => !!obj.mirror, (v) => { if (!!obj.mirror !== v) toggleMirror(obj); }); ms.title = MIRROR_TIP().replace('Mirror is on: ', 'While on, ') + '. Turning it off keeps what was mirrored.'; box.append(ms); }
  box.append(seg2('Visible', 'Hidden', () => isG ? obj.visible === false : !obj.visible, (v) => { if (isG) structOp(() => { obj.visible = !v; }, 'Group visibility'); else propChange(obj, 'visible', !v, 'Visibility'); }));
  const foot = el('div', 'lp-foot');
  const fb = (svg, title, fn, off) => { const b = el('button', 'lp-btn', svg); b.title = title; b.disabled = !!off; b.onclick = () => { closeLayerPop(); fn(); }; return b; };
  const ic = (d_) => `<svg viewBox="0 0 24 24"><path d="${d_}"/></svg>`;
  foot.append(
    fb(ic('M12 4v9M8 9l4 4 4-4M5 18h14'), isG ? 'Merge group' : 'Merge down', () => { if (isG) selectGroup(obj); else selectLayer(obj); $('#lyMerge').click(); }, !isG && d.layers.indexOf(obj) === 0),
    fb(ic('M8 4v8M5 9l3 3 3-3M16 4v8M13 9l3 3 3-3M5 18h14'), 'Merge visible', mergeVisible),
    fb(ic('M12 3v7M8 7l4 3 4-3M5 14h14M5 18h14'), 'Flatten image', flatten, d.layers.length < 2),
  );
  box.append(foot); document.body.append(box); ctxPop = box;
  const r = box.getBoundingClientRect(); box.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width - 10)) + 'px'; box.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y - 20)) + 'px';
  makeDraggable(box, (dx, dy) => { box.style.left = (parseFloat(box.style.left) + dx) + 'px'; box.style.top = (parseFloat(box.style.top) + dy) + 'px'; });
}
document.addEventListener('pointerdown', (e) => { if (ctxPop && !ctxPop.contains(e.target)) closeLayerPop(); }, true);
$('#layerList').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.layer'); if (!row) return; e.preventDefault();
  const rows = [...$('#layerList').children], d = doc();
  // map the row back to its item by rebuilding the same order the list uses
  const items = []; let lastG = null;
  for (const l of [...d.layers].reverse()) { const g = groupOf(l); if (g && l.group !== lastG) items.push({ group: g }); lastG = l.group || null; if (g && g.collapsed) continue; items.push({ layer: l }); }
  const it = items[rows.indexOf(row)]; if (!it) return;
  if (it.group) selectGroup(it.group); else if (!d.sel?.has(it.layer.id) || d.sel.size < 2) selectLayer(it.layer);
  openLayerPop(it, e.clientX, e.clientY);
});

// ------------------------------------------------------------------ live updates (app reloads itself when new files arrive)
async function flushAutosave() {
  clearTimeout(autosaveTimer);
  try { await saveDirty(); } catch { /* ignore */ }
}
if (native && native.onUpdated) native.onUpdated(async (info) => {
  cancelOp(); await flushAutosave(); saveLayout();
  if (info && info.relaunch) native.relaunch(); else location.reload();
});


// ------------------------------------------------------------------ updates (GitHub releases)
function mdLite(t) { const d = el('div', 'upd-notes'); for (const line of String(t || '').split(/\r?\n/).slice(0, 40)) { const tx = line.replace(/^#+\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1').trim(); if (!tx) continue; const p = el(line.trim().startsWith('-') || line.trim().startsWith('*') ? 'li' : 'p'); p.textContent = tx.replace(/^[-*]\s*/, ''); d.append(p); } return d; }
function showUpdate(info) {
  const b = el('div', 'upd-body');
  const head = el('p', 'upd-head'); head.textContent = `Stitch Editor ${info.version} is available - you have ${info.current}.`;
  b.append(head); if (info.notes) b.append(mdLite(info.notes));
  dlg('Update available', b, {
    okLabel: 'Install now', cancelLabel: 'Remind me later',
    extra: [{ label: 'Skip this version', run: () => { native.updateSkip(info.version); toast(`Skipped version ${info.version}`); } }],
    onOk: () => { toast('Downloading update…'); native.updateInstall().then(r => { if (r.ok) { toast(`Installing ${r.version} - Stitch Editor will restart`); flushAutosave(); } else toast('Update failed: ' + r.message); }); },
    onCancel: () => toast('We’ll remind you next time you open Stitch Editor'),
    onClose: () => {},
  });
}
async function checkUpdates(manual) {
  if (!native?.updateCheck) { if (manual) toast('Updates are only available in the desktop app'); return; }
  const r = await native.updateCheck(manual);
  if (r.status === 'available') showUpdate(r);
  else if (manual) toast(r.status === 'latest' ? `You’re on the latest version (${r.current})` : r.status === 'none' ? 'No releases found on GitHub - ' + (r.message || 'check the release is published') : 'Couldn’t check for updates: ' + (r.message || r.status));
}
setTimeout(() => checkUpdates(false), 2500);


// ------------------------------------------------------------------ tabs (each tab = a set: shirt + pants)
function renderTabs() {
  const bar = $('#tabbar'); if (!bar) return; bar.innerHTML = '';
  state.sets.forEach((st, i) => {
    const t = el('div', 'stab' + (i === state.setIdx ? ' on' : '')); const nm = el('span', 'stab-name'); nm.textContent = st.name; t.title = 'Double-click to rename';
    const x = el('button', 'stab-x', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'); x.title = 'Close';
    x.onclick = (e) => { e.stopPropagation(); closeSet(i); };
    t.onclick = () => { if (i !== state.setIdx) switchSet(i); };
    t.onauxclick = (e) => { if (e.button === 1) closeSet(i); };
    nm.ondblclick = (e) => { e.stopPropagation(); const inp = el('input', 'stab-rename'); inp.value = st.name; nm.replaceWith(inp); inp.focus(); inp.select(); const done = () => { st.name = inp.value.trim() || st.name; renderTabs(); scheduleAutosave(st); }; inp.onblur = done; inp.onkeydown = (k) => { k.stopPropagation(); if (k.key === 'Enter') inp.blur(); if (k.key === 'Escape') { inp.value = st.name; inp.blur(); } }; };
    t.append(nm, x); bar.append(t);
  });
  const add = el('button', 'stab-add', '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'); add.title = 'New project (Ctrl+N)'; add.onclick = () => openNewProjectDialog();
  bar.append(add);
}
function leaveCurrent() { if (penDraw) finishPath(); endTextEdit(); flushVecEdit(); cancelOp(); if (hasSel) deselect(false); lasso = null; selPreview = null; arr = null; closePop(); stashSet(); }
function switchSet(i) {
  leaveCurrent(); state.setIdx = i; const st = state.sets[i];
  state.docs = st.docs; state.swatches = st.swatches; arr = null;
  const resized = applySize(st.w || TW, st.h || TH);
  const wasDirty = st.dirty;
  setMode(st.mode || 'shirt'); rerenderFills(); renderTabs(); buildOptions(); saveSessionSoon();
  st.dirty = wasDirty; // only showing a project isn't an edit
  if (resized) requestAnimationFrame(zoomFit);
}
// shows a new or loaded project in a tab (dropping the empty placeholder); save = it isn't in the library yet
function addSet(st, save = true) {
  leaveCurrent(); state.sets = state.sets.filter(s => !s.temp); state.sets.push(st);
  state.setIdx = -1; switchSet(state.sets.length - 1); hideHome();
  if (save) scheduleAutosave(st);
}
// closing a tab only closes it - the project stays on the Home page
function closeSet(i) {
  if (i === state.setIdx) leaveCurrent();
  const st = state.sets[i];
  if (st.dirty && !st.temp) { st.dirty = false; saveProject(st).catch(err => console.error('save failed', err)); }
  state.sets.splice(i, 1);
  const none = !state.sets.length; if (none) state.sets.push(placeholderSet());
  const ni = i < state.setIdx ? state.setIdx - 1 : Math.min(state.setIdx, state.sets.length - 1);
  state.setIdx = -1; switchSet(Math.max(0, ni));
  if (none) showHome();
}
// ------------------------------------------------------------------ open-image prompt (Create new / Add current)
function askOpenImages(files) {
  const body = el('div', 'openimg');
  const p = el('p'); p.textContent = files.length > 1 ? `Do you want to add these ${files.length} images as layers in the current set or create a new one?` : 'Do you want to add the image as a layer in the current set or create a new one?';
  const row = el('div', 'openimg-row');
  const big = (svg, label, fn) => { const b = el('button', 'openimg-btn', svg); const sp = el('span'); sp.textContent = label; b.append(sp); b.onclick = () => { h.close(); fn(); }; return b; };
  row.append(
    big('<svg viewBox="0 0 48 48"><rect x="8" y="10" width="32" height="28" rx="1"/><path d="M24 17v14M17 24h14"/></svg>', 'Create new', () => newProjectFromImages(files)),
    big('<svg viewBox="0 0 48 48"><rect x="6" y="16" width="26" height="22" rx="1"/><path d="M12 16v-6h30v22h-10"/><path d="M29 15v12M23 21h12"/></svg>', 'Add current', async () => { for (const f of files) await importImage(f); }),
  );
  body.append(p, row);
  const h = dlg('Open image', body, { noFoot: true });
}
async function openFiles(list) {
  const imgs = [];
  for (const f of list) {
    if (/\.pxz$/i.test(f.name)) askPxz(f);
    else if (/\.(stitch|json)$/i.test(f.name)) { try { const st = await buildSet(JSON.parse(await f.text()), f.name.replace(/\.[^.]+$/, '')); addSet(st); toast('Opened ' + f.name); } catch (err) { toast('Could not open: ' + err.message); } }
    else if (f.type.startsWith('image/')) imgs.push(f);
  }
  if (imgs.length) { if (homeOpen()) newProjectFromImages(imgs); else askOpenImages(imgs); }
}

// ------------------------------------------------------------------ Home page (project library)
const homeEl = $('#home');
const homeOpen = () => !homeEl.hidden;
// switches the working size (W x H) to the project on screen; the shared scratch canvases follow it
function applySize(w, h) {
  if (W === w && H === h) return false;
  W = w; H = h;
  for (const c of [grpC, selC, tmpC, strokeC, shapeC, view]) { c.width = w; c.height = h; }
  gradMap = null;
  return true;
}
let homeFade = null, homeFirst = true; // the fade-out while leaving Home; Home starts visible (index.html) so boot never flashes the editor
async function showHome() {
  const leaving = !!homeFade; if (homeFade) { homeFade.cancel(); homeFade = null; }
  const opening = !homeOpen() || leaving || homeFirst; homeFirst = false;
  if (opening) { closeEditorPopups(); leaveCurrent(); closeMenus(); closeLayerPop(); homeEl.hidden = false; }
  await saveDirty(); // so the cards show the latest pictures
  await renderHome();
  if (opening) { const g = $('#projGrid'); g.classList.add('intro'); setTimeout(() => g.classList.remove('intro'), 700); }
}
function closeEditorPopups() {
  for (const c of [...openDlgs]) c();
  if (!$('#adjModal').hidden) $('#adjCancel').click();
  if (!$('#textModal').hidden) $('#textCancel').click();
  if (pickOnce) { pickOnce = null; stack.classList.remove('picking'); }
  closePop(); hideTip();
}
function hideHome() {
  if (!homeOpen() || homeFade) return;
  $('#whatsNew')?.close();
  const done = () => { homeEl.hidden = true; homeEl.classList.remove('no-anim'); homeEl.style.pointerEvents = ''; homeFade = null; requestAnimationFrame(() => drawOverlay()); };
  if (!motionOK()) { done(); return; }
  homeEl.style.pointerEvents = 'none';
  const a = homeFade = homeEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-in' });
  a.finished.then(() => { if (homeFade === a) done(); }, () => { homeEl.style.pointerEvents = ''; });
}
function timeAgo(t) {
  if (!t) return ''; const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : s < 172800 ? 'yesterday' : new Date(t).toLocaleDateString();
}
// what Home shows: a folder (null = all projects), a search and a sort order (the sort is remembered)
const homeView = { folder: null, q: '', sort: store.get('stitch-home-sort') || 'updated' };
let homeList = [];
const createdAt = (m) => parseInt(String(m.id).slice(1, -5), 36) || m.updated || 0; // project ids start with the time they were made
// folders are names on each project; empty folders are remembered separately so they don't vanish
const savedFolders = () => { const f = store.get('stitch-folders'); return Array.isArray(f) ? f : []; };
const setSavedFolders = (f) => store.set('stitch-folders', [...new Set(f)].sort((a, b) => a.localeCompare(b)));
const allFolders = () => [...new Set([...savedFolders(), ...homeList.map(m => m.folder).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
async function renderHome() {
  let list = []; try { list = await lib.list(); } catch (err) { console.error('could not list projects', err); }
  homeList = list;
  $('#homeBack').hidden = !state.sets.some(s => !s.temp);
  $('#homeEmpty').hidden = list.length > 0;
  if (homeView.folder && !allFolders().includes(homeView.folder)) homeView.folder = null;
  renderFolders(); renderGrid();
}
function renderGrid() {
  const q = homeView.q.trim().toLowerCase(), by = homeView.sort;
  let list = homeList.filter(m => (!homeView.folder || m.folder === homeView.folder) && (!q || (m.name || 'Untitled').toLowerCase().includes(q)));
  const cmp = { updated: (a, b) => (b.updated || 0) - (a.updated || 0), name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }), created: (a, b) => createdAt(b) - createdAt(a), oldest: (a, b) => createdAt(a) - createdAt(b) }[by];
  list = list.slice().sort(cmp);
  const grid = $('#projGrid'); grid.innerHTML = '';
  list.forEach((m, i) => { const c = projectCard(m); c.style.setProperty('--i', Math.min(i, 12)); grid.append(c); });
  const none = $('#homeNone'); none.hidden = !homeList.length || list.length > 0;
  none.textContent = q ? `No projects match “${homeView.q.trim()}”${homeView.folder ? ' in this folder' : ''}.` : 'This folder is empty. Drag projects onto its name, or use a project’s folder button.';
}
const folderIcon = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
function renderFolders() {
  const box = $('#homeFolders'); box.innerHTML = '';
  const chip = (label, folder, count) => {
    const b = el('button', 'hf-chip' + (homeView.folder === folder ? ' on' : ''), folder ? folderIcon : '');
    const t = el('span'); t.textContent = label; const n = el('small'); n.textContent = count; b.append(t, n);
    b.onclick = () => { homeView.folder = folder; renderFolders(); renderGrid(); };
    if (folder) b.ondblclick = () => renameFolder(folder);
    // drop a project card on a folder to move it there ("All projects" takes it out of its folder)
    b.ondragover = (e) => { if (e.dataTransfer.types.includes('stitch/project')) { e.preventDefault(); b.classList.add('drop'); } };
    b.ondragleave = () => b.classList.remove('drop');
    b.ondrop = (e) => { e.preventDefault(); b.classList.remove('drop'); const id = e.dataTransfer.getData('stitch/project'); if (id) moveToFolder(id, folder); };
    return b;
  };
  box.append(chip('All projects', null, homeList.length));
  for (const f of allFolders()) box.append(chip(f, f, homeList.filter(m => m.folder === f).length));
  const add = el('button', 'hf-chip hf-add', '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>'); add.title = 'New folder'; add.onclick = () => newFolder();
  box.append(add);
  if (homeView.folder) {
    const f = homeView.folder;
    const ren = el('button', 'hf-tool'); ren.textContent = 'Rename'; ren.onclick = () => renameFolder(f);
    const del = el('button', 'hf-tool'); del.textContent = 'Delete folder'; del.onclick = () => deleteFolder(f);
    box.append(ren, del);
  }
}
function folderNameDlg(title, initial, okLabel, onName) {
  const body = el('div', 'newproj'), row = el('label', 'np-row'), inp = el('input'); row.textContent = 'Name';
  inp.type = 'text'; inp.value = initial; inp.maxLength = 60; inp.spellcheck = false; row.append(inp); body.append(row);
  const h = dlg(title, body, { okLabel, center: true, outsideClose: true, onOk: () => {
    const v = inp.value.trim(); if (!v) return false;
    if (v !== initial && allFolders().includes(v)) { toast(`There is already a folder called “${v}”`); return false; }
    onName(v);
  } });
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); h.wrap.querySelector('.pill.primary').click(); } };
  setTimeout(() => { inp.focus(); inp.select(); });
}
function newFolder(thenMove) {
  folderNameDlg('New folder', 'New folder', 'Create', async (v) => {
    setSavedFolders([...savedFolders(), v]);
    if (thenMove) await moveToFolder(thenMove, v); else { homeView.folder = v; renderFolders(); renderGrid(); }
  });
}
function renameFolder(f) {
  folderNameDlg('Rename folder', f, 'Rename', async (v) => {
    if (v === f) return;
    for (const m of homeList.filter(x => x.folder === f)) await lib.setFolder(m.id, v);
    setSavedFolders([...savedFolders().filter(x => x !== f), v]);
    if (homeView.folder === f) homeView.folder = v;
    await renderHome();
  });
}
function deleteFolder(f) {
  const n = homeList.filter(m => m.folder === f).length;
  confirmDlg('Delete folder', n ? `Delete the folder “${f}”? Its ${n} project${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} in All projects.` : `Delete the folder “${f}”?`, 'Delete', async () => {
    for (const m of homeList.filter(x => x.folder === f)) await lib.setFolder(m.id, null);
    setSavedFolders(savedFolders().filter(x => x !== f));
    homeView.folder = null; await renderHome();
  });
}
async function moveToFolder(id, folder) {
  const m = homeList.find(x => x.id === id); if (!m || (m.folder || null) === folder) return;
  try { await lib.setFolder(id, folder); } catch (err) { toast('Could not move: ' + err.message); return; }
  if (folder) setSavedFolders([...savedFolders(), folder]);
  toast(folder ? `Moved “${m.name}” to ${folder}` : `Took “${m.name}” out of ${m.folder}`);
  await renderHome();
}
function folderMenu(m, anchor) {
  const box = el('div', 'hf-menu');
  const item = (label, fn, on) => { const b = el('button', on ? 'on' : ''); b.textContent = label; b.onclick = () => { closePop(); fn(); }; box.append(b); };
  item('No folder', () => moveToFolder(m.id, null), !m.folder);
  for (const f of allFolders()) item(f, () => moveToFolder(m.id, f), m.folder === f);
  item('New folder…', () => newFolder(m.id));
  openPop(anchor, box);
}
$('#homeSearch').oninput = () => { homeView.q = $('#homeSearch').value; renderGrid(); };
$('#homeSearch').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { $('#homeSearch').value = ''; homeView.q = ''; renderGrid(); $('#homeSearch').blur(); } };
$('#homeSort').value = homeView.sort;
$('#homeSort').onchange = () => { homeView.sort = $('#homeSort').value; store.set('stitch-home-sort', homeView.sort); renderGrid(); };
function projectCard(m) {
  const card = el('div', 'proj'); card.tabIndex = 0;
  const th = el('div', 'proj-thumb' + (m.kind === 'canvas' ? '' : ' tpl'));
  if (m.thumb) { const img = el('img'); img.src = m.thumb; img.alt = ''; img.draggable = false; th.append(img); }
  if (state.sets.some(s => s.id === m.id && !s.temp)) { const b = el('span', 'proj-open'); b.textContent = 'Open'; th.append(b); }
  const info = el('div', 'proj-info'), nm = el('div', 'proj-name'), meta = el('div', 'proj-meta');
  nm.textContent = m.name || 'Untitled'; nm.title = nm.textContent;
  meta.textContent = `${m.kind === 'canvas' ? `${m.width} × ${m.height}` : 'Shirt + pants template'} · ${timeAgo(m.updated)}${m.folder && !homeView.folder ? ' · ' + m.folder : ''}`;
  info.append(nm, meta);
  const acts = el('div', 'proj-acts');
  const act = (cls, svg, title, fn) => { const b = el('button', 'proj-act ' + cls, svg); b.title = title; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
  const fBtn = act('', folderIcon, 'Move to folder', () => folderMenu(m, fBtn));
  acts.append(fBtn);
  if (lib.versions) acts.append(act('', '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/></svg>', 'Version history', () => openVersions(m)));
  acts.append(
    act('', '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>', 'Duplicate', () => duplicateProject(m)),
    act('danger', '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>', 'Delete', () => deleteProject(m)),
  );
  card.append(th, info, acts);
  card.onclick = () => openProject(m.id);
  card.draggable = true;
  card.ondragstart = (e) => { e.dataTransfer.setData('stitch/project', m.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); };
  card.ondragend = () => card.classList.remove('dragging');
  card.onkeydown = (e) => { if (e.key === 'Enter') openProject(m.id); else if (e.key === 'Delete') deleteProject(m); };
  return card;
}
async function openProject(id) {
  const i = state.sets.findIndex(s => s.id === id && !s.temp);
  if (i >= 0) { if (i !== state.setIdx) switchSet(i); hideHome(); return; }
  try {
    const txt = await lib.read(id); if (!txt) throw new Error('the project file is missing');
    addSet(await buildSet(JSON.parse(txt), 'Untitled', id), false);
  } catch (err) { toast('Could not open: ' + err.message); }
}
// ---- version history: earlier copies of a project, kept by main.js ("Version history")
function whenText(t) {
  const d = new Date(t), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'Today, ' + time;
  if (d.toDateString() === y.toDateString()) return 'Yesterday, ' + time;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + time;
}
const sizeText = (b) => b < 1e6 ? Math.max(1, Math.round(b / 1e3)) + ' KB' : (b / 1e6).toFixed(1) + ' MB';
async function openVersions(m) {
  if (!lib.versions) return;
  await saveDirty();
  let list = []; try { list = await lib.versions(m.id); } catch (err) { toast('Could not read the history: ' + err.message); return; }
  const body = el('div', 'versions');
  const intro = el('p', 'np-note'); intro.textContent = 'Earlier copies of this project, kept as you work: every one from the last hour, one an hour for the last day, then one a day. Up to 20 copies.';
  body.append(intro);
  if (!list.length) { const p = el('p', 'ver-empty'); p.textContent = 'No earlier copies yet. One is kept each time you work on the project for more than 10 minutes.'; body.append(p); }
  const rows = el('div', 'ver-list');
  for (const v of list) {
    const row = el('div', 'ver-row'), info = el('div', 'ver-info'), a = el('div', 'ver-when'), b = el('div', 'ver-meta');
    a.textContent = whenText(v.time); b.textContent = `${timeAgo(v.time)} · ${sizeText(v.size)}`; info.append(a, b);
    const copy = el('button', 'mini'); copy.textContent = 'Open as copy'; copy.onclick = () => { h.close(); openVersionCopy(m, v); };
    const rest = el('button', 'mini primary'); rest.textContent = 'Restore'; rest.onclick = () => { h.close(); restoreVersion(m, v); };
    row.append(info, copy, rest); rows.append(row);
  }
  body.append(rows);
  const h = dlg(`Version history - ${m.name || 'Untitled'}`, body, { noFoot: true, center: true, outsideClose: true });
}
async function openVersionCopy(m, v) {
  try {
    const data = JSON.parse(await lib.versionRead(m.id, v.file)); data.name = `${m.name || 'Untitled'} (${whenText(v.time)})`;
    const st = await buildSet(data, data.name); st.id = newProjectId(); addSet(st);
    toast(`Opened the copy from ${whenText(v.time)} as a new project`);
  } catch (err) { toast('Could not open that copy: ' + err.message); }
}
function restoreVersion(m, v) {
  confirmDlg('Restore this version', `Put “${m.name}” back to how it was on ${whenText(v.time)}? The way it is now is kept in its history, so you can undo this from there.`, 'Restore', async () => {
    try {
      const data = JSON.parse(await lib.versionRead(m.id, v.file));
      await saveDirty(); await lib.snapshot(m.id); // keep the current state as a version first
      const i = state.sets.findIndex(s => s.id === m.id && !s.temp), wasActive = i >= 0 && i === state.setIdx && !homeOpen();
      if (i >= 0) { state.sets[i].temp = true; closeSet(i); } // temp: closing it mustn't save over the restore
      data.name = m.name; const st = await buildSet(data, m.name, m.id); await saveProject(st);
      if (i >= 0) { addSet(st, false); if (!wasActive) await showHome(); } else await renderHome();
      toast(`Restored “${m.name}” to ${whenText(v.time)}`);
    } catch (err) { toast('Could not restore: ' + err.message); }
  });
}
async function duplicateProject(m) {
  try {
    const txt = await lib.read(m.id); if (!txt) throw new Error('the project file is missing');
    const data = JSON.parse(txt), id = newProjectId(), name = (m.name || 'Untitled') + ' copy', updated = Date.now();
    data.name = name; data.updated = updated;
    await lib.write(id, JSON.stringify(data), { ...m, id, name, updated });
    toast(`Duplicated “${m.name}”`); renderHome();
  } catch (err) { toast('Could not duplicate: ' + err.message); }
}
function deleteProject(m) {
  confirmDlg('Delete project', `Delete “${m.name}”? This can't be undone.`, 'Delete', async () => {
    const i = state.sets.findIndex(s => s.id === m.id && !s.temp);
    if (i >= 0) { state.sets[i].temp = true; closeSet(i); } // temp: closing it mustn't save it again
    try { await lib.remove(m.id); toast(`Deleted “${m.name}”`); } catch (err) { toast('Could not delete: ' + err.message); }
    renderHome();
  });
}
const TEMPLATE_ICON = '<svg viewBox="0 0 48 48"><path d="M17 8l-9 5 3 8 4-2v19h18V19l4 2 3-8-9-5c-1 3-4 5-7 5s-6-2-7-5z"/></svg>';
const CANVAS_ICON = '<svg viewBox="0 0 48 48"><rect x="7" y="11" width="34" height="26" rx="2"/><path d="M7 31l9-8 7 6 5-4 13 10"/><circle cx="31" cy="19" r="3"/></svg>';
// a dropped/opened image becomes its own project; the user picks Template or Normal (a canvas the image's size)
async function newProjectFromImages(files) {
  const img = new Image(); img.src = URL.createObjectURL(files[0]);
  try { await img.decode(); } catch { toast('Could not read ' + files[0].name); return; } finally { URL.revokeObjectURL(img.src); }
  const name = files[0].name.replace(/\.[^.]+$/, '') || 'Untitled', w = clampSide(img.naturalWidth, 1920), h = clampSide(img.naturalHeight, 1080);
  const create = async (st) => { hd.close(); addSet(st); for (const f of files) await importImage(f, true); };
  const body = el('div', 'openimg newproj-ask'), p = el('p'), row = el('div', 'openimg-row');
  p.textContent = files.length > 1 ? `Make a new project from these ${files.length} images as a…` : `Make a new project from “${name}” as a…`;
  const big = (svg, label, sub, fn) => { const b = el('button', 'openimg-btn np-type', svg); const t = el('span'), s = el('small'); t.textContent = label; s.textContent = sub; b.append(t, s); b.onclick = fn; return b; };
  row.append(
    big(TEMPLATE_ICON, 'Template', 'Roblox shirt + pants, 585 × 559', () => { const st = makeSet(name); if (/pant|leg|trouser|jean|short/i.test(name)) st.mode = 'pants'; create(st); }),
    big(CANVAS_ICON, 'Normal', `A plain canvas, ${w} × ${h}`, () => create(makeSet(name, 'canvas', w, h))),
  );
  body.append(p, row);
  const hd = dlg('New project', body, { noFoot: true, center: true, outsideClose: true });
}
const SIZE_PRESETS = [[1920, 1080, 'Full HD'], [1280, 720, 'HD'], [3840, 2160, '4K'], [1080, 1080, 'Square'], [1080, 1920, 'Portrait'], [512, 512, 'Icon']];
function openNewProjectDialog() {
  const body = el('div', 'newproj');
  const nameRow = el('label', 'np-row'), nameIn = el('input'); nameRow.textContent = 'Name';
  nameIn.type = 'text'; nameIn.value = 'Untitled'; nameIn.maxLength = 80; nameIn.spellcheck = false; nameRow.append(nameIn);
  let kind = 'template';
  const types = el('div', 'openimg-row np-types');
  const typeBtn = (k, svg, label, sub) => { const b = el('button', 'openimg-btn np-type', svg); b.type = 'button'; b.dataset.kind = k; const t = el('span'), s = el('small'); t.textContent = label; s.textContent = sub; b.append(t, s); b.onclick = () => { kind = k; sync(); }; return b; };
  types.append(
    typeBtn('template', TEMPLATE_ICON, 'Template', 'Roblox shirt + pants, 585 × 559'),
    typeBtn('canvas', CANVAS_ICON, 'Normal', 'A plain canvas, any size'),
  );
  const sizeBox = el('div', 'np-size'), dims = el('div', 'np-dims');
  const num = (v) => { const i = el('input'); i.type = 'number'; i.min = 1; i.max = MAX_SIDE; i.value = v; i.oninput = sync; return i; };
  const wIn = num(1920), hIn = num(1080), x = el('span', 'x'), px = el('span', 'x');
  x.textContent = '×'; px.textContent = 'px';
  dims.append('Size', wIn, x, hIn, px);
  const presets = el('div', 'np-presets');
  for (const [w, h, label] of SIZE_PRESETS) { const b = el('button', 'mini'); b.type = 'button'; b.textContent = `${label} ${w}×${h}`; b.dataset.size = w + 'x' + h; b.onclick = () => { wIn.value = w; hIn.value = h; sync(); }; presets.append(b); }
  sizeBox.append(dims, presets);
  const note = el('p', 'np-note'); note.textContent = 'Templates are always 585 × 559, the size Roblox needs. You get Shirt and Pants tabs and the 3D preview.';
  function sync() {
    types.querySelectorAll('.np-type').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
    sizeBox.hidden = kind !== 'canvas'; note.hidden = kind === 'canvas';
    presets.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.size === wIn.value + 'x' + hIn.value));
  }
  body.append(nameRow, types, sizeBox, note); sync();
  const h = dlg('New project', body, { okLabel: 'Create', center: true, outsideClose: true, onOk: () => {
    const name = nameIn.value.trim() || 'Untitled';
    addSet(kind === 'canvas' ? makeSet(name, 'canvas', clampSide(wIn.value, 1920), clampSide(hIn.value, 1080)) : makeSet(name));
    toast(`Created “${name}”`);
  } });
  nameIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); h.wrap.querySelector('.pill.primary').click(); } };
  setTimeout(() => { nameIn.focus(); nameIn.select(); });
}
$('#btnHome').onclick = () => showHome();
$('#homeNew').onclick = () => openNewProjectDialog();
$('#homeOpen').onclick = () => $('#btnOpen').click();
$('#homeBack').onclick = () => hideHome();
$('#homeUpdates').onclick = async () => {
  const b = $('#homeUpdates'); b.disabled = true; b.textContent = 'Checking…';
  try { await checkUpdates(true); } finally { b.disabled = false; b.textContent = 'Check for updates'; }
};
native?.version?.().then(v => { $('#homeVer').textContent = 'Version ' + v; }).catch(() => {});
let homeDrag = 0;
homeEl.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { homeDrag++; homeEl.classList.add('dragging'); } });
homeEl.addEventListener('dragleave', () => { if (--homeDrag <= 0) { homeDrag = 0; homeEl.classList.remove('dragging'); } });
homeEl.addEventListener('drop', () => { homeDrag = 0; homeEl.classList.remove('dragging'); });

// ------------------------------------------------------------------ What's new (floats over Home after an update)
const SEEN_KEY = 'stitch-seen-version';
async function maybeShowWhatsNew(hadData) {
  const ver = (native?.version ? await native.version().catch(() => null) : null) || CHANGELOG[0]?.version;
  let seen = null; try { seen = localStorage.getItem(SEEN_KEY); localStorage.setItem(SEEN_KEY, ver); } catch { /* storage unavailable */ }
  if (!ver || seen === ver || (!seen && !hadData)) return; // same version, or a brand-new install
  const items = seen ? CHANGELOG.filter(c => cmpVersion(c.version, seen) > 0 && cmpVersion(c.version, ver) <= 0) : CHANGELOG.filter(c => c.version === ver);
  if (items.length) showWhatsNew(ver, items);
}
function cmpVersion(a, b) { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; }
function showWhatsNew(ver, items) {
  $('#whatsNew')?.close();
  const card = el('div', 'whatsnew'); card.id = 'whatsNew'; card.setAttribute('role', 'dialog');
  const x = el('button', 'wn-x', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'); x.title = 'Close';
  const h = el('h3'); h.textContent = 'What’s new'; const sub = el('div', 'wn-ver'); sub.textContent = 'Stitch Editor ' + ver;
  card.append(x, h, sub);
  for (const it of items) {
    if (items.length > 1) { const v = el('div', 'wn-sub'); v.textContent = it.version; card.append(v); }
    const ul = el('ul'); for (const n of it.notes) { const li = el('li'); li.textContent = n; ul.append(li); } card.append(ul);
  }
  const ok = el('button', 'primary wn-ok'); ok.textContent = 'Got it'; card.append(ok);
  const outside = (e) => { if (!card.contains(e.target)) card.close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); card.close(); } };
  card.close = () => { card.id = ''; fadeOut(card, () => card.remove()); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
  x.onclick = ok.onclick = () => card.close();
  document.body.append(card);
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); });
}

// ------------------------------------------------------------------ boot
(async function boot() {
  await templateImg.decode().catch(() => {});
  const { hadData } = await loadSession();
  const cur = state.sets[state.setIdx]; state.docs = cur.docs; state.swatches = cur.swatches; applySize(cur.w || TW, cur.h || TH);
  rebuildKeyMap(); buildRegionSelect(); setTool('brush'); renderTabs(); setMode(cur.mode || 'shirt'); rebuildLayers(); changed();
  for (const s of state.sets) s.dirty = false; // just loaded - nothing to save yet
  sessionReady = true; saveDirty();
  requestAnimationFrame(zoomFit);
  // recent colours are remembered between launches; a first launch starts with a few
  let recent = null; try { recent = JSON.parse(localStorage.getItem('stitch-recent')); } catch { /* none saved */ }
  recent = Array.isArray(recent) ? recent.filter(c => /^#[0-9a-f]{6}$/i.test(c)) : [];
  for (const c of (recent.length ? recent : ['#111111', '#ffffff', '#1f2a44', '#d23c3c']).reverse()) addRecent(c, false);
  await showHome();
  maybeShowWhatsNew(hadData);
})();window.__stitchDebug = () => { const d = doc(); return { tool: state.tool, activeId: d.activeId, activeGroup: d.activeGroup, noSel: d.noSel, groups: d.groups, layers: d.layers.map(l => [l.name, l.group, l.locked, l.vec ? { type: l.vec.type, x: l.vec.x, y: l.vec.y, w: l.vec.w, h: l.vec.h, size: l.vec.size, flipX: !!l.vec.flipX, fill: l.vec.fill?.color } : null]), ub: d.activeGroup ? unionBounds(groupMembers(d.activeGroup)) : null }; };
$('#btnFullscreen').onclick = () => { $('#panelsMenu').hidden = true; if (native?.toggleFullscreen) native.toggleFullscreen(); else if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); };
// F11 normally never reaches the page (main.js toggles fullscreen first); this is the fallback
document.addEventListener('keydown', (e) => { if (e.key === 'F11' && !e.repeat) { e.preventDefault(); $('#btnFullscreen').click(); } }, true);
window.__stitchPx = (x, y, mode) => [...(mode ? state.docs[mode] : doc()).layers.find(l => l.id === (mode ? state.docs[mode] : doc()).activeId).ctx.getImageData(x, y, 1, 1).data];
window.__stitchComp = (x, y) => { compositeDoc(doc()); return [...doc().comp.getContext('2d').getImageData(x, y, 1, 1).data]; };
