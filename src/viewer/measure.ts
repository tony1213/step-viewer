import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { faceMetrics, facePlane, parallelPlaneDistance, vertexDegrees } from '../core/geom';
import type { CircleEdge, Vec3 } from '../core/types';
import { cleanName, type MeshRecord, type Model } from './model';
import { pick, type PickHit } from './picking';
import type { Viewer } from './viewer';

type SnapKind = 'face' | 'edge' | 'circle';

interface Snap {
  kind: SnapKind;
  rec: MeshRecord;
  /** the measured point in mesh (model) coordinates */
  local: THREE.Vector3;
  /** B-rep face under the cursor */
  face: number;
  circle?: CircleEdge;
}

export interface FaceReport {
  kind: 'face';
  part: string;
  area: number;
  perimeter: number;
  normal: THREE.Vector3 | null;
  arcCorrected: boolean;
}

export interface CircleReport {
  kind: 'circle';
  part: string;
  diameter: number;
  center: THREE.Vector3;
  full: boolean;
}

export interface DistanceReport {
  id: number;
  distance: number;
  delta: THREE.Vector3;
  /** perpendicular distance when both points lie on parallel planar faces */
  planeDistance: number | null;
  from: string;
  to: string;
}

interface Item {
  report: DistanceReport;
  a: Snap;
  b: Snap;
  group: THREE.Group;
  line: THREE.Line;
  perp: THREE.Line;
  markers: THREE.Points;
  label: CSS2DObject;
}

interface FaceHighlight {
  rec: MeshRecord;
  face: number;
  mesh: THREE.Mesh;
}

const COLOR_LINE = 0xff6b00;
const COLOR_EDGE = 0xffa000;
const COLOR_PERP = 0x7c3aed;
const COLOR_CIRCLE = 0x0091ea;
const COLOR_FACE_HOVER = 0xffb020;
const COLOR_FACE_PICKED = 0x22c55e;

const fmt = (v: number, d = 2) => v.toFixed(d);

let dotTexture: THREE.Texture | null = null;
function getDotTexture(): THREE.Texture {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(32, 32, 21, 0, Math.PI * 2);
  ctx.fill();
  dotTexture = new THREE.CanvasTexture(c);
  dotTexture.colorSpace = THREE.SRGBColorSpace;
  return dotTexture;
}

function makePoints(color: number, size = 11): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: getDotTexture(), transparent: true, alphaTest: 0.2, depthTest: false });
  const p = new THREE.Points(g, m);
  p.renderOrder = 30;
  p.frustumCulled = false;
  return p;
}

function setPoints(p: THREE.Points, pts: THREE.Vector3[]): void {
  const arr = new Float32Array(pts.length * 3);
  pts.forEach((v, i) => v.toArray(arr, 3 * i));
  p.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  p.geometry.computeBoundingSphere();
}

function makeLine(color: number, dashed = false): THREE.Line {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const m = dashed
    ? new THREE.LineDashedMaterial({ color, depthTest: false, transparent: true, dashSize: 1, gapSize: 1 })
    : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  const line = new THREE.Line(g, m);
  line.renderOrder = 29;
  line.frustumCulled = false;
  return line;
}

function setLine(line: THREE.Line, a: THREE.Vector3, b: THREE.Vector3): void {
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  attr.setXYZ(0, a.x, a.y, a.z);
  attr.setXYZ(1, b.x, b.y, b.z);
  attr.needsUpdate = true;
  line.geometry.computeBoundingSphere();
  if (line.material instanceof THREE.LineDashedMaterial) {
    const dash = Math.max(a.distanceTo(b) / 40, 0.2);
    line.material.dashSize = dash;
    line.material.gapSize = dash * 0.7;
    line.computeLineDistances();
  }
}

function distanceToCircle(p: THREE.Vector3, c: CircleEdge): number {
  const vx = p.x - c.center[0], vy = p.y - c.center[1], vz = p.z - c.center[2];
  const h = vx * c.normal[0] + vy * c.normal[1] + vz * c.normal[2];
  const rx = vx - h * c.normal[0], ry = vy - h * c.normal[1], rz = vz - h * c.normal[2];
  const radial = Math.sqrt(rx * rx + ry * ry + rz * rz) - c.radius;
  return Math.sqrt(h * h + radial * radial);
}

