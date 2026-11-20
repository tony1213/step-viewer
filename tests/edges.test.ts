import { describe, expect, it } from 'vitest';
import { detectCircles, extractEdges } from '../src/core/edges';

class MeshBuilder {
  pos: number[] = [];
  idx: number[] = [];
  faces: number[] = [];
  private tri = 0;
  face(vertices: number[][], triangles: number[][]) {
    const base = this.pos.length / 3;
    vertices.forEach((v) => this.pos.push(...v));
    const first = this.tri;
    triangles.forEach((t) => {
      this.idx.push(base + t[0], base + t[1], base + t[2]);
      this.tri++;
    });
    this.faces.push(first, this.tri - 1);
  }
  quad(a: number[], b: number[], c: number[], d: number[]) {
    this.face([a, b, c, d], [
      [0, 1, 2],
      [0, 2, 3],
    ]);
  }
  build() {
    return extractEdges(new Float32Array(this.pos), new Uint32Array(this.idx), new Uint32Array(this.faces));
  }
}

function cube(): MeshBuilder {
  const m = new MeshBuilder();
  m.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
  m.quad([0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]);
  m.quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]);
  m.quad([0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]);
  m.quad([0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]);
  m.quad([1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]);
  return m;
}

/** Closed cylinder: side face with a duplicated seam column + two cap fans. */
function cylinder(n: number, r: number, h: number): MeshBuilder {
  const m = new MeshBuilder();
  const ring = (z: number, j: number) => [r * Math.cos((2 * Math.PI * j) / n), r * Math.sin((2 * Math.PI * j) / n), z];
  const side: number[][] = [];
  for (let j = 0; j <= n; j++) side.push(ring(0, j % n === 0 ? 0 : j), ring(h, j % n === 0 ? 0 : j));
  const sideTris: number[][] = [];
  for (let j = 0; j < n; j++) {
    const a = 2 * j, b = 2 * j + 1, c = 2 * (j + 1), d = 2 * (j + 1) + 1;
    sideTris.push([a, c, d], [a, d, b]);
  }
  m.face(side, sideTris);
  for (const z of [0, h]) {
    const verts = [[0, 0, z]];
    for (let j = 0; j < n; j++) verts.push(ring(z, j));
    const tris: number[][] = [];
    for (let j = 0; j < n; j++) tris.push([0, 1 + j, 1 + ((j + 1) % n)]);
    m.face(verts, tris);
  }
  return m;
}

describe('extractEdges', () => {
  it('finds the 12 edges of a cube and no diagonals', () => {
    const { edges, closed, circles } = cube().build();
    expect(edges.length / 6).toBe(12);
    expect(closed).toBe(true);
    expect(circles).toHaveLength(0);
    for (let s = 0; s < edges.length; s += 6) {
      const d = Math.hypot(edges[s] - edges[s + 3], edges[s + 1] - edges[s + 4], edges[s + 2] - edges[s + 5]);
      expect(d).toBeCloseTo(1, 6); // diagonals would be √2
    }
  });

  it('drops the seam of a periodic face and detects both circles', () => {
    const n = 24;
    const { edges, closed, circles } = cylinder(n, 5, 10).build();
    expect(edges.length / 6).toBe(2 * n);
    expect(closed).toBe(true);
    expect(circles).toHaveLength(2);
    for (const c of circles) {
      expect(c.full).toBe(true);
      expect(c.radius).toBeCloseTo(5, 4);
      expect(Math.abs(c.normal[2])).toBeCloseTo(1, 6);
      expect(Math.hypot(c.center[0], c.center[1])).toBeLessThan(1e-4);
    }
    expect(circles.map((c) => c.center[2]).sort((a, b) => a - b)).toEqual([expect.closeTo(0, 4), expect.closeTo(10, 4)]);
  });

  it('merges a hole split into two half-circle edges into one full circle', () => {
    // 16-gon ring; vertices 0 and 8 also carry a third edge (B-rep vertices), so the
    // loop is split into two semicircle chains, like SolidWorks hole edges
    const n = 16;
    const pts: number[] = [];
    for (let i = 0; i < n; i++) pts.push(3 * Math.cos((2 * Math.PI * i) / n), 3 * Math.sin((2 * Math.PI * i) / n), 1);
    pts.push(10, 0, 1, -10, 0, 1); // spoke ends: ids 16, 17
    const segA: number[] = [];
    const segB: number[] = [];
    for (let i = 0; i < n; i++) {
      segA.push(i);
      segB.push((i + 1) % n);
    }
    segA.push(0, 8);
    segB.push(16, 17);
    const circles = detectCircles(segA, segB, Float64Array.from(pts), n + 2);
    expect(circles).toHaveLength(1);
    expect(circles[0].full).toBe(true);
    expect(circles[0].radius).toBeCloseTo(3, 6);
  });

  it('marks an open surface as not closed', () => {
    const m = new MeshBuilder();
    m.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    const { edges, closed } = m.build();
    expect(edges.length / 6).toBe(4);
    expect(closed).toBe(false);
  });
});
