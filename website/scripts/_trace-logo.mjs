'use strict';

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'public/assets/Logo.png');

const { data, info } = await sharp(src)
  .raw()
  .toBuffer({ resolveWithObject: true });

const W = info.width;
const H = info.height;

const at = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return data[(y * W + x) * 4 + 3] > 80;
};

const opaque = [];
for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] > 128) opaque.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
const med = (ch) => {
  const arr = opaque.map((p) => p[ch]).sort((a, b) => a - b);
  return arr[(arr.length / 2) | 0];
};
const fill = `#${med(0).toString(16).padStart(2, '0')}${med(1).toString(16).padStart(2, '0')}${med(2).toString(16).padStart(2, '0')}`;
console.log('median fill:', fill);

// Contour vectorisation on the pixel-corner lattice.
// Emit directed boundary edges with the opaque cell kept on the LEFT, then chain
// them minimum-turn-first. Contour never self-crosses.

const edges = [];
const cd = new Map();
const keyOf = (x, y) => `${x},${y}`;

function addEdge(x, y, side) {
  let a, b;
  switch (side) {
    case 'L': a = [x, y]; b = [x, y + 1]; break;      // opaque is west (x-1), inside on left
    case 'T': a = [x + 1, y]; b = [x, y]; break;       // opaque is north (y-1)
    case 'B': a = [x, y + 1]; b = [x + 1, y + 1]; break; // opaque is south (y+1)
    case 'R': a = [x + 1, y + 1]; b = [x + 1, y]; break; // opaque is east (x+1)
  }
  const idx = edges.length;
  edges.push({ a, b });
  const ka = keyOf(a[0], a[1]), kb = keyOf(b[0], b[1]);
  if (!cd.has(ka)) cd.set(ka, []);
  if (!cd.has(kb)) cd.set(kb, []);
  cd.get(ka).push(idx);
  cd.get(kb).push(idx);
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!at(x, y)) continue;
    if (!at(x - 1, y)) addEdge(x, y, 'L');
    if (!at(x, y - 1)) addEdge(x, y, 'T');
    if (!at(x + 1, y)) addEdge(x, y, 'R');
    if (!at(x, y + 1)) addEdge(x, y, 'B');
  }
}

console.log('boundary edges:', edges.length);

function buildLoops() {
  const consumed = new Array(edges.length).fill(false);
  const loops = [];
  const ptEq = (p, q) => p[0] === q[0] && p[1] === q[1];
  for (let s0 = 0; s0 < edges.length; s0++) {
    if (consumed[s0]) continue;
    consumed[s0] = true;
    const loop = [edges[s0].a.slice(), edges[s0].b.slice()];
    let head = edges[s0].b;
    let prevPt = edges[s0].a;
    let guard = 0;
    while (guard++ < edges.length + 2) {
      const cands = (cd.get(keyOf(head[0], head[1])) || []).filter((i) => !consumed[i]);
      if (!cands.length) break;
      const inDX = head[0] - prevPt[0], inDY = head[1] - prevPt[1];
      let best = cands[0], bestAng = Infinity;
      for (const ei of cands) {
        const e = edges[ei];
        const s = ptEq(e.a, head) ? e.a : e.b;
        const t = ptEq(e.a, head) ? e.b : e.a;
        const oDX = t[0] - s[0], oDY = t[1] - s[1];
        const denom = (Math.hypot(inDX, inDY) || 1) * (Math.hypot(oDX, oDY) || 1);
        const dot = Math.max(-1, Math.min(1, (inDX * oDX + inDY * oDY) / denom));
        const ang = Math.acos(dot);
        if (ang < bestAng) { bestAng = ang; best = ei; }
      }
      consumed[best] = true;
      const e = edges[best];
      const t = ptEq(e.a, head) ? e.b : e.a;
      prevPt = head;
      head = t;
      loop.push(head.slice());
      if (ptEq(head, loop[0])) break;
    }
    if (loop.length > 4) loops.push(loop);
  }
  return loops;
}