/** Closest point on any B-rep edge segment of a mesh, within maxDist. */
function closestOnEdges(edges: Float32Array, p: THREE.Vector3, maxDist: number): THREE.Vector3 | null {
  let best = maxDist * maxDist;
  let bx = 0, by = 0, bz = 0;
  let found = false;
  for (let s = 0; s < edges.length; s += 6) {
    const ax = edges[s], ay = edges[s + 1], az = edges[s + 2];
    const dx = edges[s + 3] - ax, dy = edges[s + 4] - ay, dz = edges[s + 5] - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = len2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t;
    const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2;
    if (d2 < best) {
      best = d2;
      bx = cx; by = cy; bz = cz;
      found = true;
    }
  }
  return found ? new THREE.Vector3(bx, by, bz) : null;
}

export class MeasureTool {
  active = false;
  /** info about the last picked face or circle */
  info: FaceReport | CircleReport | null = null;
  readonly results: DistanceReport[] = [];
  onChange: () => void = () => {};

  private readonly root = new THREE.Group();
  private readonly items: Item[] = [];
  private pending: Snap | null = null;
  private readonly hoverMarker = makePoints(COLOR_LINE, 12);
  private readonly pendingMarker = makePoints(COLOR_LINE, 12);
  private readonly ring: THREE.LineLoop;
  private readonly hoverLabel: CSS2DObject;
  private hoverFace: FaceHighlight | null = null;
  private pickedFace: FaceHighlight | null = null;
  private readonly degrees = new WeakMap<MeshRecord, Map<string, number>>();
  private nextId = 1;

