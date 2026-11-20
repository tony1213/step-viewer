import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { findFace } from '../core/geom';
import { recordOf, type MeshRecord, type Model } from './model';
import type { Viewer } from './viewer';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface PickHit {
  rec: MeshRecord;
  /** world-space hit point */
  point: THREE.Vector3;
  /** hit point in the mesh's own (model) coordinates */
  local: THREE.Vector3;
  triangle: number;
  /** B-rep face index inside rec.data */
  face: number;
}

/** Build BVHs for fast picking during idle time, a few meshes per slice. Returns a cancel function. */
export function buildBVHInBackground(model: Model): () => void {
  let i = 0;
  let cancelled = false;
  const schedule = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(step, { timeout: 300 });
    else setTimeout(step, 16);
  };
  const step = () => {
    const start = performance.now();
    while (!cancelled && i < model.records.length && performance.now() - start < 12) {
      const g = model.records[i++].mesh.geometry;
      // indirect: keep the index buffer untouched – triangle order must keep matching faceRanges
      if (!g.boundsTree) g.computeBoundsTree({ indirect: true });
    }
    if (!cancelled && i < model.records.length) schedule();
  };
  schedule();
  return () => {
    cancelled = true;
  };
}

/**
 * Pick the part under the cursor: ignores hidden parts and the clipped-away side of a section;
 * looks through transparent parts when something opaque is behind them.
 */
export function pick(viewer: Viewer, model: Model, clientX: number, clientY: number): PickHit | null {
  const raycaster = viewer.raycasterAt(clientX, clientY);
  const plane = model.sectionPlane;
  raycaster.firstHitOnly = !plane;
  const hits = raycaster.intersectObjects(model.pickableMeshes(), false);
  let chosen: THREE.Intersection | undefined;
  let fallback: THREE.Intersection | undefined;
  for (const h of hits) {
    if (plane && plane.distanceToPoint(h.point) < -1e-6) continue;
    const rec = recordOf(h.object);
    if (model.xray || model.isTransparent(rec.node)) {
      fallback ??= h;
      continue;
    }
    chosen = h;
    break;
  }
  chosen ??= fallback;
  if (!chosen || chosen.faceIndex == null) return null;
  const rec = recordOf(chosen.object);
  return {
    rec,
    point: chosen.point.clone(),
    local: rec.mesh.worldToLocal(chosen.point.clone()),
    triangle: chosen.faceIndex,
    face: findFace(rec.data.faceRanges, chosen.faceIndex),
  };
}