const rawLoops = buildLoops();
console.log('loops built:', rawLoops.length);
rawLoops.forEach((l, i) => {
  const xs = l.map((p) => p[0]), ys = l.map((p) => p[1]);
  console.log(`raw ${i}: pts=${l.length} bbox x${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)} y${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} closed=${l.length>=4 && l[0][0]===l[l.length-1][0] && l[0][1]===l[l.length-1][1]}`);
});

// Exact simplification: drop points that are collinear with their neighbors so the
// outline stays pixel-identical. Corner vertices are never moved.
function snapCorners(ring) {
  const Q = ring.slice(0, -1);
  if (Q.length <= 4) return Q;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const keep = [Q[0]];
  for (let i = 1; i < Q.length - 1; i++) {
    const a = Q[i - 1], b = Q[i], c = Q[i + 1];
    if (cross(a, b, c) !== 0) keep.push(b);
  }
  keep.push(Q[Q.length - 1]);
  return keep;
}

// RDP that operates on the snapped (corner-preserving) ring. The ring is open here:
// first===last (closed). We run DP on the closed ring by splitting at the two points
// that are farthest apart, simplifying each half as an open polyline, then rejoining.
function distToLine(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function dpOpen(points, eps) {
  if (points.length < 3) return points;
  const first = points[0], last = points[points.length - 1];
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToLine(points[i], first, last);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const l = dpOpen(points.slice(0, idx + 1), eps);
    const r = dpOpen(points.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  return [first, last];
}

function simplifyRingDP(ring, eps) {
  const Q = ring.slice(0, -1);
  if (Q.length <= 4) return Q;
  // pick the pair of vertices with max boundary distance -> robust split
  const n = Q.length;
  let best = 0, bi = 0, bj = 1, maxD2 = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Q[j][0] - Q[i][0], dy = Q[j][1] - Q[i][1];
      const d2 = dx * dx + dy * dy;
      if (d2 > maxD2) { maxD2 = d2; bi = i; bj = j; }
    }
  }
  let A, B;
  if (bi > bj) { A = bj; B = bi; } else { A = bi; B = bj; }
  const half1 = Q.slice(A, B + 1);
  const half2 = Q.slice(B).concat(Q.slice(0, A + 1));
  const s1 = dpOpen(half1, eps);
  const s2 = dpOpen(half2, eps);
  const joined = s1.concat(s2.slice(1, -1));
  // dedupe adjacent
  const out = [];
  for (const p of joined) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

// snap (exact collinear) then DP (merge sub-px stair-steps, keep corners > eps)
const loopsOut = rawLoops
  .map((l) => snapCorners(l))
  .map((l) => simplifyRingDP(l, 0.5))
  .filter((l) => l.length >= 4);
console.log(`${loopsOut.length} simplified loops`);
loopsOut.forEach((loop, i) => {
  const xs = loop.map((p) => p[0]), ys = loop.map((p) => p[1]);
  console.log(`loop ${i}: pts=${loop.length} bbox x${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)} y${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}`);
});

// The accent dot is a geometric circle: bbox x253..295 y25..68 → cx=274, cy=46.5, r=21
const DOT = { cx: 274, cy: 46.5, r: 21 };

// Reverse the winding of a loop (needed so a counter hole is carved by fill-rule=evenodd)
function reverseLoop(loop) {
  return [loop[0]].concat(loop.slice(1).reverse());
}

function dFor(loop, t) {
  return loop
    .map(([x, y], i) => {
      const [tx, ty] = t(x, y);
      return `${i === 0 ? 'M' : 'L'}${tx.toFixed(2)} ${ty.toFixed(2)}`;
    })
    .join(' ') + ' Z';
}

// Classify each loop by its bbox:
//  - dot:      lives above the letters (maxY < ~80, y25..68), width ~42
//  - counter:  inside the A (x316..376, y131..205) — minX >= 300
//  - A outer:  spans minX>=200 and maxX>400 (x233..476)
//  - V+Í:      everything else (left ligature x33..275)
function classify(loop) {
  const xs = loop.map((p) => p[0]);
  const ys = loop.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxY < 80) return 'dot';
  if (minX >= 300) return 'counter';
  if (minX >= 200 && maxX > 400) return 'a';
  return 'vi';
}

