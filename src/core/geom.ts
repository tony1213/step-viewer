import { MAX_ARC_STEP } from './mesh-params';
import type { Vec3 } from './types';

/** Index of the B-rep face that contains triangle `tri` (binary search over [first,last] pairs), or -1. */
export function findFace(faceRanges: Uint32Array, tri: number): number {
  let lo = 0;
  let hi = faceRanges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (faceRanges[2 * mid + 1] < tri) lo = mid + 1;
    else if (faceRanges[2 * mid] > tri) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/** Sum of triangle areas of triangles [first, last]. */
export function faceArea(position: ArrayLike<number>, index: ArrayLike<number>, first: number, last: number): number {
  let area = 0;
  for (let t = first; t <= last; t++) {
    const a = 3 * index[3 * t];
    const b = 3 * index[3 * t + 1];
    const c = 3 * index[3 * t + 2];
    const ux = position[b] - position[a];
    const uy = position[b + 1] - position[a + 1];
    const uz = position[b + 2] - position[a + 2];
    const vx = position[c] - position[a];
    const vy = position[c + 1] - position[a + 1];
    const vz = position[c + 2] - position[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  return area;
}

function quantKey(position: ArrayLike<number>, v: number, inv: number): string {
  return `${Math.round(position[3 * v] * inv)},${Math.round(position[3 * v + 1] * inv)},${Math.round(position[3 * v + 2] * inv)}`;
}

/**
 * Boundary of one B-rep face: edges used by exactly one triangle (after welding equal positions,
 * so seams of periodic surfaces disappear). Returns the total length and the segments.
 */
export function faceBoundary(
  position: ArrayLike<number>,
  index: ArrayLike<number>,
  first: number,
  last: number,
  tol = 1e-3,
): { length: number; segments: number[] } {
  const inv = 1 / tol;
  const weld = new Map<number, number>();
  const keyIds = new Map<string, number>();
  const rep: number[] = [];
  const idOf = (v: number) => {
    let id = weld.get(v);
    if (id === undefined) {
      const k = quantKey(position, v, inv);
      id = keyIds.get(k);
      if (id === undefined) {
        id = rep.length;
        keyIds.set(k, id);
        rep.push(v);
      }
      weld.set(v, id);
    }
    return id;
  };
  const counts = new Map<string, number>();
  const bump = (a: number, b: number) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (let t = first; t <= last; t++) {
    const a = idOf(index[3 * t]);
    const b = idOf(index[3 * t + 1]);
    const c = idOf(index[3 * t + 2]);
    if (a === b || b === c || a === c) continue;
    bump(a, b);
    bump(b, c);
    bump(c, a);
  }
  let length = 0;
  const segments: number[] = [];
  for (const [k, n] of counts) {
    if (n !== 1) continue;
    const [a, b] = k.split('_').map(Number);
    const pa = 3 * rep[a];
    const pb = 3 * rep[b];
    const dx = position[pb] - position[pa];
    const dy = position[pb + 1] - position[pa + 1];
    const dz = position[pb + 2] - position[pa + 2];
    length += Math.sqrt(dx * dx + dy * dy + dz * dz);
    segments.push(position[pa], position[pa + 1], position[pa + 2], position[pb], position[pb + 1], position[pb + 2]);
  }
  return { length, segments };
}

/**
 * Number of B-rep edges meeting at each vertex of a mesh's edge set, keyed by quantized position.
 * Vertices where != 2 edges meet are B-rep vertices (edge ends).
 */
export function vertexDegrees(edges: ArrayLike<number>, tol = 1e-3): Map<string, number> {
  const inv = 1 / tol;
  const deg = new Map<string, number>();
  for (let s = 0; s < edges.length; s += 3) {
    const k = `${Math.round(edges[s] * inv)},${Math.round(edges[s + 1] * inv)},${Math.round(edges[s + 2] * inv)}`;
    deg.set(k, (deg.get(k) ?? 0) + 1);
  }
  return deg;
}

export interface FaceMetrics {
  /** surface area, mm² (exact for planar faces bounded by lines and circular arcs) */
  area: number;
  /** total boundary length incl. inner loops, mm (circular arcs use their true length) */
  perimeter: number;
  plane: { normal: Vec3; point: Vec3 } | null;
  /** true when circular boundary arcs were found and corrected */
  arcCorrected: boolean;
}

/**
 * Area and perimeter of one B-rep face. Triangulation approximates circles by inscribed
 * polygons, so we find circular boundary arcs (chains between B-rep vertices that fit a
 * circle) and add the difference between the true arc and its chords: arc length for the
 * perimeter and the circular segment areas (signed: holes shrink, convex arcs grow the face).
 */
export function faceMetrics(
  position: ArrayLike<number>,
  index: ArrayLike<number>,
  first: number,
  last: number,
  brepDegrees?: Map<string, number>,
  tol = 1e-3,
): FaceMetrics {
  const inv = 1 / tol;
  const keyIds = new Map<string, number>();
  const keys: string[] = [];
  const rep: number[] = [];
  const weld = new Map<number, number>();
  const idOf = (v: number) => {
    let id = weld.get(v);
    if (id === undefined) {
      const k = quantKey(position, v, inv);
      id = keyIds.get(k);
      if (id === undefined) {
        id = rep.length;
        keyIds.set(k, id);
        keys.push(k);
        rep.push(v);
      }
      weld.set(v, id);
    }
    return id;
  };
  const edgeInfo = new Map<number, { count: number; opposite: number }>();
  const tris: [number, number, number][] = [];
  for (let t = first; t <= last; t++) {
    const a = idOf(index[3 * t]);
    const b = idOf(index[3 * t + 1]);
    const c = idOf(index[3 * t + 2]);
    if (a === b || b === c || a === c) continue;
    tris.push([a, b, c]);
  }
  const n = rep.length;
  const ek = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (const [a, b, c] of tris) {
    for (const [x, y, o] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ]) {
      const k = ek(x, y);
      const e = edgeInfo.get(k);
      if (e) e.count++;
      else edgeInfo.set(k, { count: 1, opposite: o });
    }
  }
  const p = (id: number, k: number) => position[3 * rep[id] + k];
  const dist = (a: number, b: number) => Math.hypot(p(a, 0) - p(b, 0), p(a, 1) - p(b, 1), p(a, 2) - p(b, 2));

  // boundary graph
  const bEdges: { a: number; b: number; opposite: number }[] = [];
  const adj = new Map<number, number[]>();
  let perimeter = 0;
  for (const [k, e] of edgeInfo) {
    if (e.count !== 1) continue;
    const a = Math.floor(k / n);
    const b = k - a * n;
    const id = bEdges.length;
    bEdges.push({ a, b, opposite: e.opposite });
    perimeter += dist(a, b);
    for (const v of [a, b]) {
      let arr = adj.get(v);
      if (!arr) adj.set(v, (arr = []));
      arr.push(id);
    }
  }
  let area = faceArea(position, index, first, last);
  const plane = facePlane(position, index, first, last);

  const isBreak = (v: number) => adj.get(v)!.length !== 2 || (brepDegrees !== undefined && (brepDegrees.get(keys[v]) ?? 2) !== 2);
  const used = new Uint8Array(bEdges.length);
  let arcCorrected = false;
  const processChain = (verts: number[], edgesInChain: number[], closed: boolean) => {
    const pts = closed ? verts.slice(0, -1) : verts;
    if (pts.length < 3) return;
    const flat: number[] = [];
    for (const v of pts) flat.push(p(v, 0), p(v, 1), p(v, 2));
    const fit = fitCircle(flat, closed);
    if (!fit) return;
    const r = fit.radius;
    const [ox, oy, oz] = fit.center;
    for (const eid of edgesInChain) {
      const { a, b, opposite } = bEdges[eid];
      const chord = dist(a, b);
      const theta = 2 * Math.asin(Math.min(1, chord / (2 * r)));
      perimeter += r * theta - chord;
      if (plane) {
        const segArea = 0.5 * r * r * (theta - Math.sin(theta));
        const mx = (p(a, 0) + p(b, 0)) / 2, my = (p(a, 1) + p(b, 1)) / 2, mz = (p(a, 2) + p(b, 2)) / 2;
        const side = (p(opposite, 0) - mx) * (ox - mx) + (p(opposite, 1) - my) * (oy - my) + (p(opposite, 2) - mz) * (oz - mz);
        area += side > 0 ? segArea : -segArea;
      }
    }
    arcCorrected = true;
  };
  const walk = (start: number, firstEdge: number) => {
    const verts = [start];
    const chainEdges: number[] = [];
    let v = start;
    let eid = firstEdge;
    for (;;) {
      used[eid] = 1;
      chainEdges.push(eid);
      const e = bEdges[eid];
      const w = e.a === v ? e.b : e.a;
      verts.push(w);
      if (w === start) return processChain(verts, chainEdges, true);
      if (isBreak(w)) return processChain(verts, chainEdges, false);
      const next = adj.get(w)!.find((x) => !used[x]);
      if (next === undefined) return processChain(verts, chainEdges, false);
      v = w;
      eid = next;
    }
  };
  for (const [v, list] of adj) {
    if (!isBreak(v)) continue;
    for (const eid of list) if (!used[eid]) walk(v, eid);
  }
  for (let eid = 0; eid < bEdges.length; eid++) if (!used[eid]) walk(bEdges[eid].a, eid);

  return { area, perimeter, plane, arcCorrected };
}

/** If the face is planar, its unit normal and a point on it; otherwise null. */
export function facePlane(
  position: ArrayLike<number>,
  index: ArrayLike<number>,
  first: number,
  last: number,
): { normal: Vec3; point: Vec3 } | null {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let t = first; t <= last; t++) {
    const a = 3 * index[3 * t];
    const b = 3 * index[3 * t + 1];
    const c = 3 * index[3 * t + 2];
    const ux = position[b] - position[a];
    const uy = position[b + 1] - position[a + 1];
    const uz = position[b + 2] - position[a + 2];
    const vx = position[c] - position[a];
    const vy = position[c + 1] - position[a + 1];
    const vz = position[c + 2] - position[a + 2];
    nx += uy * vz - uz * vy;
    ny += uz * vx - ux * vz;
    nz += ux * vy - uy * vx;
    for (const p of [a, b, c]) {
      minX = Math.min(minX, position[p]); maxX = Math.max(maxX, position[p]);
      minY = Math.min(minY, position[p + 1]); maxY = Math.max(maxY, position[p + 1]);
      minZ = Math.min(minZ, position[p + 2]); maxZ = Math.max(maxZ, position[p + 2]);
    }
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 0)) return null;
  nx /= len;
  ny /= len;
  nz /= len;
  const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
  const tol = diag * 1e-5 + 1e-5;
  const p0 = 3 * index[3 * first];
  const px = position[p0], py = position[p0 + 1], pz = position[p0 + 2];
  for (let t = first; t <= last; t++) {
    for (let k = 0; k < 3; k++) {
      const p = 3 * index[3 * t + k];
      const d = (position[p] - px) * nx + (position[p + 1] - py) * ny + (position[p + 2] - pz) * nz;
      if (Math.abs(d) > tol) return null;
    }
  }
  return { normal: [nx, ny, nz], point: [px, py, pz] };
}

