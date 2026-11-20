import * as THREE from 'three';
import type { Model, NodeInfo } from './model';

export type ExplodeLevel = 'top' | 'parts';

interface Unit {
  node: NodeInfo;
  dir: THREE.Vector3;
}

/** Moves components away from the model centre, proportionally to their offset from it. */
export class ExplodeTool {
  factor = 0;
  level: ExplodeLevel = 'top';
  private readonly units: Record<ExplodeLevel, Unit[]>;

  /** must be created while the model is at rest (no offsets applied) */
  constructor(private readonly model: Model) {
    const center = model.boxOf(model.tree, false).getCenter(new THREE.Vector3());
    let top = model.tree;
    while (top.children.length === 1 && top.meshes.length === 0) top = top.children[0];
    const unit = (node: NodeInfo): Unit => ({ node, dir: model.boxOf(node, false).getCenter(new THREE.Vector3()).sub(center) });
    this.units = {
      top: top.children.map(unit),
      parts: model.nodes.filter((n) => n.meshes.length > 0).map(unit),
    };
  }

  get available(): boolean {
    return this.units.top.length > 1 || this.units.parts.length > 1;
  }

  set(factor: number, level: ExplodeLevel = this.level): void {
    for (const list of Object.values(this.units)) for (const u of list) u.node.group.position.set(0, 0, 0);
    this.factor = factor;
    this.level = level;
    const k = factor * 1.6;
    if (k > 0) for (const u of this.units[level]) u.node.group.position.copy(u.dir).multiplyScalar(k);
    this.model.group.updateMatrixWorld(true);
  }
}
