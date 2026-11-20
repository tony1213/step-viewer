import { describe, expect, it } from 'vitest';
import { faceArea, faceBoundary, faceMetrics, facePlane, findFace, fitCircle, parallelPlaneDistance } from '../src/core/geom';

describe('faceMetrics (arc-corrected)', () => {
  const ring = (r: number, n: number, z = 0) => Array.from({ length: n }, (_, j) => [r * Math.cos((2 * Math.PI * j) / n), r * Math.sin((2 * Math.PI * j) / n), z]);

  it('gives the exact area and circumference of a disk', () => {
    const n = 14;
    const pos = [0, 0, 0, ...ring(4, n).flat()];
    const idx: number[] = [];
    for (let j = 0; j < n; j++) idx.push(0, 1 + j, 1 + ((j + 1) % n));
    const raw = faceArea(pos, idx, 0, n - 1);
    expect(raw).toBeLessThan(Math.PI * 16 - 0.5); // inscribed 14-gon is ~3.3% smaller
    const m = faceMetrics(pos, idx, 0, n - 1);
    expect(m.arcCorrected).toBe(true);
    expect(m.area).toBeCloseTo(Math.PI * 16, 6);
    expect(m.perimeter).toBeCloseTo(2 * Math.PI * 4, 6);
  });

  it('subtracts the true hole area of an annulus', () => {
    const n = 16;
    const pos = [...ring(2, n).flat(), ...ring(5, n).flat()]; // inner 0..n-1, outer n..2n-1
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      const i0 = j, i1 = (j + 1) % n, o0 = n + j, o1 = n + ((j + 1) % n);
      idx.push(i0, o0, o1, i0, o1, i1);
    }
    const m = faceMetrics(pos, idx, 0, 2 * n - 1);
    expect(m.area).toBeCloseTo(Math.PI * (25 - 4), 6);
    expect(m.perimeter).toBeCloseTo(2 * Math.PI * (2 + 5), 6);
    expect(m.plane).not.toBeNull();
  });

  it('leaves straight boundaries untouched', () => {
    const m = faceMetrics([0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0], [0, 1, 2, 0, 2, 3], 0, 1);
    expect(m.arcCorrected).toBe(false);
    expect(m.area).toBeCloseTo(6, 10);
    expect(m.perimeter).toBeCloseTo(10, 10);
  });
});

const square = {
  pos: [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0],
  idx: [0, 1, 2, 0, 2, 3],
};

describe('face measurements', () => {
  it('computes area, perimeter and plane of a rectangle', () => {
    expect(faceArea(square.pos, square.idx, 0, 1)).toBeCloseTo(6, 10);
    expect(faceBoundary(square.pos, square.idx, 0, 1).length).toBeCloseTo(10, 10);
    const plane = facePlane(square.pos, square.idx, 0, 1)!;
    expect(Math.abs(plane.normal[2])).toBeCloseTo(1, 10);
  });

  it('rejects curved faces as planes', () => {
    // two triangles folded by 90°
    const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1];
    const idx = [0, 1, 2, 1, 3, 2];
    expect(facePlane(pos, idx, 0, 1)).toBeNull();
  });

  it('measures distance between parallel planes only', () => {
    expect(parallelPlaneDistance([0, 0, 1], [0, 0, 0], [0, 0, -1], [3, 4, 5])).toBeCloseTo(5, 10);
    expect(parallelPlaneDistance([0, 0, 1], [0, 0, 0], [0, 1, 0], [3, 4, 5])).toBeNull();
  });

  it('finds the face of a triangle', () => {
    const ranges = new Uint32Array([0, 1, 2, 5, 6, 6]);
    expect([0, 1, 2, 5, 6, 7].map((t) => findFace(ranges, t))).toEqual([0, 0, 1, 1, 2, -1]);
  });
});

describe('fitCircle', () => {
  const circlePoints = (n: number, r: number, from = 0, to = 2 * Math.PI) => {
    // circle in a tilted plane around (1, 2, 3)
    const u = [1 / Math.SQRT2, 1 / Math.SQRT2, 0];
    const v = [0, 0, 1];
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = from + ((to - from) * i) / (to - from === 2 * Math.PI ? n : n - 1);
      for (let k = 0; k < 3; k++) pts.push([1, 2, 3][k] + r * (Math.cos(a) * u[k] + Math.sin(a) * v[k]));
    }
    return pts;
  };

  it('recovers centre and radius of a full circle', () => {
    const fit = fitCircle(circlePoints(16, 7.5), true)!;
    expect(fit.radius).toBeCloseTo(7.5, 6);
    expect(fit.center[0]).toBeCloseTo(1, 6);
    expect(fit.center[1]).toBeCloseTo(2, 6);
    expect(fit.center[2]).toBeCloseTo(3, 6);
  });

  it('measures the span of an arc', () => {
    const fit = fitCircle(circlePoints(6, 3, 0, Math.PI / 2), false)!;
    expect(fit.radius).toBeCloseTo(3, 6);
    expect(fit.span).toBeCloseTo(Math.PI / 2, 6);
  });

  it('rejects straight lines and non-circles', () => {
    expect(fitCircle([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], false)).toBeNull();
    // a square is not a circle (corners are √2 farther than mid-points would be)
    expect(fitCircle([0, 0, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 2, 2, 0, 1, 2, 0, 0, 2, 0, 0, 1, 0], true)).toBeNull();
    // its 4 corners do lie on a circle, but 90° steps are far coarser than BRepMesh ever produces
    expect(fitCircle([0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0], true)).toBeNull();
    // same for a regular octagon (45° steps)
    expect(fitCircle(circlePoints(8, 5), true)).toBeNull();
  });
});