/** Perpendicular distance between two planes if they are parallel (within ~0.06°), otherwise null. */
export function parallelPlaneDistance(n1: Vec3, p1: Vec3, n2: Vec3, p2: Vec3, cosTol = 1 - 5e-7): number | null {
  const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
  if (Math.abs(dot) < cosTol) return null;
  return Math.abs((p2[0] - p1[0]) * n1[0] + (p2[1] - p1[1]) * n1[1] + (p2[2] - p1[2]) * n1[2]);
}

export interface CircleFit {
  center: Vec3;
  normal: Vec3;
  radius: number;
  maxDeviation: number;
  /** angular span covered by the points, radians (2π for a closed loop) */
  span: number;
}

/**
 * Fit a circle to 3D points (flat xyz array). Returns null when the points are not
 * coplanar, collinear, or do not lie on a common circle within tolerance.
 */
export function fitCircle(pts: ArrayLike<number>, closed: boolean, maxStep = MAX_ARC_STEP): CircleFit | null {
  const n = Math.floor(pts.length / 3);
  if (n < 3) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[3 * i];
    cy += pts[3 * i + 1];
    cz += pts[3 * i + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  // Newell normal of the (implicitly closed) polygon
  let nx = 0, ny = 0, nz = 0;
  let extent = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[3 * i] - cx, ay = pts[3 * i + 1] - cy, az = pts[3 * i + 2] - cz;
    const bx = pts[3 * j] - cx, by = pts[3 * j + 1] - cy, bz = pts[3 * j + 2] - cz;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
    extent = Math.max(extent, Math.sqrt(ax * ax + ay * ay + az * az));
  }
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(extent > 0) || nl < extent * extent * 1e-9) return null;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const planeTol = extent * 1e-4 + 1e-5;
  // in-plane basis
  let ux: number, uy: number, uz: number;
  if (Math.abs(nx) < 0.9) {
    ux = 0; uy = nz; uz = -ny; // n × X
  } else {
    ux = -nz; uy = 0; uz = nx; // n × Y
  }
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[3 * i] - cx, dy = pts[3 * i + 1] - cy, dz = pts[3 * i + 2] - cz;
    if (Math.abs(dx * nx + dy * ny + dz * nz) > planeTol) return null;
    const x = dx * ux + dy * uy + dz * uz;
    const y = dx * vx + dy * vy + dz * vz;
    xs[i] = x;
    ys[i] = y;
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    sxz += x * z; syz += y * z; sz += z;
  }
  // Kasa fit: [sxx sxy sx; sxy syy sy; sx sy n] [D E F]^T = -[sxz syz sz]^T
  const m = [
    [sxx, sxy, sx, -sxz],
    [sxy, syy, sy, -syz],
    [sx, sy, n, -sz],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-300) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k];
    }
  }
  const D = m[0][3] / m[0][0];
  const E = m[1][3] / m[1][1];
  const F = m[2][3] / m[2][2];
  const ox = -D / 2;
  const oy = -E / 2;
  const r2 = ox * ox + oy * oy - F;
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  if (radius > extent * 1e3) return null; // practically a straight line
  let maxDeviation = 0;
  const angles: number[] = [];
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - ox, dy = ys[i] - oy;
    maxDeviation = Math.max(maxDeviation, Math.abs(Math.sqrt(dx * dx + dy * dy) - radius));
    angles.push(Math.atan2(dy, dx));
  }
  if (maxDeviation > radius * 1e-3 + 1e-4) return null;
  // walk the ordered points: accumulate the turned angle and reject coarse polygons
  let turned = 0;
  const steps = closed ? n : n - 1;
  for (let i = 1; i <= steps; i++) {
    let d = angles[i % n] - angles[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) > maxStep) return null;
    turned += d;
  }
  const span = closed ? 2 * Math.PI : Math.abs(turned);
  return {
    center: [cx + ox * ux + oy * vx, cy + ox * uy + oy * vy, cz + ox * uz + oy * vz],
    normal: [nx, ny, nz],
    radius,
    maxDeviation,
    span,
  };
}