// SVG content: each glyph is a separate FILLED path so overlapping outer loops never
// punch each other out. The A is a single evenodd path: outer loop + reversed counter.
function buildContents(t, fillColor = fill) {
  const byType = { dot: [], counter: [], a: [], vi: [] };
  loopsOut.forEach((loop) => byType[classify(loop)].push(loop));
  const parts = [];
  if (byType.vi.length) {
    parts.push(`<path d="${byType.vi.map((l) => dFor(l, t)).join(' ')}" fill="${fillColor}"/>`);
  }
  if (byType.a.length && byType.counter.length) {
    const A = byType.a[0];
    const hole = reverseLoop(byType.counter[0]);
    parts.push(`<path d="${dFor(A, t)} ${dFor(hole, t)}" fill="${fillColor}" fill-rule="evenodd"/>`);
  }
  if (byType.dot.length) {
    const dot = byType.dot[0];
    const [cx, cy] = t(DOT.cx, DOT.cy);
    const r = DOT.r * (t(1, 0)[0] - t(0, 0)[0]);
    parts.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="${fillColor}"/>`);
  }
  return parts.join('\n  ');
}

function writeSvg(out, vb, t, label) {
  const body = buildContents(t);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb[0]} ${vb[1]}" role="img" aria-label="${label}">\n  ${body}\n</svg>\n`;
  return writeFile(resolve(root, out), svg).then(() => console.log('wrote', out));
}

{
  // aspect-correct viewBox: preserve 572:290 ratio, no anisotropic stretch
  const kB = 240 / 572;
  const vb = [240, 290 * kB];
  await writeSvg('public/assets/logo.svg', vb, (x, y) => [x * kB, y * kB], 'VÍA');
}
{
  const vb = [80, 80];
  const s = Math.min(80 / W, 80 / H);
  const ox = (80 - W * s) / 2, oy = (80 - H * s) / 2;
  await writeSvg('public/assets/logo-mark.svg', vb, (x, y) => [x * s + ox, y * s + oy], 'VÍA');
}
{
  const s = Math.min(80 / W, 80 / H);
  const ox = (80 - W * s) / 2, oy = (80 - H * s) / 2;
  await writeSvg('public/favicon.svg', [80, 80], (x, y) => [x * s + ox, y * s + oy], 'VÍA');
}
{
  const s = Math.min(32 / W, 32 / H);
  const ox = (32 - W * s) / 2, oy = (32 - H * s) / 2;
  await writeSvg('public/favicon-32.svg', [32, 32], (x, y) => [x * s + ox, y * s + oy], 'VÍA');
}

{
  // OG image: 1200x630, #7C3AED background, white slab wordmark at the top-left
  // region, tagline rows beneath. Trace the wordmark at 572x290 aspect.
  const w = 572, h = 290;
  const scale = 0.5; // wordsmark rendered ~286x145 on the 1200x630 canvas
  const ox = 60, oy = 60;
  const t = (x, y) => [x * scale + ox, y * scale + oy];
  const wordmark = buildContents(t, '#FFFFFF');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="VÍA Automations">
  <rect width="1200" height="630" fill="#7C3AED"/>
  ${wordmark}
  <text x="60" y="340" font-size="52" font-weight="700" fill="#FFFFFF"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">Every web lead, answered in seconds.</text>
  <text x="60" y="396" font-size="30" fill="#FFFFFF" fill-opacity="0.72"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">V.I.A Automations · Lead Recovery for Home Services</text>
  <text x="1140" y="600" text-anchor="end" font-size="22" fill="#FFFFFF" fill-opacity="0.5"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">viaaiautomation.work.gd</text>
</svg>
`;
  await writeFile(resolve(root, 'assets/og-image.svg'), svg);
  console.log('wrote assets/og-image.svg');
}

console.log('DONE');