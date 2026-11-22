/**
 * Large STEP assemblies, part by part.
 *
 * occt-import-js runs OpenCascade in a WebAssembly heap of at most 2 GB. Reading a big assembly
 * (roughly 30 MB of STEP per GB of heap) fills that heap before meshing even starts, and the meshes
 * silently come back empty. Instead, every part that has geometry is cut out of the file into a small
 * self-contained STEP file, OpenCascade meshes the parts one after another, and the meshes are placed
 * with the assembly transformations read here (NAUO → CDSR → item-defined transformation).
 * Parts used many times (screws, …) are meshed once.
 */
import { MESH_PARAMS } from './mesh-params';
import { convertMesh, type PipelineOutput } from './pipeline';
import {
  displayName,
  entityArgs,
  entityParts,
  entityRefs,
  list,
  prune,
  ref,
  typeName,
  type StepIndex,
  type StepProductDef,
  type StepStructure,
  type StepValue,
} from './step-structure';
import type { MeshData, OcctResult, SceneNode, Vec3 } from './types';

// ---------------------------------------------------------------------------
// 3×4 affine matrices (row-major): x' = m0·x + m1·y + m2·z + m3, y' = m4·x + …, z' = m8·x + …
// ---------------------------------------------------------------------------

export type Mat = Float64Array;

export const identity = (): Mat => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

