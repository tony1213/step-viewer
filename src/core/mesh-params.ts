/** Triangulation parameters passed to OpenCascade (BRepMesh). */
export const MESH_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
} as const;

/**
 * BRepMesh never lets a curve segment turn more than `angularDeflection`, so a polyline whose
 * vertices lie on a circle but with bigger steps (rectangle, octagon, ...) is a polygon, not a circle.
 */
export const MAX_ARC_STEP = MESH_PARAMS.angularDeflection + 0.02;