  constructor(
    private readonly viewer: Viewer,
    private readonly model: Model,
  ) {
    this.root.name = 'measure';
    viewer.overlay.add(this.root);
    const ringGeom = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * Math.PI * 2), Math.sin((i / 96) * Math.PI * 2), 0)),
    );
    this.ring = new THREE.LineLoop(ringGeom, new THREE.LineBasicMaterial({ color: COLOR_CIRCLE, depthTest: false, transparent: true }));
    this.ring.renderOrder = 29;
    this.ring.frustumCulled = false;
    const el = document.createElement('div');
    el.className = 'measure-label circle hover';
    this.hoverLabel = new CSS2DObject(el);
    this.hoverLabel.center.set(0.5, 1.6);
    this.root.add(this.hoverMarker, this.pendingMarker, this.ring, this.hoverLabel);
    this.hoverMarker.visible = this.pendingMarker.visible = this.ring.visible = this.hoverLabel.visible = false;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  setActive(on: boolean): void {
    this.active = on;
    if (!on) {
      this.clearHover();
      this.cancelPending();
    }
    this.viewer.requestRender();
  }

  hover(clientX: number, clientY: number, alt: boolean): void {
    const hit = pick(this.viewer, this.model, clientX, clientY);
    if (!hit) {
      this.clearHover();
      return;
    }
    const snap = this.snap(hit, alt);
    const world = snap.rec.mesh.localToWorld(snap.local.clone());
    setPoints(this.hoverMarker, [world]);
    (this.hoverMarker.material as THREE.PointsMaterial).color.setHex(
      snap.kind === 'circle' ? COLOR_CIRCLE : snap.kind === 'edge' ? COLOR_EDGE : COLOR_LINE,
    );
    this.hoverMarker.visible = true;
    if (snap.kind === 'circle' && snap.circle) {
      const c = snap.circle;
      this.ring.position.copy(world);
      this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...c.normal));
      this.ring.scale.setScalar(c.radius);
      this.ring.visible = true;
      this.hoverLabel.element.textContent = `${c.full ? 'Ø' : 'R'} ${fmt(c.full ? c.radius * 2 : c.radius)}`;
      this.hoverLabel.position.copy(world);
      this.hoverLabel.visible = true;
      this.setHoverFace(null);
    } else {
      this.ring.visible = false;
      this.hoverLabel.visible = false;
      this.setHoverFace(snap.face >= 0 ? { rec: snap.rec, face: snap.face } : null);
    }
    this.viewer.requestRender();
  }

  click(clientX: number, clientY: number, alt: boolean): void {
    const hit = pick(this.viewer, this.model, clientX, clientY);
    if (!hit) return;
    const snap = this.snap(hit, alt);
    this.info = this.describe(snap);
    this.setPickedFace(snap.kind !== 'circle' && snap.face >= 0 ? { rec: snap.rec, face: snap.face } : null);
    if (!this.pending) {
      this.pending = snap;
      setPoints(this.pendingMarker, [this.worldOf(snap)]);
      this.pendingMarker.visible = true;
    } else {
      const a = this.pending;
      if (this.worldOf(a).distanceTo(this.worldOf(snap)) > 1e-9) {
        this.pending = null;
        this.pendingMarker.visible = false;
        this.addMeasurement(a, snap);
      }
    }
    this.onChange();
    this.viewer.requestRender();
  }

  cancelPending(): void {
    this.pending = null;
    this.pendingMarker.visible = false;
    this.setPickedFace(null);
    this.info = null;
    this.onChange();
    this.viewer.requestRender();
  }

  remove(id: number): void {
    const i = this.items.findIndex((it) => it.report.id === id);
    if (i < 0) return;
    this.disposeItem(this.items[i]);
    this.items.splice(i, 1);
    this.results.splice(
      this.results.findIndex((r) => r.id === id),
      1,
    );
    this.onChange();
    this.viewer.requestRender();
  }

  clear(): void {
    for (const it of this.items) this.disposeItem(it);
    this.items.length = 0;
    this.results.length = 0;
    this.cancelPending();
  }

  /** Re-evaluate positions after parts moved (explode). */
  refresh(): void {
    this.model.group.updateMatrixWorld(true);
    for (const it of this.items) this.updateItem(it);
    if (this.pending) setPoints(this.pendingMarker, [this.worldOf(this.pending)]);
    this.clearHover();
    this.onChange();
    this.viewer.requestRender();
  }

  clearHover(): void {
    this.hoverMarker.visible = this.ring.visible = this.hoverLabel.visible = false;
    this.setHoverFace(null);
    this.viewer.requestRender();
  }

  dispose(): void {
    this.clear();
    this.clearHover();
    this.root.removeFromParent();
    this.root.traverse((o) => {
      if (o instanceof THREE.Points || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }

  // ---------------------------------------------------------------------------

  private worldOf(s: Snap): THREE.Vector3 {
    return s.rec.mesh.localToWorld(s.local.clone());
  }

  private degreesOf(rec: MeshRecord): Map<string, number> {
    let d = this.degrees.get(rec);
    if (!d) this.degrees.set(rec, (d = vertexDegrees(rec.data.edges)));
    return d;
  }

  private snap(hit: PickHit, alt: boolean): Snap {
    const base: Snap = { kind: 'face', rec: hit.rec, local: hit.local.clone(), face: hit.face };
    if (alt) return base;
    const px = this.viewer.worldPerPixel(hit.point);
    let best: CircleEdge | undefined;
    let bestD = 8 * px;
    for (const c of hit.rec.data.circles) {
      const d = distanceToCircle(hit.local, c);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) return { ...base, kind: 'circle', local: new THREE.Vector3(...best.center), circle: best };
    const onEdge = closestOnEdges(hit.rec.data.edges, hit.local, 6 * px);
    if (onEdge) return { ...base, kind: 'edge', local: onEdge };
    return base;
  }

  private partName(rec: MeshRecord): string {
    return rec.node.label || cleanName(rec.data.name);
  }

  private describe(s: Snap): FaceReport | CircleReport | null {
    if (s.kind === 'circle' && s.circle) {
      return { kind: 'circle', part: this.partName(s.rec), diameter: s.circle.radius * 2, center: this.worldOf(s), full: s.circle.full };
    }
    if (s.face < 0) return null;
    const d = s.rec.data;
    const first = d.faceRanges[2 * s.face];
    const last = d.faceRanges[2 * s.face + 1];
    const m = faceMetrics(d.position, d.index, first, last, this.degreesOf(s.rec));
    return {
      kind: 'face',
      part: this.partName(s.rec),
      area: m.area,
      perimeter: m.perimeter,
      normal: m.plane ? new THREE.Vector3(...m.plane.normal) : null,
      arcCorrected: m.arcCorrected,
    };
  }

  private planeOf(s: Snap): { normal: Vec3; point: Vec3 } | null {
    if (s.face < 0) return null;
    const d = s.rec.data;
    const plane = facePlane(d.position, d.index, d.faceRanges[2 * s.face], d.faceRanges[2 * s.face + 1]);
    if (!plane) return null;
    const p = s.rec.mesh.localToWorld(new THREE.Vector3(...plane.point));
    return { normal: plane.normal, point: [p.x, p.y, p.z] };
  }

  private addMeasurement(a: Snap, b: Snap): void {
    const group = new THREE.Group();
    const line = makeLine(COLOR_LINE);
    const perp = makeLine(COLOR_PERP, true);
    const markers = makePoints(COLOR_LINE, 10);
    const el = document.createElement('div');
    el.className = 'measure-label';
    const label = new CSS2DObject(el);
    group.add(line, perp, markers, label);
    this.root.add(group);
    const report: DistanceReport = {
      id: this.nextId++,
      distance: 0,
      delta: new THREE.Vector3(),
      planeDistance: null,
      from: this.partName(a.rec),
      to: this.partName(b.rec),
    };
    const item: Item = { report, a, b, group, line, perp, markers, label };
    this.items.push(item);
    this.results.push(report);
    this.updateItem(item);
  }

  private updateItem(it: Item): void {
    const pa = this.worldOf(it.a);
    const pb = this.worldOf(it.b);
    const r = it.report;
    r.delta.subVectors(pb, pa);
    r.distance = r.delta.length();
    r.planeDistance = null;
    const fa = it.a.face === it.b.face && it.a.rec === it.b.rec ? null : this.planeOf(it.a);
    const fb = fa ? this.planeOf(it.b) : null;
    if (fa && fb) {
      const d = parallelPlaneDistance(fa.normal, fa.point, fb.normal, fb.point);
      if (d !== null && d > 1e-6) r.planeDistance = d;
    }
    setLine(it.line, pa, pb);
    setPoints(it.markers, [pa, pb]);
    if (r.planeDistance !== null && fb) {
      const n = new THREE.Vector3(...fb.normal);
      const foot = pa.clone().addScaledVector(n, -pa.clone().sub(new THREE.Vector3(...fb.point)).dot(n));
      setLine(it.perp, pa, foot);
      it.perp.visible = foot.distanceTo(pb) > 1e-6 || pa.distanceTo(foot) > 1e-6;
    } else {
      it.perp.visible = false;
    }
    it.label.position.copy(pa).add(pb).multiplyScalar(0.5);
    it.label.element.innerHTML =
      `${fmt(r.distance)} mm` + (r.planeDistance !== null ? `<span class="perp">平行面 ⊥ ${fmt(r.planeDistance)} mm</span>` : '');
  }

  private disposeItem(it: Item): void {
    it.group.removeFromParent();
    for (const o of [it.line, it.perp, it.markers]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }

  private makeFaceMesh(rec: MeshRecord, face: number, color: number, opacity: number): THREE.Mesh {
    const d = rec.data;
    const first = d.faceRanges[2 * face];
    const last = d.faceRanges[2 * face + 1];
    const pos = new Float32Array((last - first + 1) * 9);
    let o = 0;
    for (let t = first; t <= last; t++) {
      for (let k = 0; k < 3; k++) {
        const v = d.index[3 * t + k];
        pos[o++] = d.position[3 * v];
        pos[o++] = d.position[3 * v + 1];
        pos[o++] = d.position[3 * v + 2];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      clippingPlanes: this.model.sectionPlane ? [this.model.sectionPlane] : null,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 5;
    mesh.matrixAutoUpdate = false;
    mesh.raycast = () => {};
    rec.mesh.add(mesh);
    return mesh;
  }

  private disposeFace(h: FaceHighlight | null): void {
    if (!h) return;
    h.mesh.removeFromParent();
    h.mesh.geometry.dispose();
    (h.mesh.material as THREE.Material).dispose();
  }

  private setHoverFace(target: { rec: MeshRecord; face: number } | null): void {
    const cur = this.hoverFace;
    if (cur && target && cur.rec === target.rec && cur.face === target.face) return;
    this.disposeFace(cur);
    this.hoverFace = null;
    if (target && !(this.pickedFace && this.pickedFace.rec === target.rec && this.pickedFace.face === target.face)) {
      this.hoverFace = { ...target, mesh: this.makeFaceMesh(target.rec, target.face, COLOR_FACE_HOVER, 0.35) };
    }
  }

  private setPickedFace(target: { rec: MeshRecord; face: number } | null): void {
    this.disposeFace(this.pickedFace);
    this.pickedFace = null;
    this.setHoverFace(null);
    if (target) this.pickedFace = { ...target, mesh: this.makeFaceMesh(target.rec, target.face, COLOR_FACE_PICKED, 0.45) };
  }
}
