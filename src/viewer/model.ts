import * as THREE from 'three';
import type { ImportResult, ImportStats, MeshData, SceneNode } from '../core/types';

export type DisplayMode = 'shaded-edges' | 'shaded' | 'edges';

export interface NodeInfo {
  id: number;
  /** raw name from the file */
  name: string;
  /** display name (without .STEP suffix, with <n> for repeated siblings) */
  label: string;
  parent: NodeInfo | null;
  children: NodeInfo[];
  depth: number;
  group: THREE.Group;
  /** meshes owned directly by this node */
  meshes: MeshRecord[];
  visible: boolean;
  transparent: boolean;
  /** index range of this node's subtree in Model.nodes / Model.records (DFS order) */
  nodeStart: number;
  nodeEnd: number;
  recStart: number;
  recEnd: number;
}

export interface MeshRecord {
  index: number;
  data: MeshData;
  node: NodeInfo;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  material: THREE.MeshStandardMaterial;
  edgeMaterial: THREE.LineBasicMaterial;
  baseColor: THREE.Color;
  partColor: THREE.Color;
  hasVertexColors: boolean;
  cap: THREE.Mesh | null;
}

const DEFAULT_COLOR: [number, number, number] = [0.79, 0.82, 0.86];
const SELECT_COLOR = 0x1f6feb;
const EDGE_COLOR = 0x262a30;
const EDGE_SELECTED = 0x0b4fd6;

export const recordOf = (obj: THREE.Object3D): MeshRecord => obj.userData.record as MeshRecord;

/** Display name: strip the CAD file extension SolidWorks appends to part names. */
export const cleanName = (name: string) => name.replace(/\.(step|stp|sldprt|sldasm|prt|asm|iges|igs)$/i, '').trim();

function partPalette(i: number): THREE.Color {
  const h = (i * 0.618033988749895 + 0.07) % 1;
  const s = 0.42 + (i % 3) * 0.1;
  const l = 0.58 + (i % 2) * 0.08;
  return new THREE.Color().setHSL(h, s, l, THREE.SRGBColorSpace);
}

export class Model {
  readonly group = new THREE.Group();
  readonly tree: NodeInfo;
  readonly nodes: NodeInfo[] = [];
  readonly records: MeshRecord[] = [];
  readonly stats: ImportStats;

  displayMode: DisplayMode = 'shaded-edges';
  colorByPart = false;
  xray = false;
  selected: NodeInfo | null = null;
  hovered: NodeInfo | null = null;
  sectionPlane: THREE.Plane | null = null;

  private readonly clipPlanes: THREE.Plane[] = [];
  private readonly partColors = new Map<string, THREE.Color>();

  constructor(
    result: ImportResult,
    readonly fileName: string,
  ) {
    this.stats = result.stats;
    this.group.name = fileName;
    this.tree = this.build(result.root, result, null, 0);
    this.group.add(this.tree.group);
    this.group.updateMatrixWorld(true);
    this.refreshMaterials();
  }

