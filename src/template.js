// Roblox classic clothing template layout (585 x 559). Shirts and pants share it.
// Rects are [x, y, width, height]. "Right"/"Left" are the character's own right/left.
export const W = 585;
export const H = 559;

export const TORSO = {
  U: [231, 8, 128, 64],
  R: [165, 74, 64, 128],
  F: [231, 74, 128, 128],
  L: [361, 74, 64, 128],
  B: [427, 74, 128, 128],
  D: [231, 204, 128, 64],
};

// Right arm (shirt) / right leg (pants) - left-hand block of the image
export const RIGHT_LIMB = {
  U: [217, 289, 64, 64],
  L: [19, 355, 64, 128],
  B: [85, 355, 64, 128],
  R: [151, 355, 64, 128],
  F: [217, 355, 64, 128],
  D: [217, 485, 64, 64],
};

// Left arm (shirt) / left leg (pants) - right-hand block of the image
export const LEFT_LIMB = {
  U: [308, 289, 64, 64],
  F: [308, 355, 64, 128],
  L: [374, 355, 64, 128],
  B: [440, 355, 64, 128],
  R: [506, 355, 64, 128],
  D: [308, 485, 64, 64],
};

export const PARTS = { torso: TORSO, right: RIGHT_LIMB, left: LEFT_LIMB };
export const FACE_ORDER = ['F', 'B', 'L', 'R', 'U', 'D'];
export const FACE_NAMES = { F: 'Front', B: 'Back', L: 'Left', R: 'Right', U: 'Up', D: 'Down' };

export function partName(part, mode) {
  const limb = mode === 'pants' ? 'Leg' : 'Arm';
  return part === 'torso' ? 'Torso' : part === 'right' ? 'Right ' + limb : 'Left ' + limb;
}

const cache = {};
export function regionsFor(mode) {
  if (cache[mode]) return cache[mode];
  const out = [{ id: 'all', label: 'Whole template', group: null, rects: [[0, 0, W, H]] }];
  for (const part of ['torso', 'right', 'left']) {
    const faces = PARTS[part];
    const name = partName(part, mode);
    out.push({ id: part, label: name + ' (all sides)', group: name, part, rects: FACE_ORDER.map(k => faces[k]) });
    for (const k of FACE_ORDER) {
      out.push({ id: part + '.' + k, label: name + ' - ' + FACE_NAMES[k], short: FACE_NAMES[k], group: name, part, face: k, rects: [faces[k]] });
    }
  }
  return (cache[mode] = out);
}

export function regionAt(x, y, mode) {
  for (const r of regionsFor(mode)) {
    if (!r.face) continue;
    const [rx, ry, rw, rh] = r.rects[0];
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return r;
  }
  return null;
}

export function boundsOf(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of rects) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
  return [x0, y0, x1 - x0, y1 - y0];
}

// Unit-box face corners (TL, TR, BR, BL as they sit in the template rect) + normals, shared with the 3D preview.
// Character faces +Z; its right side is -X.
export const FACES = {
  F: { c: [[-1, 1, 1], [1, 1, 1], [1, -1, 1], [-1, -1, 1]], n: [0, 0, 1] },
  B: { c: [[1, 1, -1], [-1, 1, -1], [-1, -1, -1], [1, -1, -1]], n: [0, 0, -1] },
  R: { c: [[-1, 1, -1], [-1, 1, 1], [-1, -1, 1], [-1, -1, -1]], n: [-1, 0, 0] },
  L: { c: [[1, 1, 1], [1, 1, -1], [1, -1, -1], [1, -1, 1]], n: [1, 0, 0] },
  U: { c: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], n: [0, 1, 0] },
  D: { c: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]], n: [0, -1, 0] },
};

// Seams: face edges that meet on the 3D body but sit apart on the template.
// Each edge: p0 -> p1 in template px, n = inward normal. Walking a's edge from p0 to p1 walks b's from p1 to p0.
function faceEdges(rect) {
  const [x, y, w, h] = rect;
  return [
    { p0: [x, y], p1: [x + w, y], n: [0, 1] },
    { p0: [x + w, y], p1: [x + w, y + h], n: [-1, 0] },
    { p0: [x + w, y + h], p1: [x, y + h], n: [0, -1] },
    { p0: [x, y + h], p1: [x, y], n: [1, 0] },
  ];
}
export const SEAMS = (() => {
  const out = [], key = (v) => v.join(',');
  for (const part of ['torso', 'right', 'left']) {
    const list = [];
    for (const k of FACE_ORDER) {
      const c = FACES[k].c, rect = PARTS[part][k];
      faceEdges(rect).forEach((e, i) => list.push({ part, face: k, rect, ...e, a3: key(c[i]), b3: key(c[(i + 1) % 4]) }));
    }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.a3 === b.b3 && a.b3 === b.a3) out.push({ part, a, b });
    }
  }
  return out;
})();
// every face edge with its partner, for looking up "what's across this edge"
export const EDGES = SEAMS.flatMap(s => [{ e: s.a, o: s.b }, { e: s.b, o: s.a }]);

// the point across the seam: p sits d px inside edge e at fraction s along it; the partner point sits d px outside o
export function acrossSeam(e, o, p) {
  const dx = e.p1[0] - e.p0[0], dy = e.p1[1] - e.p0[1], len2 = dx * dx + dy * dy;
  const s = ((p.x - e.p0[0]) * dx + (p.y - e.p0[1]) * dy) / len2;
  const d = (p.x - e.p0[0]) * e.n[0] + (p.y - e.p0[1]) * e.n[1];
  const qx = o.p1[0] + (o.p0[0] - o.p1[0]) * s, qy = o.p1[1] + (o.p0[1] - o.p1[1]) * s;
  return { x: qx - o.n[0] * d, y: qy - o.n[1] * d, s, d };
}
// acrossSeam as a matrix [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f), so maps can be chained
export function seamMatrix(e, o) {
  const q0 = acrossSeam(e, o, { x: 0, y: 0 }), qx = acrossSeam(e, o, { x: 1, y: 0 }), qy = acrossSeam(e, o, { x: 0, y: 1 });
  return [qx.x - q0.x, qx.y - q0.y, qy.x - q0.x, qy.y - q0.y, q0.x, q0.y];
}
// the face rect (and its part) a template point is in
export const ALL_FACES = ['torso', 'right', 'left'].flatMap(part => FACE_ORDER.map(face => ({ part, face, rect: PARTS[part][face] })));
export function faceAt(x, y) {
  for (const f of ALL_FACES) { const [rx, ry, rw, rh] = f.rect; if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return f; }
  return null;
}