export function multiply(a: Mat, b: Mat): Mat {
  const m = new Float64Array(12);
  for (let r = 0; r < 12; r += 4) {
    const a0 = a[r];
    const a1 = a[r + 1];
    const a2 = a[r + 2];
    m[r] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    m[r + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    m[r + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    m[r + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a[r + 3];
  }
  return m;
}

export function invert(a: Mat): Mat {
  const c00 = a[5] * a[10] - a[6] * a[9];
  const c01 = a[2] * a[9] - a[1] * a[10];
  const c02 = a[1] * a[6] - a[2] * a[5];
  const c10 = a[6] * a[8] - a[4] * a[10];
  const c11 = a[0] * a[10] - a[2] * a[8];
  const c12 = a[2] * a[4] - a[0] * a[6];
  const c20 = a[4] * a[9] - a[5] * a[8];
  const c21 = a[1] * a[8] - a[0] * a[9];
  const c22 = a[0] * a[5] - a[1] * a[4];
  const s = 1 / (a[0] * c00 + a[1] * c10 + a[2] * c20);
  const m = Float64Array.of(c00 * s, c01 * s, c02 * s, 0, c10 * s, c11 * s, c12 * s, 0, c20 * s, c21 * s, c22 * s, 0);
  m[3] = -(m[0] * a[3] + m[1] * a[7] + m[2] * a[11]);
  m[7] = -(m[4] * a[3] + m[5] * a[7] + m[6] * a[11]);
  m[11] = -(m[8] * a[3] + m[9] * a[7] + m[10] * a[11]);
  return m;
}

export const transformPoint = (m: Mat, p: ArrayLike<number>): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

function isIdentity(m: Mat): boolean {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  for (let i = 0; i < 12; i++) if (Math.abs(m[i] - id[i]) > 1e-12) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Units, placements, occurrence transformations
// ---------------------------------------------------------------------------

const SI_PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

const enumOf = (v: StepValue | undefined): string | null => (v && typeof v === 'object' && 'e' in v ? v.e : null);

function numberOf(v: StepValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 't' in v) return numberOf(Array.isArray(v.v) ? v.v[0] : v.v); // LENGTH_MEASURE(25.4)
  return null;
}

/** name, items, context of a (possibly complex) representation instance */
function representationArgs(ix: StepIndex, k: number): StepValue[] | null {
  if (typeName(ix, k)) return entityArgs(ix, k);
  const parts = entityParts(ix, k);
  return parts.get('REPRESENTATION') ?? parts.get('SHAPE_REPRESENTATION') ?? null;
}

/** Millimetres per length unit of representation contexts (1 when unknown). */
class Units {
  private readonly contexts = new Map<number, number>();
  private readonly ix: StepIndex;

  constructor(ix: StepIndex) {
    this.ix = ix;
  }

  ofRepresentation(rep: number | null): number {
    const k = rep === null ? -1 : this.ix.find(rep);
    return k < 0 ? 1 : this.ofContext(ref(representationArgs(this.ix, k)?.[2]));
  }

  private ofContext(ctx: number | null): number {
    if (ctx === null) return 1;
    let mm = this.contexts.get(ctx);
    if (mm === undefined) {
      mm = 1;
      const k = this.ix.find(ctx);
      const units = k >= 0 ? list(entityParts(this.ix, k).get('GLOBAL_UNIT_ASSIGNED_CONTEXT')?.[0]) : [];
      for (const u of units) {
        const s = this.lengthUnit(ref(u), 0);
        if (s !== null) {
          mm = s;
          break;
        }
      }
      this.contexts.set(ctx, mm);
    }
    return mm;
  }

  private lengthUnit(id: number | null, depth: number): number | null {
    const k = id === null || depth > 4 ? -1 : this.ix.find(id);
    if (k < 0) return null;
    const parts = entityParts(this.ix, k);
    if (!parts.has('LENGTH_UNIT')) return null;
    const si = parts.get('SI_UNIT'); // ( prefix, .METRE. )
    if (si) {
      if (enumOf(si[1]) !== 'METRE') return null;
      const prefix = enumOf(si[0]);
      return 1000 * (prefix ? (SI_PREFIX[prefix] ?? 1) : 1);
    }
    const conv = parts.get('CONVERSION_BASED_UNIT'); // ( 'INCH', #LENGTH_MEASURE_WITH_UNIT )
    const mk = conv ? this.ix.find(ref(conv[1]) ?? -1) : -1;
    if (mk >= 0) {
      const measure = [...entityParts(this.ix, mk).values()][0]; // ( LENGTH_MEASURE(25.4), #unit )
      const value = numberOf(measure?.[0]);
      const base = this.lengthUnit(ref(measure?.[1]), depth + 1);
      if (value !== null && base !== null) return value * base;
    }
    return null;
  }
}

/** CARTESIAN_POINT / DIRECTION coordinates */
function coords(ix: StepIndex, id: number | null): number[] | null {
  const k = id === null ? -1 : ix.find(id);
  if (k < 0) return null;
  const v = list(entityArgs(ix, k)[1]).map((x) => (typeof x === 'number' ? x : 0));
  return v.length >= 3 ? v : v.length === 2 ? [v[0], v[1], 0] : null;
}

const unit = (v: number[] | null): number[] | null => {
  if (!v) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
};
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const orthogonal = (v: number[], z: number[]) => {
  const d = v[0] * z[0] + v[1] * z[1] + v[2] * z[2];
  return unit([v[0] - d * z[0], v[1] - d * z[1], v[2] - d * z[2]]);
};

/** AXIS2_PLACEMENT_3D → matrix from its local frame to its representation (translation in mm). */
function placementMatrix(ix: StepIndex, id: number | null, mm: number): Mat | null {
  const k = id === null ? -1 : ix.find(id);
  if (k < 0 || typeName(ix, k) !== 'AXIS2_PLACEMENT_3D') return null;
  const a = entityArgs(ix, k); // ( name, location, axis, ref_direction )
  const o = coords(ix, ref(a[1])) ?? [0, 0, 0];
  const z = unit(coords(ix, ref(a[2]))) ?? [0, 0, 1];
  const x = orthogonal(coords(ix, ref(a[3])) ?? [1, 0, 0], z) ?? orthogonal(Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], z)!;
  const y = cross(z, x);
  return Float64Array.of(x[0], y[0], z[0], o[0] * mm, x[1], y[1], z[1], o[1] * mm, x[2], y[2], z[2], o[2] * mm);
}

/** CARTESIAN_TRANSFORMATION_OPERATOR_3D ( …, axis1, axis2, local_origin, scale, axis3 ) */
function operatorMatrix(ix: StepIndex, k: number, mm: number): Mat | null {
  for (const args of entityParts(ix, k).values()) {
    const p = args.findIndex((v) => {
      const kk = ref(v) === null ? -1 : ix.find(ref(v)!);
      return kk >= 0 && typeName(ix, kk) === 'CARTESIAN_POINT';
    });
    if (p < 2) continue;
    const o = coords(ix, ref(args[p]))!;
    const s = typeof args[p + 1] === 'number' ? (args[p + 1] as number) : 1;
    const x = unit(coords(ix, ref(args[p - 2]))) ?? [1, 0, 0];
    const yHint = unit(coords(ix, ref(args[p - 1])));
    const z = unit(coords(ix, ref(args[p + 2]))) ?? (yHint ? unit(cross(x, yHint)) : null) ?? [0, 0, 1];
    const xo = orthogonal(x, z) ?? x;
    const y = cross(z, xo);
    return Float64Array.of(s * xo[0], s * y[0], s * z[0], o[0] * mm, s * xo[1], s * y[1], s * z[1], o[1] * mm, s * xo[2], s * y[2], s * z[2], o[2] * mm);
  }
  return null;
}

/**
 * Transformation from a component's coordinates into its assembly's, read from the
 * (shape_)representation_relationship_with_transformation behind a NAUO. The relationship maps rep_1
 * into rep_2 (transform_item_1 onto transform_item_2); rep_1 is normally the assembly in SolidWorks
 * files and the component in others, so the direction is decided by which side is the child's.
 */
function occurrenceTransform(ix: StepIndex, units: Units, relId: number, childReps: number[]): Mat | null {
  const k = ix.find(relId);
  if (k < 0) return null;
  const parts = entityParts(ix, k);
  let rep1: number | null = null;
  let rep2: number | null = null;
  let op: number | null = null;
  const rr = parts.get('REPRESENTATION_RELATIONSHIP');
  const rrwt = parts.get('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
  if (rr && rrwt) {
    rep1 = ref(rr[2]);
    rep2 = ref(rr[3]);
    op = ref(rrwt[0]);
  } else if (parts.size === 1) {
    const a = [...parts.values()][0]; // ( name, description, rep_1, rep_2, transformation_operator )
    rep1 = ref(a[2]);
    rep2 = ref(a[3]);
    op = ref(a[4]);
  }
  const ok = op === null ? -1 : ix.find(op);
  if (ok < 0) return null;
  let t: Mat | null = null;
  if (typeName(ix, ok) === 'ITEM_DEFINED_TRANSFORMATION') {
    const a = entityArgs(ix, ok); // ( name, description, transform_item_1, transform_item_2 )
    const m1 = placementMatrix(ix, ref(a[2]), units.ofRepresentation(rep1));
    const m2 = placementMatrix(ix, ref(a[3]), units.ofRepresentation(rep2));
    if (m1 && m2) t = multiply(m2, invert(m1));
  } else {
    t = operatorMatrix(ix, ok, units.ofRepresentation(rep2));
  }
  if (!t) return null;
  const child = new Set(childReps);
  const childIsRep1 = rep1 !== null && child.has(rep1);
  const childIsRep2 = rep2 !== null && child.has(rep2);
  return childIsRep2 && !childIsRep1 ? invert(t) : t;
}

// ---------------------------------------------------------------------------
// Cutting a part out of the file
// ---------------------------------------------------------------------------

export interface SplitPart {
  /** PRODUCT_DEFINITION id */
  def: number;
  name: string;
  /** entities (positions in the index) that make up the part file, in file order */
  entities: Uint32Array;
  /** statements replaced in the part file (presentation lists trimmed to this part) */
  rewrites: Map<number, string>;
  /** approximate size of the part file in bytes */
  size: number;
  /** bounds of the part's points in its own coordinates, mm: [minX, minY, minZ, maxX, maxY, maxZ] */
  box: Float64Array | null;
  /** number of occurrences in the assembly */
  uses: number;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** Fast x, y, z of CARTESIAN_POINT ( 'name', ( x, y, z ) ). */
function pointCoords(ix: StepIndex, k: number, out: number[]): boolean {
  const t = ix.text;
  const end = ix.ends[k];
  let i = t.indexOf('(', ix.starts[k]) + 1;
  while (i < end && t.charCodeAt(i) !== 39 && t.charCodeAt(i) !== 40) i++;
  if (t.charCodeAt(i) === 39) {
    // skip the name
    for (i++; i < end; i++) {
      if (t.charCodeAt(i) !== 39) continue;
      if (t.charCodeAt(i + 1) === 39) i++;
      else break;
    }
  }
  const open = t.indexOf('(', i);
  const close = open < 0 ? -1 : t.indexOf(')', open);
  if (open < 0 || close < 0 || close > end) return false;
  const v = t.slice(open + 1, close).split(',');
  for (let c = 0; c < 3; c++) out[c] = c < v.length ? parseFloat(v[c]) : 0;
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
}

class PartCutter {
  private readonly structure: StepStructure;
  private readonly units: Units;
  private readonly ix: StepIndex;
  private readonly visited: Uint8Array;
  /** geometric item -> STYLED_ITEMs colouring it */
  private readonly styledBy = new Map<number, number[]>();
  /** STYLED_ITEM -> presentation representations listing it */
  private readonly listedIn = new Map<number, number[]>();
  private readonly pointType: number;

  constructor(structure: StepStructure, units: Units) {
    this.structure = structure;
    this.units = units;
    const ix = (this.ix = structure.index);
    this.visited = new Uint8Array(ix.count);
    const code = (t: string) => ix.typeNames.indexOf(t);
    this.pointType = code('CARTESIAN_POINT');
    const styled = code('STYLED_ITEM');
    const presentations = new Set([code('MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION'), code('DRAUGHTING_MODEL')]);
    presentations.delete(-1);
    if (styled < 0 && presentations.size === 0) return;
    for (let k = 0; k < ix.count; k++) {
      const c = ix.typeOf[k];
      if (c === styled) {
        const item = ref(entityArgs(ix, k)[2]); // STYLED_ITEM ( name, styles, item )
        if (item !== null) pushTo(this.styledBy, item, ix.ids[k]);
      } else if (presentations.has(c)) {
        for (const v of list(entityArgs(ix, k)[1])) {
          const s = ref(v);
          if (s !== null) pushTo(this.listedIn, s, ix.ids[k]);
        }
      }
    }
  }

  cut(def: StepProductDef): SplitPart {
    const { ix, visited, structure } = this;
    const touched: number[] = [];
    const stack: number[] = [];
    const refs: number[] = [];
    const visit = (id: number | null) => {
      const k = id === null ? -1 : ix.find(id);
      if (k < 0 || visited[k]) return;
      visited[k] = 1;
      touched.push(k);
      stack.push(k);
    };
    const drain = () => {
      while (stack.length) {
        const k = stack.pop()!;
        refs.length = 0;
        entityRefs(ix, k, refs);
        for (const r of refs) visit(r);
        // shape representation <-> geometry representation links are not referenced by anything
        for (const link of structure.repLinks.get(ix.ids[k]) ?? []) {
          const other = ix.find(link.other);
          if (other >= 0 && typeName(ix, other) !== 'SHAPE_REPRESENTATION') visit(link.srr);
        }
      }
    };
    for (const sdr of def.sdrs) visit(sdr);
    drain();

    // colours: the styled items of the included geometry ...
    const styled: number[] = [];
    for (let i = 0, n = touched.length; i < n; i++) {
      for (const s of this.styledBy.get(ix.ids[touched[i]]) ?? []) {
        const before = touched.length;
        visit(s);
        if (touched.length > before) styled.push(s);
      }
    }
    drain();
    // ... and the presentation representations listing them, trimmed to this part
    const presented = new Map<number, number[]>();
    for (const s of styled) for (const p of this.listedIn.get(s) ?? []) pushTo(presented, p, s);
    const rewrites = new Map<number, string>();
    for (const [p, items] of presented) {
      const pk = ix.find(p);
      if (pk < 0 || visited[pk]) continue;
      visited[pk] = 1;
      touched.push(pk);
      const ctx = ref(entityArgs(ix, pk)[2]);
      visit(ctx);
      rewrites.set(pk, `#${p} = ${typeName(ix, pk)} ( '', ( ${items.map((i) => `#${i}`).join(', ')} ), ${ctx === null ? '$' : `#${ctx}`} )`);
    }
    drain();

    touched.sort((a, b) => a - b);
    const entities = Uint32Array.from(touched);
    let size = ix.header.length + 32;
    const box = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    const p = [0, 0, 0];
    for (const k of entities) {
      visited[k] = 0;
      size += (rewrites.get(k)?.length ?? ix.ends[k] - ix.starts[k]) + 2;
      if (ix.typeOf[k] === this.pointType && pointCoords(ix, k, p)) {
        for (let c = 0; c < 3; c++) {
          if (p[c] < box[c]) box[c] = p[c];
          if (p[c] > box[c + 3]) box[c + 3] = p[c];
        }
      }
    }
    const mm = this.units.ofRepresentation(def.reps[0] ?? null);
    for (let c = 0; c < 6; c++) box[c] *= mm;
    return { def: def.id, name: displayName(def), entities, rewrites, size, box: box[0] <= box[3] ? box : null, uses: 0 };
  }
}

function writeLatin1(out: Uint8Array, at: number, s: string): number {
  for (let i = 0; i < s.length; i++) out[at++] = s.charCodeAt(i);
  return at;
}

/** A self-contained STEP file holding one part (original entity text, original ids). */
export function writePartFile(ix: StepIndex, part: SplitPart): Uint8Array {
  const tail = 'ENDSEC;\nEND-ISO-10303-21;\n';
  let total = ix.header.length + 1 + tail.length;
  for (const k of part.entities) total += (part.rewrites.get(k)?.length ?? ix.ends[k] - ix.starts[k]) + 2;
  const out = new Uint8Array(total);
  let at = writeLatin1(out, 0, ix.header + '\n');
  for (const k of part.entities) {
    const r = part.rewrites.get(k);
    if (r !== undefined) at = writeLatin1(out, at, r);
    else {
      out.set(ix.bytes.subarray(ix.starts[k], ix.ends[k]), at);
      at += ix.ends[k] - ix.starts[k];
    }
    out[at++] = 59; // ;
    out[at++] = 10;
  }
  at = writeLatin1(out, at, tail);
  return out.subarray(0, at);
}

// ---------------------------------------------------------------------------
// Plan: parts + placed occurrence tree
// ---------------------------------------------------------------------------

export interface PlacedNode {
  /** PRODUCT_DEFINITION id */
  def: number;
  /** product coordinates -> model coordinates (mm) */
  matrix: Mat;
  children: PlacedNode[];
}

export interface SplitPlan {
  parts: SplitPart[];
  /** PRODUCT_DEFINITION id -> index in parts */
  partOf: Map<number, number>;
  roots: PlacedNode[];
  instances: number;
  unplaced: number;
  /** absolute meshing tolerance (mm) matching the whole-file import; 0 = unknown */
  deflection: number;
}

export function planSplit(structure: StepStructure): SplitPlan {
  const ix = structure.index;
  const units = new Units(ix);
  const cutter = new PartCutter(structure, units);
  const parts: SplitPart[] = [];
  const partOf = new Map<number, number>();
  let instances = 0;
  let unplaced = 0;

  const place = (pd: number, matrix: Mat, depth: number): PlacedNode => {
    if (depth > 64 || ++instances > 500_000) throw new Error('装配层级过深');
    const def = structure.defs.get(pd)!;
    if (def.solids + def.shells > 0) {
      let pi = partOf.get(pd);
      if (pi === undefined) {
        pi = parts.length;
        partOf.set(pd, pi);
        parts.push(cutter.cut(def));
      }
      parts[pi].uses++;
    }
    const node: PlacedNode = { def: pd, matrix, children: [] };
    def.children.forEach((child, i) => {
      const rel = structure.placements.get(def.nauos[i]);
      const childDef = structure.defs.get(child);
      let t = rel !== undefined && childDef ? occurrenceTransform(ix, units, rel, childDef.reps) : null;
      if (!t) {
        unplaced++;
        t = identity();
      }
      node.children.push(place(child, multiply(matrix, t), depth + 1));
    });
    return node;
  };
  const roots = structure.roots.map((r) => place(r, identity(), 0));

  // the whole-file import meshes with 0.001 × the average size of the model's bounding box
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const grow = (n: PlacedNode) => {
    const pi = partOf.get(n.def);
    const b = pi === undefined ? null : parts[pi].box;
    if (b) {
      for (let c = 0; c < 8; c++) {
        const p = transformPoint(n.matrix, [c & 1 ? b[3] : b[0], c & 2 ? b[4] : b[1], c & 4 ? b[5] : b[2]]);
        for (let a = 0; a < 3; a++) {
          box[a] = Math.min(box[a], p[a]);
          box[a + 3] = Math.max(box[a + 3], p[a]);
        }
      }
    }
    n.children.forEach(grow);
  };
  roots.forEach(grow);
  const size = (box[3] - box[0] + box[4] - box[1] + box[5] - box[2]) / 3;
  const deflection = Number.isFinite(size) && size > 0 ? size * MESH_PARAMS.linearDeflection : 0;
  return { parts, partOf, roots, instances, unplaced, deflection };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** The part of the occt-import-js module used here. */
export interface StepReader {
  ReadStepFile(content: Uint8Array, params: object | null): unknown;
}

/** Meshes part files, possibly several at once (one OpenCascade instance per slot). */
export interface Mesher {
  concurrency: number;
  mesh(slot: number, file: Uint8Array, params: object): Promise<MeshData[]>;
  dispose?(): void;
}

/** One part file → meshes with B-rep edges (in part coordinates). */
export function meshPartFile(reader: StepReader, file: Uint8Array, params: object): MeshData[] {
  const raw = reader.ReadStepFile(file, params) as OcctResult;
  return raw?.success ? raw.meshes.map(convertMesh).filter((m) => m.index.length > 0) : [];
}

/** Meshes parts one after another in this thread. */
export function inProcessMesher(createReader: () => Promise<StepReader>, reader?: StepReader): Mesher {
  let current: Promise<StepReader> | null = reader ? Promise.resolve(reader) : null;
  return {
    concurrency: 1,
    async mesh(_slot, file, params) {
      current ??= createReader();
      try {
        return meshPartFile(await current, file, params);
      } catch (e) {
        current = null; // the WASM instance is unusable after an abort (e.g. out of memory)
        throw e;
      }
    },
  };
}

export interface SplitHooks {
  /** after each part: parts done, part count, fraction of the work done */
  progress?(done: number, total: number, fraction: number): void;
  /** meshing finished, placing the occurrences */
  placing?(): void;
}

function transformArray(m: Mat, src: Float32Array, dst: Float32Array): void {
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    dst[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    dst[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    dst[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
}

function rotateNormals(m: Mat, src: Float32Array, dst: Float32Array): void {
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    const nx = m[0] * x + m[1] * y + m[2] * z;
    const ny = m[4] * x + m[5] * y + m[6] * z;
    const nz = m[8] * x + m[9] * y + m[10] * z;
    const l = Math.hypot(nx, ny, nz) || 1;
    dst[i] = nx / l;
    dst[i + 1] = ny / l;
    dst[i + 2] = nz / l;
  }
}

/** A part mesh placed in the model. `reuse` transforms the arrays in place (last occurrence). */
export function placeMesh(src: MeshData, m: Mat, reuse: boolean): MeshData {
  if (reuse && isIdentity(m)) return src;
  const position = reuse ? src.position : new Float32Array(src.position.length);
  transformArray(m, src.position, position);
  let normal = src.normal;
  if (normal) {
    const out = reuse ? normal : new Float32Array(normal.length);
    rotateNormals(m, normal, out);
    normal = out;
  }
  const edges = reuse ? src.edges : new Float32Array(src.edges.length);
  transformArray(m, src.edges, edges);
  const scale = Math.cbrt(Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8])));
  const circles = src.circles.map((c) => {
    const n = [m[0] * c.normal[0] + m[1] * c.normal[1] + m[2] * c.normal[2], m[4] * c.normal[0] + m[5] * c.normal[1] + m[6] * c.normal[2], m[8] * c.normal[0] + m[9] * c.normal[1] + m[10] * c.normal[2]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return { center: transformPoint(m, c.center), normal: [n[0] / l, n[1] / l, n[2] / l] as Vec3, radius: c.radius * scale, full: c.full };
  });
  // index / faceRanges / faceColors are shared by all occurrences of the part
  return { ...src, position, normal, edges, circles };
}

/** Mesh the planned parts (largest first, `mesher.concurrency` at a time) and place every occurrence. */
export async function importSplit(structure: StepStructure, plan: SplitPlan, mesher: Mesher, hooks: SplitHooks = {}): Promise<PipelineOutput> {
  const ix = structure.index;
  const params =
    plan.deflection > 0
      ? { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: plan.deflection, angularDeflection: MESH_PARAMS.angularDeflection }
      : { ...MESH_PARAMS };
  const partMeshes: MeshData[][] = plan.parts.map(() => []);
  const failedParts = new Set<number>();
  const totalSize = plan.parts.reduce((s, p) => s + p.size, 0) || 1;
  // the biggest parts take longest: start them first so the workers finish together
  const queue = plan.parts.map((_, i) => i).sort((a, b) => plan.parts[b].size - plan.parts[a].size);
  let next = 0;
  let done = 0;
  let doneSize = 0;
  const t0 = performance.now();
  const run = async (slot: number) => {
    while (next < queue.length) {
      const i = queue[next++];
      const part = plan.parts[i];
      try {
        partMeshes[i] = await mesher.mesh(slot, writePartFile(ix, part), params);
      } catch (e) {
        console.warn(`零件「${part.name}」解析失败`, e);
      }
      if (!partMeshes[i].length) failedParts.add(i);
      done++;
      doneSize += part.size;
      hooks.progress?.(done, plan.parts.length, doneSize / totalSize);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, mesher.concurrency) }, (_, slot) => run(slot)));
  const failed = [...failedParts].sort((a, b) => a - b).map((i) => plan.parts[i].name);
  const parseMs = performance.now() - t0;

  hooks.placing?.();
  const t1 = performance.now();
  const remaining = plan.parts.map((p) => p.uses);
  const meshes: MeshData[] = [];
  const toScene = (n: PlacedNode): SceneNode => {
    const node: SceneNode = { name: displayName(structure.defs.get(n.def)!), meshes: [], children: [] };
    const pi = plan.partOf.get(n.def);
    if (pi !== undefined) {
      const last = --remaining[pi] === 0;
      for (const md of partMeshes[pi]) {
        node.meshes.push(meshes.length);
        meshes.push(placeMesh(md, n.matrix, last));
      }
    }
    for (const c of n.children) node.children.push(toScene(c));
    return node;
  };
  const tops = plan.roots.map(toScene).filter(prune);
  if (!meshes.length) throw new Error('OpenCascade 未能为任何零件生成网格。');
  const root: SceneNode = tops.length === 1 ? tops[0] : { name: '', meshes: [], children: tops };

  let triangles = 0;
  const buffers = new Set<ArrayBuffer>();
  for (const m of meshes) {
    triangles += m.index.length / 3;
    for (const arr of [m.position, m.normal, m.index, m.faceRanges, m.faceColors, m.edges]) {
      if (arr) buffers.add(arr.buffer as ArrayBuffer);
    }
  }
  return {
    result: {
      root,
      meshes,
      stats: {
        format: 'step',
        parseMs,
        postMs: performance.now() - t1,
        triangles,
        meshCount: meshes.length,
        hierarchy: 'step',
        split: { parts: plan.parts.length, instances: plan.instances, failed, unplaced: plan.unplaced },
      },
    },
    transfer: [...buffers],
  };
}
