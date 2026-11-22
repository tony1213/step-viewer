import { describe, expect, it } from 'vitest';
import { convertMesh } from '../src/core/pipeline';
import type { OcctMesh } from '../src/core/types';

// unit square in the XY plane, two triangles
const square = {
  position: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  index: [0, 1, 2, 0, 2, 3],
};

const mesh = (position: number[], index: number[], faces: { first: number; last: number }[]): OcctMesh => ({
  name: 'part',
  attributes: { position: { array: position } },
  index: { array: index },
  brep_faces: faces.map((f) => ({ ...f, color: null })),
});

describe('convertMesh', () => {
  it('drops B-rep faces that OpenCascade did not triangulate', () => {
    const m = convertMesh(mesh(square.position, square.index, [{ first: 0, last: -1 }, { first: 0, last: 1 }]));
    expect([...m.faceRanges]).toEqual([0, 1]);
    expect(m.edges.length / 6).toBe(4);
  });

  it('handles a mesh without any triangles (meshing failed) without looping over wrapped ranges', () => {
    const faces = Array.from({ length: 50 }, () => ({ first: 0, last: -1 }));
    const t0 = performance.now();
    const m = convertMesh(mesh([], [], faces));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(m.faceRanges.length).toBe(0);
    expect(m.edges.length).toBe(0);
    expect(m.circles).toEqual([]);
  });
});
