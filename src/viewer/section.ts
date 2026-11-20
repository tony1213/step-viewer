import * as THREE from 'three';
import type { Model } from './model';
import type { Viewer } from './viewer';

export type Axis = 'x' | 'y' | 'z';
const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/** One axis-aligned clipping plane; closed solids show a filled cap (see Model.setSectionPlane). */
export class SectionTool {
  enabled = false;
  axis: Axis = 'x';
  flipped = false;
  showPlane = true;
  value = 0;
  min = 0;
  max = 1;
  readonly plane = new THREE.Plane();

  private readonly outline: THREE.LineLoop;
  private readonly fill: THREE.Mesh;

  constructor(
    private readonly viewer: Viewer,
    private readonly model: Model,
  ) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.outline = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x2f6fec, transparent: true, opacity: 0.85, depthTest: false }));
    this.outline.renderOrder = 20;
    this.outline.frustumCulled = false;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', g.getAttribute('position'));
    fg.setIndex([0, 1, 2, 0, 2, 3]);
    this.fill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: 0x2f6fec, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide }));
    this.fill.frustumCulled = false;
    this.fill.raycast = () => {};
    this.outline.visible = this.fill.visible = false;
    viewer.overlay.add(this.outline, this.fill);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.updateRange();
      this.value = (this.min + this.max) / 2;
      this.updatePlane();
      this.model.setSectionPlane(this.plane);
    } else {
      this.model.setSectionPlane(null);
    }
    this.updateOutline();
    this.viewer.requestRender();
  }

  setAxis(axis: Axis): void {
    this.axis = axis;
    this.updateRange();
    this.value = (this.min + this.max) / 2;
    this.update();
  }

  setValue(v: number): void {
    this.value = THREE.MathUtils.clamp(v, this.min, this.max);
    this.update();
  }

  setFlipped(f: boolean): void {
    this.flipped = f;
    this.update();
  }

  setShowPlane(show: boolean): void {
    this.showPlane = show;
    this.updateOutline();
    this.viewer.requestRender();
  }

  dispose(): void {
    if (this.enabled) this.model.setSectionPlane(null);
    for (const o of [this.outline, this.fill]) {
      o.removeFromParent();
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }

  private update(): void {
    this.updatePlane();
    this.updateOutline();
    this.viewer.requestRender();
  }

  private updateRange(): void {
    const box = this.model.boxOf(this.model.tree, false);
    const i = AXIS_INDEX[this.axis];
    const lo = box.min.getComponent(i);
    const hi = box.max.getComponent(i);
    const pad = (hi - lo) * 0.01 + 1e-3;
    this.min = lo - pad;
    this.max = hi + pad;
  }

  /** keep the side with axis ≤ value (or ≥ value when flipped) */
  private updatePlane(): void {
    const n = new THREE.Vector3().setComponent(AXIS_INDEX[this.axis], 1);
    if (this.flipped) this.plane.set(n, -this.value);
    else this.plane.set(n.negate(), this.value);
  }

  private updateOutline(): void {
    const visible = this.enabled && this.showPlane;
    this.outline.visible = this.fill.visible = visible;
    if (!visible) return;
    const box = this.model.boxOf(this.model.tree, false);
    const i = AXIS_INDEX[this.axis];
    const [j, k] = [0, 1, 2].filter((x) => x !== i);
    const size = box.getSize(new THREE.Vector3());
    const mj = size.getComponent(j) * 0.04;
    const mk = size.getComponent(k) * 0.04;
    const corners = [
      [box.min.getComponent(j) - mj, box.min.getComponent(k) - mk],
      [box.max.getComponent(j) + mj, box.min.getComponent(k) - mk],
      [box.max.getComponent(j) + mj, box.max.getComponent(k) + mk],
      [box.min.getComponent(j) - mj, box.max.getComponent(k) + mk],
    ];
    const attr = this.outline.geometry.getAttribute('position') as THREE.BufferAttribute;
    corners.forEach(([a, b], idx) => {
      const v = new THREE.Vector3();
      v.setComponent(i, this.value);
      v.setComponent(j, a);
      v.setComponent(k, b);
      attr.setXYZ(idx, v.x, v.y, v.z);
    });
    attr.needsUpdate = true;
  }
}
