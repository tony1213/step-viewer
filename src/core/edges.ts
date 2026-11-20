import { fitCircle } from './geom';
import type { CircleEdge } from './types';

export interface WeldResult {
  /** welded id per input vertex */
  ids: Uint32Array;
  count: number;
  /** position of each welded id (first vertex seen) */
  unique: Float64Array;
}

/** Default weld tolerance: 1 µm for normal-sized models, relaxed for huge coordinates. */
export function weldTolerance(position: ArrayLike<number>): number {
  let maxAbs = 0;
  for (let i = 0; i < position.length; i++) maxAbs = Math.max(maxAbs, Math.abs(position[i]));
  return Math.max(1e-3, maxAbs * 1e-6);
}

/** Merge vertices with equal quantized positions using an open-addressing hash table. */
export function weldVertices(position: ArrayLike<number>, tol: number): WeldResult {
  const n = Math.floor(position.length / 3);
  const ids = new Uint32Array(n);
  let cap = 16;
  while (cap < n * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  const qz = new Int32Array(n);
  const unique = new Float64Array(n * 3);
  const inv = 1 / tol;
  let count = 0;
  for (let v = 0; v < n; v++) {
    const x = position[3 * v];
    const y = position[3 * v + 1];
    const z = position[3 * v + 2];
    const ix = Math.round(x * inv);
    const iy = Math.round(y * inv);
    const iz = Math.round(z * inv);
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    for (;;) {
      const u = table[h];
      if (u === -1) {
        table[h] = count;
        qx[count] = ix;
        qy[count] = iy;
        qz[count] = iz;
        unique[3 * count] = x;
        unique[3 * count + 1] = y;
        unique[3 * count + 2] = z;
        ids[v] = count++;
        break;
      }
      if (qx[u] === ix && qy[u] === iy && qz[u] === iz) {
        ids[v] = u;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return { ids, count, unique };
}

export interface EdgeResult {
  /** independent segments [x0,y0,z0,x1,y1,z1, ...] */
  edges: Float32Array;
  circles: CircleEdge[];
  closed: boolean;
}

/**
 * B-rep edges of one mesh: for every B-rep face, the triangle edges used exactly once
 * inside that face form its boundary. Boundaries shared by two faces are emitted once.
 * Seams of periodic faces (cylinders, ...) vanish because their duplicated vertices are welded.
 */
export function extractEdges(position: Float32Array, index: Uint32Array, faceRanges: Uint32Array, tol?: number): EdgeResult {
  const weld = weldVertices(position, tol ?? weldTolerance(position));
  const { ids, count, unique } = weld;
  const key = (a: number, b: number) => (a < b ? a * count + b : b * count + a);

  const faceCount = faceRanges.length / 2;
  const occurrences = new Map<number, number>();
  const segA: number[] = [];
  const segB: number[] = [];
  const local = new Map<number, number>();

  for (let f = 0; f < faceCount; f++) {
    const first = faceRanges[2 * f];
    const last = faceRanges[2 * f + 1];
    local.clear();
    for (let t = first; t <= last; t++) {
      const a = ids[index[3 * t]];
      const b = ids[index[3 * t + 1]];
      const c = ids[index[3 * t + 2]];
      if (a === b || b === c || a === c) continue;
      const k1 = key(a, b);
      const k2 = key(b, c);
      const k3 = key(c, a);
      local.set(k1, (local.get(k1) ?? 0) + 1);
      local.set(k2, (local.get(k2) ?? 0) + 1);
      local.set(k3, (local.get(k3) ?? 0) + 1);
    }
    for (const [k, n] of local) {
      if (n !== 1) continue;
      const seen = occurrences.get(k);
      if (seen === undefined) {
        occurrences.set(k, 1);
        const a = Math.floor(k / count);
        segA.push(a);
        segB.push(k - a * count);
      } else {
        occurrences.set(k, seen + 1);
      }
    }
  }

  let closed = occurrences.size > 0;
  for (const n of occurrences.values()) {
    if (n !== 2) {
      closed = false;
      break;
    }
  }

  const edges = new Float32Array(segA.length * 6);
  for (let s = 0; s < segA.length; s++) {
    const a = 3 * segA[s];
    const b = 3 * segB[s];
    edges[6 * s] = unique[a];
    edges[6 * s + 1] = unique[a + 1];
    edges[6 * s + 2] = unique[a + 2];
    edges[6 * s + 3] = unique[b];
    edges[6 * s + 4] = unique[b + 1];
    edges[6 * s + 5] = unique[b + 2];
  }

  return { edges, closed, circles: detectCircles(segA, segB, unique, count) };
}

/**
 * Chain segments into polylines that stop at vertices where != 2 edges meet (B-rep vertices),
 * then keep the chains that are circles or circular arcs.
 */
export function detectCircles(segA: number[], segB: number[], unique: Float64Array, vertexCount: number): CircleEdge[] {
  const nSeg = segA.length;
  const degree = new Uint32Array(vertexCount);
  for (let s = 0; s < nSeg; s++) {
    degree[segA[s]]++;
    degree[segB[s]]++;
  }
  const start = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) start[v + 1] = start[v] + degree[v];
  const fill = start.slice(0, vertexCount);
  const adj = new Uint32Array(2 * nSeg);
  for (let s = 0; s < nSeg; s++) {
    adj[fill[segA[s]]++] = s;
    adj[fill[segB[s]]++] = s;
  }
  const used = new Uint8Array(nSeg);
  const other = (s: number, v: number) => (segA[s] === v ? segB[s] : segA[s]);
  const nextSeg = (v: number) => {
    for (let k = start[v]; k < start[v + 1]; k++) if (!used[adj[k]]) return adj[k];
    return -1;
  };

  const found: { circle: CircleEdge; span: number }[] = [];
  const consider = (chain: number[], closed: boolean) => {
    const pts = closed ? chain.slice(0, -1) : chain;
    // ≥4 points for arcs: any 3 points lie on some circle, so 3-point spline edges would be false positives
    if (pts.length < (closed ? 8 : 4)) return;
    const flat = new Float64Array(pts.length * 3);
    pts.forEach((v, i) => {
      flat[3 * i] = unique[3 * v];
      flat[3 * i + 1] = unique[3 * v + 1];
      flat[3 * i + 2] = unique[3 * v + 2];
    });
    const fit = fitCircle(flat, closed);
    if (!fit) return;
    if (!closed && fit.span < (20 * Math.PI) / 180) return;
    found.push({
      circle: { center: fit.center, normal: fit.normal, radius: fit.radius, full: closed || fit.span > 2 * Math.PI - 0.05 },
      span: fit.span,
    });
  };

  const walk = (from: number, s: number): { chain: number[]; closed: boolean } => {
    const chain = [from];
    let v = from;
    let seg = s;
    for (;;) {
      used[seg] = 1;
      const w = other(seg, v);
      chain.push(w);
      if (w === from) return { chain, closed: true };
      if (degree[w] !== 2) return { chain, closed: false };
      const nxt = nextSeg(w);
      if (nxt < 0) return { chain, closed: false };
      v = w;
      seg = nxt;
    }
  };

  // open chains start at B-rep vertices (degree != 2)
  for (let v = 0; v < vertexCount; v++) {
    if (degree[v] === 0 || degree[v] === 2) continue;
    for (let s = nextSeg(v); s >= 0; s = nextSeg(v)) {
      const { chain, closed } = walk(v, s);
      consider(chain, closed);
    }
  }
  // what is left are closed loops (e.g. holes)
  for (let s = 0; s < nSeg; s++) {
    if (used[s]) continue;
    const { chain, closed } = walk(segA[s], s);
    consider(chain, closed);
  }
  return mergeArcs(found);
}

/**
 * CAD systems often split a hole's circle into two (or more) arcs. Arcs sharing centre,
 * radius and plane whose spans add up to a full turn are reported as one full circle.
 */
function mergeArcs(found: { circle: CircleEdge; span: number }[]): CircleEdge[] {
  const out: CircleEdge[] = [];
  const arcs = found.filter((f) => !f.circle.full);
  for (const f of found) if (f.circle.full) out.push(f.circle);
  const taken = new Uint8Array(arcs.length);
  for (let i = 0; i < arcs.length; i++) {
    if (taken[i]) continue;
    const a = arcs[i].circle;
    const tol = a.radius * 2e-3 + 2e-3;
    const group = [i];
    let span = arcs[i].span;
    for (let j = i + 1; j < arcs.length; j++) {
      if (taken[j]) continue;
      const b = arcs[j].circle;
      if (Math.abs(a.radius - b.radius) > tol) continue;
      if (Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]) > tol) continue;
      if (Math.abs(a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2]) < 0.9995) continue;
      group.push(j);
      span += arcs[j].span;
    }
    if (group.length > 1 && span > 2 * Math.PI - 0.05) {
      for (const k of group) taken[k] = 1;
      out.push({ ...a, full: true });
    } else {
      taken[i] = 1;
      out.push(a);
    }
  }
  return out;
}