  private build(sn: SceneNode, result: ImportResult, parent: NodeInfo | null, depth: number): NodeInfo {
    const group = new THREE.Group();
    group.name = sn.name;
    const node: NodeInfo = {
      id: this.nodes.length,
      name: sn.name || this.fileName,
      label: cleanName(sn.name || this.fileName) || '(未命名)',
      parent,
      children: [],
      depth,
      group,
      meshes: [],
      visible: true,
      transparent: false,
      nodeStart: this.nodes.length,
      nodeEnd: 0,
      recStart: this.records.length,
      recEnd: 0,
    };
    group.userData.node = node;
    this.nodes.push(node);
    for (const mi of sn.meshes) {
      const rec = this.createMesh(result.meshes[mi], mi, node);
      node.meshes.push(rec);
      group.add(rec.mesh);
    }
    for (const c of sn.children) {
      const child = this.build(c, result, node, depth + 1);
      node.children.push(child);
      group.add(child.group);
    }
    node.nodeEnd = this.nodes.length;
    node.recEnd = this.records.length;
    // number repeated sibling names like SolidWorks does: name <1>, name <2>
    const counts = new Map<string, number>();
    for (const c of node.children) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const c of node.children) {
      if ((counts.get(c.label) ?? 0) < 2) continue;
      const k = (seen.get(c.label) ?? 0) + 1;
      seen.set(c.label, k);
      c.label = `${c.label} <${k}>`;
    }
    return node;
  }

  private createMesh(data: MeshData, index: number, node: NodeInfo): MeshRecord {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geom.setIndex(new THREE.BufferAttribute(data.index, 1));
    if (data.normal && data.normal.length === data.position.length) geom.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    else geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();

    const rgb = data.color ?? DEFAULT_COLOR;
    const baseColor = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    let hasVertexColors = false;
    if (data.faceColors) {
      const colors = new Float32Array(data.position.length);
      const c = new THREE.Color();
      for (let f = 0; f < data.faceRanges.length / 2; f++) {
        const fc = data.faceColors.subarray(3 * f, 3 * f + 3);
        if (Number.isNaN(fc[0])) c.copy(baseColor);
        else c.setRGB(fc[0], fc[1], fc[2], THREE.SRGBColorSpace);
        for (let t = data.faceRanges[2 * f]; t <= data.faceRanges[2 * f + 1]; t++) {
          for (let k = 0; k < 3; k++) {
            const v = data.index[3 * t + k];
            colors[3 * v] = c.r;
            colors[3 * v + 1] = c.g;
            colors[3 * v + 2] = c.b;
          }
        }
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      hasVertexColors = true;
    }

    const material = new THREE.MeshStandardMaterial({
      color: baseColor,
      metalness: 0.12,
      roughness: 0.58,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = data.name || node.name;
    mesh.matrixAutoUpdate = false;

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.BufferAttribute(data.edges, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
    const edges = new THREE.LineSegments(edgeGeom, edgeMaterial);
    edges.matrixAutoUpdate = false;
    edges.raycast = () => {};
    mesh.add(edges);

    const key = cleanName(node.name);
    let partColor = this.partColors.get(key);
    if (!partColor) {
      partColor = partPalette(this.partColors.size);
      this.partColors.set(key, partColor);
    }

    const rec: MeshRecord = { index, data, node, mesh, edges, material, edgeMaterial, baseColor, partColor, hasVertexColors, cap: null };
    mesh.userData.record = rec;
    this.records.push(rec);
    return rec;
  }

  // ---------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------

  /** node and all its ancestors are visible */
  isShown(node: NodeInfo): boolean {
    for (let n: NodeInfo | null = node; n; n = n.parent) if (!n.visible) return false;
    return true;
  }

  isTransparent(node: NodeInfo): boolean {
    for (let n: NodeInfo | null = node; n; n = n.parent) if (n.transparent) return true;
    return false;
  }

  isUnder(node: NodeInfo, ancestor: NodeInfo | null): boolean {
    if (!ancestor) return false;
    return node.nodeStart >= ancestor.nodeStart && node.nodeStart < ancestor.nodeEnd;
  }

  subtreeRecords(node: NodeInfo): MeshRecord[] {
    return this.records.slice(node.recStart, node.recEnd);
  }

  pickableMeshes(): THREE.Mesh[] {
    return this.records.filter((r) => this.isShown(r.node)).map((r) => r.mesh);
  }

  /** Axis-aligned box of a subtree in world space (includes explode offsets). */
  boxOf(node: NodeInfo = this.tree, visibleOnly = true): THREE.Box3 {
    this.group.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (let i = node.recStart; i < node.recEnd; i++) {
      const r = this.records[i];
      if (visibleOnly && !this.isShown(r.node)) continue;
      tmp.copy(r.mesh.geometry.boundingBox!).applyMatrix4(r.mesh.matrixWorld);
      box.union(tmp);
    }
    return box;
  }

  triangleCount(node: NodeInfo = this.tree): number {
    let n = 0;
    for (let i = node.recStart; i < node.recEnd; i++) n += this.records[i].data.index.length / 3;
    return n;
  }

  /** number of nodes that own geometry (parts) in a subtree */
  partCount(node: NodeInfo = this.tree): number {
    let n = 0;
    for (let i = node.nodeStart; i < node.nodeEnd; i++) if (this.nodes[i].meshes.length) n++;
    return n;
  }

  pathOf(node: NodeInfo): NodeInfo[] {
    const path: NodeInfo[] = [];
    for (let n: NodeInfo | null = node; n; n = n.parent) path.unshift(n);
    return path;
  }

  // ---------------------------------------------------------------------------
  // state changes
  // ---------------------------------------------------------------------------

  setVisible(node: NodeInfo, visible: boolean): void {
    node.visible = visible;
    node.group.visible = visible;
  }

  showAll(): void {
    for (const n of this.nodes) this.setVisible(n, true);
  }

  /** Show only `node` (and the assemblies containing it). */
  isolate(node: NodeInfo): void {
    for (const n of this.nodes) this.setVisible(n, false);
    for (let n: NodeInfo | null = node; n; n = n.parent) this.setVisible(n, true);
    for (let i = node.nodeStart; i < node.nodeEnd; i++) this.setVisible(this.nodes[i], true);
  }

  setTransparent(node: NodeInfo, transparent: boolean): void {
    node.transparent = transparent;
    // children inherit; clear their own flags so toggling the parent back is predictable
    if (!transparent) for (let i = node.nodeStart; i < node.nodeEnd; i++) this.nodes[i].transparent = false;
    this.refreshMaterials(this.subtreeRecords(node));
  }

  setSelected(node: NodeInfo | null): void {
    const prev = this.selected;
    this.selected = node;
    const changed = new Set<MeshRecord>();
    if (prev) this.subtreeRecords(prev).forEach((r) => changed.add(r));
    if (node) this.subtreeRecords(node).forEach((r) => changed.add(r));
    this.refreshMaterials(changed);
  }

  setHovered(node: NodeInfo | null): boolean {
    if (node === this.hovered) return false;
    const prev = this.hovered;
    this.hovered = node;
    const changed = new Set<MeshRecord>();
    if (prev) this.subtreeRecords(prev).forEach((r) => changed.add(r));
    if (node) this.subtreeRecords(node).forEach((r) => changed.add(r));
    this.refreshMaterials(changed);
    return true;
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.refreshMaterials();
  }

  setColorByPart(on: boolean): void {
    this.colorByPart = on;
    this.refreshMaterials();
  }

  setXray(on: boolean): void {
    this.xray = on;
    this.refreshMaterials();
  }

  /** Clip the model with `plane` (null = off). Closed solids get a flat-coloured cap. */
  setSectionPlane(plane: THREE.Plane | null): void {
    this.sectionPlane = plane;
    this.clipPlanes.length = 0;
    if (plane) this.clipPlanes.push(plane);
    for (const rec of this.records) {
      if (plane && rec.data.closed && !rec.cap) {
        const capMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, clippingPlanes: this.clipPlanes });
        const cap = new THREE.Mesh(rec.mesh.geometry, capMat);
        cap.matrixAutoUpdate = false;
        cap.raycast = () => {};
        rec.mesh.add(cap);
        rec.cap = cap;
      } else if (!plane && rec.cap) {
        rec.cap.removeFromParent();
        (rec.cap.material as THREE.Material).dispose();
        rec.cap = null;
      }
    }
    this.refreshMaterials();
  }

  refreshMaterials(records: Iterable<MeshRecord> = this.records): void {
    const clip = this.sectionPlane ? this.clipPlanes : null;
    for (const rec of records) {
      const m = rec.material;
      const transparent = this.xray || this.isTransparent(rec.node);
      const selected = this.isUnder(rec.node, this.selected);
      const hovered = !selected && this.isUnder(rec.node, this.hovered);
      const useVertexColors = rec.hasVertexColors && !this.colorByPart;
      const side = this.sectionPlane && rec.data.closed ? THREE.FrontSide : THREE.DoubleSide;
      if (m.transparent !== transparent || m.side !== side || m.vertexColors !== useVertexColors) {
        m.transparent = transparent;
        m.side = side;
        m.vertexColors = useVertexColors;
        m.needsUpdate = true;
      }
      if (useVertexColors) m.color.setRGB(1, 1, 1);
      else m.color.copy(this.colorByPart ? rec.partColor : rec.baseColor);
      m.opacity = transparent ? (this.xray ? 0.3 : 0.2) : 1;
      m.depthWrite = !transparent;
      m.emissive.setHex(selected || hovered ? SELECT_COLOR : 0x000000);
      m.emissiveIntensity = selected ? 0.5 : hovered ? 0.2 : 0;
      m.visible = this.displayMode !== 'edges';
      m.clippingPlanes = clip;

      const e = rec.edgeMaterial;
      if (e.transparent !== transparent) {
        e.transparent = transparent;
        e.needsUpdate = true;
      }
      e.color.setHex(selected ? EDGE_SELECTED : EDGE_COLOR);
      e.opacity = transparent ? 0.22 : 1;
      e.depthWrite = !transparent;
      e.visible = this.displayMode !== 'shaded';
      e.clippingPlanes = clip;

      if (rec.cap) {
        const cm = rec.cap.material as THREE.MeshBasicMaterial;
        cm.color.copy(this.colorByPart ? rec.partColor : rec.baseColor).multiplyScalar(0.62);
        if (selected) cm.color.lerp(new THREE.Color(SELECT_COLOR), 0.35);
        rec.cap.visible = !transparent && this.displayMode !== 'edges';
      }
    }
  }

  dispose(): void {
    for (const rec of this.records) {
      rec.mesh.geometry.disposeBoundsTree?.();
      rec.mesh.geometry.dispose();
      rec.material.dispose();
      rec.edges.geometry.dispose();
      rec.edgeMaterial.dispose();
      if (rec.cap) (rec.cap.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}
