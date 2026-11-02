// Live 3D character preview - plain WebGL2, no dependencies.
import { W, H, PARTS, TORSO, FACES } from './template.js';
import { WOMAN } from './woman-data.js';

const VS = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec2 aUv;
uniform mat4 uVP;
out vec3 vN; out vec2 vUv;
void main(){ vN = aNor; vUv = aUv; gl_Position = uVP * vec4(aPos, 1.0); }`;

// picking: writes where on the template (or the Woman atlas) each screen pixel is.
// RG = u (16 bit), B + A = v (13 bit) | part (2 bit) | hit flag. part: 0 Woman (look up the atlas), 1 torso, 2 arms (shirt), 3 legs (pants)
const PICK_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUv;
uniform int uPart;
out vec4 o;
void main(){
  uint u = uint(clamp(vUv.x, 0.0, 1.0) * 65535.0), v = uint(clamp(vUv.y, 0.0, 1.0) * 8191.0);
  uint ba = (v << 3) | (uint(uPart) << 1) | 1u;
  o = vec4(float(u >> 8) / 255.0, float(u & 255u) / 255.0, float(ba >> 8) / 255.0, float(ba & 255u) / 255.0);
}`;

// builds the Woman texture: every atlas pixel either keeps the skin/face base or takes its template pixel
// (pants first, then shirt over it), using the remap from woman-data.js
const ATLAS_VS = `#version 300 es
in vec2 aP;
void main(){ gl_Position = vec4(aP, 0.0, 1.0); }`;
const ATLAS_FS = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D uMap; uniform sampler2D uBase, uShirt, uPants; uniform vec3 uSkin; uniform int uShow;
out vec4 o;
void main(){
  ivec2 ap = ivec2(gl_FragCoord.xy);
  uvec4 m = texelFetch(uMap, ap, 0);
  if (m.a == 0u) { o = vec4(texelFetch(uBase, ap, 0).rgb, 1.0); return; }
  ivec2 t = ivec2(int(m.r | ((m.b & 3u) << 8)), int(m.g | (((m.b >> 2) & 3u) << 8)));
  vec3 c = uSkin;
  if ((uShow & 2) != 0 && m.a != 2u) { vec4 p = texelFetch(uPants, t, 0); c = mix(c, p.rgb, p.a); }
  if ((uShow & 1) != 0 && m.a != 3u) { vec4 q = texelFetch(uShirt, t, 0); c = mix(c, q.rgb, q.a); }
  o = vec4(c, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUv;
uniform sampler2D uTex; uniform float uLit;
out vec4 o;
void main(){
  vec4 c = texture(uTex, vUv);
  vec3 n = normalize(vN);
  float d = 0.40 + 0.52 * max(dot(n, normalize(vec3(0.45, 0.8, 0.65))), 0.0)
                 + 0.20 * max(dot(n, normalize(vec3(-0.6, 0.25, -0.75))), 0.0)
                 + 0.06 * n.y;
  o = vec4(mix(c.rgb, c.rgb * d, uLit), c.a);
}`;

function pushBox(out, center, size, rects, v0 = 0, v1 = 1) {
  const [cx, cy, cz] = center, [sx, sy, sz] = size.map(s => s / 2);
  for (const k of Object.keys(FACES)) {
    const f = FACES[k];
    let [x, y, w, h] = rects[k];
    if (k !== 'U' && k !== 'D') { y = y + h * v0; h = h * (v1 - v0); }
    // R15 joint caps: borrow a thin strip of the front face at that height so gaps don't show bare skin
    else if (k === 'U' && v0 > 0) { const f = rects.F; [x, y, w, h] = [f[0], f[1] + f[3] * v0, f[2], 1]; }
    else if (k === 'D' && v1 < 1) { const f = rects.F; [x, y, w, h] = [f[0], f[1] + f[3] * v1 - 1, f[2], 1]; }
    const u0 = (x + 0.5) / W, u1 = (x + w - 0.5) / W, t0 = (y + 0.5) / H, t1 = (y + h - 0.5) / H;
    const uv = [[u0, t0], [u1, t0], [u1, t1], [u0, t1]];
    const p = f.c.map(c => [cx + c[0] * sx, cy + c[1] * sy, cz + c[2] * sz]);
    for (const i of [0, 3, 2, 0, 2, 1]) out.push(...p[i], ...f.n, ...uv[i]);
  }
}

function headGeometry(cy) {
  const R = 0.62, hh = 0.6, rc = 0.2, seg = 48, prof = [];
  prof.push([0, -hh, 0, -1]);
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI / 2; prof.push([R - rc + rc * Math.cos(a), -hh + rc + rc * Math.sin(a), Math.cos(a), Math.sin(a)]); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI / 2; prof.push([R - rc + rc * Math.cos(a), hh - rc + rc * Math.sin(a), Math.cos(a), Math.sin(a)]); }
  prof.push([0, hh, 0, 1]);
  const vert = (pi, si) => {
    const [r, y, nr, ny] = prof[pi];
    const th = -Math.PI + (si / seg) * Math.PI * 2;
    const s = Math.sin(th), c = Math.cos(th);
    return [r * s, cy + y, r * c, nr * s, ny, nr * c, si / seg, (hh - y) / (2 * hh)];
  };
  const out = [];
  for (let p = 0; p < prof.length - 1; p++) for (let s = 0; s < seg; s++) {
    const a = vert(p, s), b = vert(p, s + 1), c = vert(p + 1, s + 1), d = vert(p + 1, s);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return out;
}

function discGeometry(r, y) {
  const out = [], seg = 64;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = a => [Math.cos(a) * r, y, Math.sin(a) * r, 0, 1, 0, 0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2];
    out.push(0, y, 0, 0, 1, 0, 0.5, 0.5, ...p(a1), ...p(a0));
  }
  return out;
}

function buildRig(type) {
  const torso = [], arms = [], legs = [];
  const segs = type === 'R15' ? [[0, 0.45], [0.45, 0.85], [0.85, 1]] : [[0, 1]];
  const tsegs = type === 'R15' ? [[0, 0.6], [0.6, 1]] : [[0, 1]];
  const gap = type === 'R15' ? 0.02 : 0;
  const limb = (out, cx, top, rects) => {
    for (const [a, b] of segs) {
      const h = 2 * (b - a) - (segs.length > 1 ? gap : 0);
      const cy = top - 2 * (a + b) / 2;
      pushBox(out, [cx, cy, 0], [1, h, 1], rects, a, b);
    }
  };
  for (const [a, b] of tsegs) {
    const h = 2 * (b - a) - (tsegs.length > 1 ? gap : 0);
    pushBox(torso, [0, 4 - 2 * (a + b) / 2, 0], [2, h, 1], PARTS.torso, a, b);
  }
  limb(arms, -1.5, 4, PARTS.right);
  limb(arms, 1.5, 4, PARTS.left);
  limb(legs, -0.5, 2, PARTS.right);
  limb(legs, 0.5, 2, PARTS.left);
  return { torso, arms, legs };
}

// ---- tiny matrix helpers (column-major)
function perspective(fov, asp, n, f) {
  const t = 1 / Math.tan(fov / 2), nf = 1 / (n - f);
  return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0];
}
function lookAt(e, c, u) {
  let z = [e[0] - c[0], e[1] - c[1], e[2] - c[2]]; let l = Math.hypot(...z); z = z.map(v => v / l);
  let x = [u[1] * z[2] - u[2] * z[1], u[2] * z[0] - u[0] * z[2], u[0] * z[1] - u[1] * z[0]]; l = Math.hypot(...x); x = x.map(v => v / l);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}

export function createPreview(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'preview-canvas';
  container.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) { container.textContent = 'WebGL2 is not available, so the 3D preview cannot run.'; return null; }

  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, 'aPos'); gl.bindAttribLocation(prog, 1, 'aNor'); gl.bindAttribLocation(prog, 2, 'aUv'); gl.linkProgram(prog);
  gl.useProgram(prog);
  const pprog = gl.createProgram();
  gl.attachShader(pprog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pprog, sh(gl.FRAGMENT_SHADER, PICK_FS));
  gl.bindAttribLocation(pprog, 0, 'aPos'); gl.bindAttribLocation(pprog, 1, 'aNor'); gl.bindAttribLocation(pprog, 2, 'aUv'); gl.linkProgram(pprog);
  const ploc = { vp: gl.getUniformLocation(pprog, 'uVP'), part: gl.getUniformLocation(pprog, 'uPart') };
  const loc = { pos: gl.getAttribLocation(prog, 'aPos'), nor: gl.getAttribLocation(prog, 'aNor'), uv: gl.getAttribLocation(prog, 'aUv'), vp: gl.getUniformLocation(prog, 'uVP'), tex: gl.getUniformLocation(prog, 'uTex'), lit: gl.getUniformLocation(prog, 'uLit') };

  function mesh(data) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(loc.nor); gl.vertexAttribPointer(loc.nor, 3, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(loc.uv); gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 32, 24);
    gl.bindVertexArray(null);
    return { vao, buf, count: data.length / 8 };
  }
  function freeMesh(m) { if (m) { gl.deleteBuffer(m.buf); gl.deleteVertexArray(m.vao); } }
  function texture() {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }
  function upload(t, src) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); gl.generateMipmap(gl.TEXTURE_2D); }

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const cv = { torso: mk(W, H), arms: mk(W, H), legs: mk(W, H), head: mk(512, 256), ground: mk(256, 256) };
  const tex = { torso: texture(), arms: texture(), legs: texture(), head: texture(), ground: texture() };

  const opts = { skin: '#f5cd9b', showShirt: true, showPants: true, face: true, autoRotate: false, rig: 'R6' };
  let meshes = {};
  const headMesh = mesh(headGeometry(4.6));
  const groundMesh = mesh(discGeometry(3.4, 0));

  // ---- Woman body: Roblox's own R15 mesh + a per-pixel map of how Roblox composites the template onto it
  const woman = { mesh: null, ready: false, kind: null, idx: null, tex: texture(), map: null, baseTex: null, fb: null };
  const aprog = gl.createProgram();
  gl.attachShader(aprog, sh(gl.VERTEX_SHADER, ATLAS_VS)); gl.attachShader(aprog, sh(gl.FRAGMENT_SHADER, ATLAS_FS));
  gl.bindAttribLocation(aprog, 0, 'aP'); gl.linkProgram(aprog);
  const aloc = { map: gl.getUniformLocation(aprog, 'uMap'), base: gl.getUniformLocation(aprog, 'uBase'), shirt: gl.getUniformLocation(aprog, 'uShirt'), pants: gl.getUniformLocation(aprog, 'uPants'), skin: gl.getUniformLocation(aprog, 'uSkin'), show: gl.getUniformLocation(aprog, 'uShow') };
  const quad = gl.createVertexArray(); gl.bindVertexArray(quad);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);
  const nearestTex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; };
  const garment = { shirt: nearestTex(), pants: nearestTex() };
  const uploadNearest = (t, src) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); };
  const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function loadWoman() {
    if (woman.mesh) return;
    woman.raw = new Float32Array(b64(WOMAN.mesh).buffer); woman.mesh = mesh(Array.from(woman.raw));
    const raw = new Uint8Array(await new Response(new Blob([b64(WOMAN.remap)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const n = WOMAN.atlasW * WOMAN.atlasH, inTorso = (x, y) => Object.values(TORSO).some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
    woman.kind = new Uint8Array(n); woman.idx = new Int32Array(n);
    const map = new Uint8Array(n * 4); // RGB = the packed template x/y from the remap, A = kind
    for (let p = 0; p < n; p++) {
      const r = raw[p * 3], g = raw[p * 3 + 1], b = raw[p * 3 + 2];
      if (!(b & 32)) continue;
      const x = r | ((b & 3) << 8), y = g | (((b >> 2) & 3) << 8);
      woman.idx[p] = (y * W + x) * 4;
      woman.kind[p] = inTorso(x, y) ? 1 : (b & 16) ? 3 : 2; // 1 torso (pants then shirt), 2 shirt only, 3 pants only
      map[p * 4] = r; map[p * 4 + 1] = g; map[p * 4 + 2] = b; map[p * 4 + 3] = woman.kind[p];
    }
    woman.map = nearestTex(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, WOMAN.atlasW, WOMAN.atlasH, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, map);
    woman.baseTex = nearestTex();
    gl.bindTexture(gl.TEXTURE_2D, woman.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, WOMAN.atlasW, WOMAN.atlasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    woman.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, woman.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, woman.tex, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    paintWomanBase(); woman.ready = true; update(lastShirt, lastPants);
  }
  function paintWomanBase() {
    const c = document.createElement('canvas'); c.width = WOMAN.atlasW; c.height = WOMAN.atlasH;
    const g = c.getContext('2d'); g.fillStyle = opts.skin; g.fillRect(0, 0, c.width, c.height);
    if (opts.face) {
      const { eyes: [[ex1, ey], [ex2]], mouth: [mx, my] } = WOMAN.face;
      g.fillStyle = '#1b1b1f'; g.beginPath(); g.ellipse(ex1, ey, 9, 19, 0, 0, Math.PI * 2); g.ellipse(ex2, ey, 9, 19, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#1b1b1f'; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.arc(mx, my - 40, 38, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
    }
    uploadNearest(woman.baseTex, c);
  }
  function buildWomanAtlas(shirt, pants) {
    const S = opts.showShirt && shirt, P = opts.showPants && pants;
    if (S) uploadNearest(garment.shirt, shirt); if (P) uploadNearest(garment.pants, pants);
    gl.bindFramebuffer(gl.FRAMEBUFFER, woman.fb); gl.viewport(0, 0, WOMAN.atlasW, WOMAN.atlasH);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(aprog);
    const unit = (i, t, u) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u, i); };
    unit(1, woman.map, aloc.map); unit(2, woman.baseTex, aloc.base); unit(3, garment.shirt, aloc.shirt); unit(4, garment.pants, aloc.pants);
    const sk = parseInt(opts.skin.slice(1), 16); gl.uniform3f(aloc.skin, (sk >> 16) / 255, ((sk >> 8) & 255) / 255, (sk & 255) / 255);
    gl.uniform1i(aloc.show, (S ? 1 : 0) | (P ? 2 : 0));
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, woman.tex); gl.generateMipmap(gl.TEXTURE_2D);
  }

  function setRig(type) {
    opts.rig = type; dirty = true;
    if (type === 'Woman') { loadWoman(); return; }
    for (const k of ['torso', 'arms', 'legs']) freeMesh(meshes[k]);
    const g = buildRig(type);
    meshes = { torso: mesh(g.torso), arms: mesh(g.arms), legs: mesh(g.legs) };
    update(lastShirt, lastPants);
  }

  function paintGround() {
    const g = cv.ground.getContext('2d'); g.clearRect(0, 0, 256, 256);
    const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grad.addColorStop(0, 'rgba(0,0,0,0.38)'); grad.addColorStop(0.45, 'rgba(0,0,0,0.16)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256); upload(tex.ground, cv.ground);
  }
  function paintHead() {
    const g = cv.head.getContext('2d'); g.fillStyle = opts.skin; g.fillRect(0, 0, 512, 256);
    if (opts.face) {
      g.fillStyle = '#1b1b1f';
      g.beginPath(); g.ellipse(232, 104, 7, 15, 0, 0, Math.PI * 2); g.ellipse(280, 104, 7, 15, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#1b1b1f'; g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.arc(256, 132, 30, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
    }
    upload(tex.head, cv.head);
  }

  let lastShirt = null, lastPants = null;
  function update(shirt, pants) {
    lastShirt = shirt; lastPants = pants;
    if (opts.rig === 'Woman') { if (woman.ready) buildWomanAtlas(shirt, pants); dirty = true; return; }
    const base = (c) => { const g = c.getContext('2d'); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = opts.skin; g.fillRect(0, 0, W, H); return g; };
    let g = base(cv.torso); if (opts.showPants && pants) g.drawImage(pants, 0, 0); if (opts.showShirt && shirt) g.drawImage(shirt, 0, 0);
    g = base(cv.arms); if (opts.showShirt && shirt) g.drawImage(shirt, 0, 0);
    g = base(cv.legs); if (opts.showPants && pants) g.drawImage(pants, 0, 0);
    upload(tex.torso, cv.torso); upload(tex.arms, cv.arms); upload(tex.legs, cv.legs);
    dirty = true;
  }

  // ---- camera: left drag orbits, right drag (or Shift) pans, wheel zooms.
  // Paint mode: the left button paints on the model instead, the right button orbits and Shift+right pans.
  const cam = { theta: 0.55, phi: 1.32, dist: 11.5, ty: 2.55 };
  const defaults = { ...cam };
  let dirty = true, drag = null, painting = null;
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    if (opts.paint && e.button === 0 && !e.shiftKey && hooks.onPaint) {
      const p = devPt(e); painting = p; hooks.onPaint('down', [sampleAt(p.x, p.y)], e); return;
    }
    const pan = e.button === 1 || (opts.paint ? e.button === 2 && e.shiftKey : e.button === 2 || e.shiftKey);
    drag = { x: e.clientX, y: e.clientY, pan };
  });
  canvas.addEventListener('pointermove', e => {
    if (painting) { const p = devPt(e); hooks.onPaint('move', sampleLine(painting, p), e); painting = p; return; }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) cam.ty = Math.min(5, Math.max(0, cam.ty + dy * 0.01));
    else { cam.theta -= dx * 0.01; cam.phi = Math.min(2.9, Math.max(0.15, cam.phi - dy * 0.01)); }
    dirty = true;
  });
  const endDrag = (e) => { if (painting) { painting = null; hooks.onPaint('up', [], e); } drag = null; };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { e.preventDefault(); cam.dist = Math.min(30, Math.max(4, cam.dist * (1 + Math.sign(e.deltaY) * 0.1))); dirty = true; }, { passive: false });
  canvas.addEventListener('dblclick', () => { if (!opts.paint) reset(); });
  function reset() { Object.assign(cam, defaults); dirty = true; }

  function resize() {
    const r = container.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
  }
  new ResizeObserver(resize).observe(container);

  const viewProj = () => {
    const eye = [cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta), cam.ty + cam.dist * Math.cos(cam.phi), cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta)];
    return mul(perspective(0.6, canvas.width / canvas.height, 0.1, 100), lookAt(eye, [0, cam.ty, 0], [0, 1, 0]));
  };
  // [mesh, texture, pick part]: part 0 = Woman (atlas lookup), 1 torso, 2 arms, 3 legs, -1 head (blocks picks, never paints)
  const bodyList = () => opts.rig === 'Woman' ? (woman.ready ? [[woman.mesh, woman.tex, 0]] : []) : [[meshes.torso, tex.torso, 1], [meshes.arms, tex.arms, 2], [meshes.legs, tex.legs, 3], [headMesh, tex.head, -1]];
  function draw({ keepSize = false, shadow = true } = {}) {
    if (!keepSize) resize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog); gl.uniformMatrix4fv(loc.vp, false, viewProj()); gl.uniform1i(loc.tex, 0); gl.activeTexture(gl.TEXTURE0);
    if (shadow) { // ground shadow
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(loc.lit, 0); gl.bindTexture(gl.TEXTURE_2D, tex.ground); gl.bindVertexArray(groundMesh.vao); gl.drawArrays(gl.TRIANGLES, 0, groundMesh.count);
      gl.disable(gl.BLEND);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.uniform1f(loc.lit, 1);
    for (const [m, t] of bodyList()) { gl.bindTexture(gl.TEXTURE_2D, t); gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.count); }
    gl.bindVertexArray(null);
  }

  // ---- picking: the pick pass is drawn and read back once per camera position, then every sample is a lookup
  let pick = null; // { key, w, h, data }
  const fbo = { fb: null, tex: null, depth: null, w: 0, h: 0 };
  const camKey = () => [cam.theta, cam.phi, cam.dist, cam.ty, canvas.width, canvas.height, opts.rig, woman.ready].join('|');
  function readPick() {
    const key = camKey(); if (pick && pick.key === key) return pick;
    const w = canvas.width, h = canvas.height;
    if (fbo.w !== w || fbo.h !== h) {
      if (fbo.fb) { gl.deleteFramebuffer(fbo.fb); gl.deleteTexture(fbo.tex); gl.deleteRenderbuffer(fbo.depth); }
      fbo.fb = gl.createFramebuffer(); fbo.tex = gl.createTexture(); fbo.depth = gl.createRenderbuffer(); fbo.w = w; fbo.h = h;
      gl.bindTexture(gl.TEXTURE_2D, fbo.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindRenderbuffer(gl.RENDERBUFFER, fbo.depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbo.tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, fbo.depth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb); gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(pprog); gl.uniformMatrix4fv(ploc.vp, false, viewProj());
    for (const [m, , part] of bodyList()) {
      gl.uniform1i(ploc.part, Math.max(0, part)); if (part < 0) gl.colorMask(false, false, false, false);
      gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.count); gl.colorMask(true, true, true, true);
    }
    gl.bindVertexArray(null);
    const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return (pick = { key, w, h, data });
  }
  const devPt = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height }; };
  // the template point under a canvas pixel: { x, y, kind } (kind 1 torso, 2 shirt only, 3 pants only) or null
  function sampleAt(px, py) {
    const P = readPick(), x = Math.floor(px), y = Math.floor(py);
    if (x < 0 || y < 0 || x >= P.w || y >= P.h) return null;
    const i = ((P.h - 1 - y) * P.w + x) * 4, d = P.data, ba = (d[i + 2] << 8) | d[i + 3];
    if (!(ba & 1)) return null;
    const part = (ba >> 1) & 3, u = ((d[i] << 8) | d[i + 1]) / 65535, v = (ba >> 3) / 8191;
    if (part) return { x: u * W, y: v * H, kind: part };
    const ax = Math.min(WOMAN.atlasW - 1, Math.floor(u * WOMAN.atlasW)), ay = Math.min(WOMAN.atlasH - 1, Math.floor(v * WOMAN.atlasH)), p = ay * WOMAN.atlasW + ax;
    const k = woman.kind[p]; if (!k) return null;
    const t = woman.idx[p] / 4;
    return { x: t % W + .5, y: Math.floor(t / W) + .5, kind: k };
  }
  // every canvas pixel between two points, so strokes stay solid however fast the pointer moves
  function sampleLine(a, b) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y))), out = [];
    for (let i = 1; i <= n; i++) out.push(sampleAt(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n));
    return out;
  }

  // ---- still images (Save preview image): drawn off screen at any size, framed on the body
  function bodyBounds() {
    if (opts.rig === 'Woman' && woman.ready) {
      if (woman.bb) return woman.bb;
      const a = woman.raw; let y0 = Infinity, y1 = -Infinity, r = 0;
      for (let i = 0; i < a.length; i += 8) { y0 = Math.min(y0, a[i + 1]); y1 = Math.max(y1, a[i + 1]); r = Math.max(r, Math.hypot(a[i], a[i + 2])); }
      return (woman.bb = { y0, y1, r });
    }
    return { y0: 0, y1: 5.25, r: 2.1 };
  }
  // view: { theta, phi } to frame the whole body from that side, or null for the camera as it is
  function renderImage({ w, h, view = null, shadow = true, background = null }) {
    const saved = { ...cam }, cw = canvas.width, ch = canvas.height;
    canvas.width = w; canvas.height = h;
    if (view) {
      const b = bodyBounds(), t = Math.tan(0.3), asp = w / h, hh = (b.y1 - b.y0) / 2 * 1.1, hw = b.r * 1.1;
      Object.assign(cam, { theta: view.theta, phi: view.phi ?? Math.PI / 2 - 0.06, ty: (b.y0 + b.y1) / 2, dist: Math.max(hh / t, hw / (t * asp)) + b.r * .6 });
    }
    draw({ keepSize: true, shadow });
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const x = out.getContext('2d'); if (background) { x.fillStyle = background; x.fillRect(0, 0, w, h); } x.drawImage(canvas, 0, 0);
    Object.assign(cam, saved); canvas.width = cw; canvas.height = ch; dirty = true;
    return out;
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (opts.autoRotate && !drag && !painting) { cam.theta += dt * 0.6; dirty = true; }
    if (dirty) { dirty = false; draw(); }
    requestAnimationFrame(loop);
  }

  setRig('Woman'); paintGround(); paintHead(); update(null, null);
  requestAnimationFrame(loop);

  const hooks = { onPaint: null };
  return {
    update,
    setRig,
    setSkin(c) { opts.skin = c; paintHead(); if (woman.ready) paintWomanBase(); update(lastShirt, lastPants); },
    setShow(shirt, pants) { opts.showShirt = shirt; opts.showPants = pants; update(lastShirt, lastPants); },
    setFace(on) { opts.face = on; paintHead(); if (woman.ready) { paintWomanBase(); update(lastShirt, lastPants); } dirty = true; },
    setAutoRotate(on) { opts.autoRotate = on; },
    setPaint(on) { opts.paint = on; canvas.classList.toggle('painting', on); if (!on) endDrag({}); },
    set onPaint(fn) { hooks.onPaint = fn; },
    reset,
    renderImage,
    snapshot() { draw(); return canvas.toDataURL('image/png'); },
    sampleClient(cx, cy) { const r = canvas.getBoundingClientRect(); return sampleAt((cx - r.left) / r.width * canvas.width, (cy - r.top) / r.height * canvas.height); },
  };
}
