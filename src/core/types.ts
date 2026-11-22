export type Vec3 = [number, number, number];
export type RGB = [number, number, number];

export type ModelFormat = 'step' | 'iges' | 'brep';

/** A circular (or arc) B-rep edge detected from the edge polylines, in mesh coordinates (mm). */
export interface CircleEdge {
  center: Vec3;
  normal: Vec3;
  radius: number;
  /** true for a closed loop (full circle), false for an arc */
  full: boolean;
}

/** One triangulated solid / shell, ready to hand to three.js. Coordinates are model space, mm. */
export interface MeshData {
  name: string;
  color: RGB | null;
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array;
  /** [firstTriangle, lastTriangle] pairs (inclusive), one pair per B-rep face */
  faceRanges: Uint32Array;
  /** rgb per B-rep face (NaN = face has no own colour); null when no face has a colour */
  faceColors: Float32Array | null;
  /** B-rep face boundary edges as independent segments [x0,y0,z0, x1,y1,z1, ...] */
  edges: Float32Array;
  circles: CircleEdge[];
  /** watertight: every B-rep edge is shared by exactly two faces */
  closed: boolean;
}

/** Assembly tree node. `meshes` are indices into ImportResult.meshes owned directly by this node. */
export interface SceneNode {
  name: string;
  meshes: number[];
  children: SceneNode[];
}

export interface ImportStats {
  format: ModelFormat;
  /** time spent inside OpenCascade (read + triangulate) */
  parseMs: number;
  /** time spent converting meshes, extracting edges and building the tree */
  postMs: number;
  triangles: number;
  meshCount: number;
  /** 'step' = full assembly tree rebuilt from the STEP product structure; 'flat' = OpenCascade's simplified tree */
  hierarchy: 'step' | 'partial' | 'flat';
  /** set when a large STEP file was read part by part (see core/step-split.ts) */
  split?: {
    parts: number;
    instances: number;
    /** names of parts OpenCascade could not mesh */
    failed: string[];
    /** occurrences whose placement could not be read (shown at their parent's origin) */
    unplaced: number;
  };
}

export interface ImportResult {
  root: SceneNode;
  meshes: MeshData[];
  stats: ImportStats;
}

// ---- raw occt-import-js output ----

export interface OcctFace {
  first: number;
  last: number;
  color: RGB | null;
}

export interface OcctMesh {
  name: string;
  color?: RGB;
  brep_faces: OcctFace[];
  attributes: {
    position: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index: { array: ArrayLike<number> };
}

export interface OcctNode {
  name: string;
  meshes: number[];
  children: OcctNode[];
}

export interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}
