import { extractEdges } from './edges';
export { MESH_PARAMS } from './mesh-params';
import { buildSceneTree, type StepStructure } from './step-structure';
import type { ImportResult, MeshData, ModelFormat, OcctMesh, OcctResult } from './types';

/** occt-import-js mesh → typed arrays + B-rep edges + detected circles. */
export function convertMesh(m: OcctMesh): MeshData {
  const position = Float32Array.from(m.attributes.position.array);
  const normal = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null;
  const index = Uint32Array.from(m.index.array);
  // Faces OpenCascade could not triangulate come back as first..first-1 (last = -1 for a mesh without
  // any triangles, which would wrap to 2^32-1 in a Uint32Array). Keep only faces that own triangles.
  const triangleCount = index.length / 3;
  const faces = m.brep_faces.filter((f) => f.first >= 0 && f.last >= f.first && f.last < triangleCount);
  const faceRanges = new Uint32Array(faces.length * 2);
  let hasFaceColor = false;
  faces.forEach((f, i) => {
    faceRanges[2 * i] = f.first;
    faceRanges[2 * i + 1] = f.last;
    if (f.color) hasFaceColor = true;
  });
  let faceColors: Float32Array | null = null;
  if (hasFaceColor) {
    faceColors = new Float32Array(faces.length * 3).fill(Number.NaN);
    faces.forEach((f, i) => {
      if (f.color) faceColors!.set(f.color, 3 * i);
    });
  }
  const { edges, circles, closed } = extractEdges(position, index, faceRanges);
  return {
    name: m.name ?? '',
    color: m.color ? [m.color[0], m.color[1], m.color[2]] : null,
    position,
    normal,
    index,
    faceRanges,
    faceColors,
    edges,
    circles,
    closed,
  };
}

export interface PipelineOutput {
  result: ImportResult;
  /** buffers that can be transferred to the main thread without copying */
  transfer: ArrayBuffer[];
}

export function processOcctResult(
  res: OcctResult,
  opts: { format: ModelFormat; structure: StepStructure | null; parseMs: number },
): PipelineOutput {
  const t0 = performance.now();
  const meshes = res.meshes.map(convertMesh);
  const { root, hierarchy } = buildSceneTree(
    res.root,
    res.meshes.map((m) => m.name ?? ''),
    opts.structure,
  );
  let triangles = 0;
  const transfer: ArrayBuffer[] = [];
  for (const m of meshes) {
    triangles += m.index.length / 3;
    for (const arr of [m.position, m.normal, m.index, m.faceRanges, m.faceColors, m.edges]) {
      if (arr) transfer.push(arr.buffer as ArrayBuffer);
    }
  }
  return {
    result: {
      root,
      meshes,
      stats: {
        format: opts.format,
        parseMs: opts.parseMs,
        postMs: performance.now() - t0,
        triangles,
        meshCount: meshes.length,
        hierarchy,
      },
    },
    transfer,
  };
}
