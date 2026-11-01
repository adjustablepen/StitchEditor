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
