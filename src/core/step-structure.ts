/**
 * Minimal ISO 10303-21 reader that recovers the assembly product structure
 * (products, NEXT_ASSEMBLY_USAGE_OCCURRENCE links, number of bodies per part).
 *
 * occt-import-js flattens everything below the first assembly level, but it emits
 * meshes in a deterministic order (all solids depth-first, then free shells). With the
 * product structure we can predict that order, validate it against the mesh names
 * OpenCascade reports, and rebuild the real tree. If validation fails we keep the flat tree.
 */
import type { OcctNode, SceneNode } from './types';

export interface StepProductDef {
  /** PRODUCT_DEFINITION entity id */
  id: number;
  /** PRODUCT.name (decoded) */
  name: string;
  /** PRODUCT.id (decoded), used as an alternative name */
  productId: string;
  solids: number;
  shells: number;
  /** child PRODUCT_DEFINITION ids, one per NEXT_ASSEMBLY_USAGE_OCCURRENCE, in file order */
  children: number[];
}

export interface StepStructure {
  /** product definitions that are not used as a child of any assembly */
  roots: number[];
  defs: Map<number, StepProductDef>;
}

// ---------------------------------------------------------------------------
// String decoding
// ---------------------------------------------------------------------------

type Decoder = { decode(input: Uint8Array): string };
let utf8Decoder: Decoder | null = null;
let gbkDecoder: Decoder | null | undefined;

function decodeRawBytes(bytes: number[]): string {
  const arr = Uint8Array.from(bytes);
  try {
    utf8Decoder ??= new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(arr);
  } catch {
    /* not UTF-8 */
  }
  if (gbkDecoder === undefined) {
    try {
      gbkDecoder = new TextDecoder('gbk');
    } catch {
      gbkDecoder = null;
    }
  }
  if (gbkDecoder) return gbkDecoder.decode(arr);
  return String.fromCharCode(...bytes);
}

/**
 * Decode the body of a STEP string literal (without the surrounding quotes).
 * `raw` must be a latin1 view of the file bytes (one char per byte).
 * Handles '' \\ \X2\..\X0\ \X4\..\X0\ \X\hh \S\c \P?\ and raw non-ASCII bytes (UTF-8 or GBK).
 */
export function decodeStepString(raw: string): string {
  let out = '';
  let pending: number[] = [];
  const flush = () => {
    if (pending.length) {
      out += decodeRawBytes(pending);
      pending = [];
    }
  };
  for (let i = 0; i < raw.length; ) {
    const code = raw.charCodeAt(i);
    if (code >= 0x80) {
      pending.push(code & 0xff);
      i++;
      continue;
    }
    flush();
    const c = raw[i];
    if (c === "'" && raw[i + 1] === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (c === '\\') {
      if (raw.startsWith('\\X2\\', i) || raw.startsWith('\\X4\\', i)) {
        const wide = raw[i + 2] === '4';
        const end = raw.indexOf('\\X0\\', i + 4);
        if (end !== -1) {
          const hex = raw.slice(i + 4, end);
          const step = wide ? 8 : 4;
          for (let k = 0; k + step <= hex.length; k += step) {
            const cp = parseInt(hex.slice(k, k + step), 16);
            if (!Number.isNaN(cp)) out += wide ? String.fromCodePoint(cp) : String.fromCharCode(cp);
          }
          i = end + 4;
          continue;
        }
      }
      if (raw.startsWith('\\X\\', i)) {
        const cp = parseInt(raw.slice(i + 3, i + 5), 16);
        if (!Number.isNaN(cp)) out += String.fromCharCode(cp);
        i += 5;
        continue;
      }
      if (raw.startsWith('\\S\\', i) && i + 3 < raw.length) {
        out += String.fromCharCode(raw.charCodeAt(i + 3) + 128);
        i += 4;
        continue;
      }
      if (raw[i + 1] === 'P' && raw[i + 3] === '\\') {
        i += 4; // code page switch: ignored
        continue;
      }
      if (raw[i + 1] === '\\') {
        out += '\\';
        i += 2;
        continue;
      }
    }
    out += c;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Parameter list parser
// ---------------------------------------------------------------------------

type StepValue = StepValue[] | { s: string } | { r: number } | { e: string } | { t: string; v: StepValue } | number | null;

function parseParams(str: string, start: number): StepValue[] {
  let i = start;
  const n = str.length;
  const ws = () => {
    while (i < n && str.charCodeAt(i) <= 32) i++;
  };
  const value = (): StepValue => {
    ws();
    const c = str[i];
    if (c === '(') {
      i++;
      const list: StepValue[] = [];
      ws();
      if (str[i] === ')') {
        i++;
        return list;
      }
      for (;;) {
        list.push(value());
        ws();
        if (str[i] === ',') {
          i++;
          continue;
        }
        if (str[i] === ')') {
          i++;
          return list;
        }
        throw new Error('STEP 参数列表格式错误');
      }
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error('STEP 字符串未结束');
        if (str[j] === "'") {
          if (str[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const raw = str.slice(i + 1, j);
      i = j + 1;
      return { s: decodeStepString(raw) };
    }
    if (c === '#') {
      let j = i + 1;
      while (j < n && str.charCodeAt(j) >= 48 && str.charCodeAt(j) <= 57) j++;
      const r = Number(str.slice(i + 1, j));
      i = j;
      return { r };
    }
    if (c === '$' || c === '*') {
      i++;
      return null;
    }
    if (c === '.') {
      const j = str.indexOf('.', i + 1);
      const e = str.slice(i + 1, j);
      i = j + 1;
      return { e };
    }
    let j = i;
    while (j < n && str[j] !== ',' && str[j] !== '(' && str[j] !== ')') j++;
    const tok = str.slice(i, j).trim();
    if (str[j] === '(' && /^[A-Z_]/.test(tok)) {
      i = j;
      return { t: tok, v: value() };
    }
    i = j;
    return Number(tok);
  };
  ws();
  const v = value();
  if (!Array.isArray(v)) throw new Error('STEP 参数格式错误');
  return v;
}

const ref = (v: StepValue | undefined): number | null => (v && typeof v === 'object' && 'r' in v ? v.r : null);
const str = (v: StepValue | undefined): string => (v && typeof v === 'object' && 's' in v ? v.s : '');
const list = (v: StepValue | undefined): StepValue[] => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// File scan
// ---------------------------------------------------------------------------

const WANTED = new Set([
  'PRODUCT',
  'PRODUCT_DEFINITION_FORMATION',
  'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE',
  'PRODUCT_DEFINITION',
  'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS',
  'NEXT_ASSEMBLY_USAGE_OCCURRENCE',
  'PRODUCT_DEFINITION_SHAPE',
  'SHAPE_DEFINITION_REPRESENTATION',
  'SHAPE_REPRESENTATION_RELATIONSHIP',
  'SHELL_BASED_SURFACE_MODEL',
  'MANIFOLD_SOLID_BREP',
  'BREP_WITH_VOIDS',
  'FACETED_BREP',
  'MAPPED_ITEM',
  'REPRESENTATION_MAP',
]);

const isRepresentation = (type: string) => type === 'SHAPE_REPRESENTATION' || type.endsWith('_SHAPE_REPRESENTATION');

interface Entity {
  type: string;
  args: StepValue[];
}

function bytesToLatin1(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return parts.join('');
}

function scanEntities(text: string): Map<number, Entity> {
  const entities = new Map<number, Entity>();
  const data = /(?:^|[\r\n;])\s*DATA\s*;/.exec(text);
  if (!data) throw new Error('不是有效的 STEP 文件（缺少 DATA 段）');
  const head = /^\s*#(\d+)\s*=\s*([A-Z_0-9]*)\s*\(/;
  let stmtStart = data.index + data[0].length;
  let inString = false;
  for (let i = stmtStart; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 39) inString = false; // '' is handled as close+open
      continue;
    }
    if (c === 39) {
      inString = true;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      // /* comment */
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c !== 59) continue; // ;
    const stmt = text.slice(stmtStart, i);
    stmtStart = i + 1;
    const m = head.exec(stmt);
    if (!m) {
      if (stmt.trim() === 'ENDSEC') break;
      continue;
    }
    const type = m[2];
    if (!type || !(WANTED.has(type) || isRepresentation(type))) continue; // complex / uninteresting
    entities.set(Number(m[1]), { type, args: parseParams(stmt, m[0].length - 1) });
  }
  return entities;
}

// ---------------------------------------------------------------------------
// Structure extraction
// ---------------------------------------------------------------------------

export function parseStepStructure(bytes: Uint8Array): StepStructure {
  const ents = scanEntities(bytesToLatin1(bytes));

  const productNames = new Map<number, { name: string; productId: string }>();
  const formationProduct = new Map<number, number>();
  const pdFormation = new Map<number, number>();
  const nauos: { parent: number; child: number }[] = [];
  const pdsDefinition = new Map<number, number>(); // PRODUCT_DEFINITION_SHAPE -> definition
  const sdr: { definition: number; rep: number }[] = [];
  const repLinks = new Map<number, number[]>();

  for (const [id, e] of ents) {
    const a = e.args;
    switch (e.type) {
      case 'PRODUCT':
        productNames.set(id, { productId: str(a[0]), name: str(a[1]) });
        break;
      case 'PRODUCT_DEFINITION_FORMATION':
      case 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE': {
        const p = ref(a[2]);
        if (p !== null) formationProduct.set(id, p);
        break;
      }
      case 'PRODUCT_DEFINITION':
      case 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS': {
        const f = ref(a[2]);
        if (f !== null) pdFormation.set(id, f);
        break;
      }
      case 'NEXT_ASSEMBLY_USAGE_OCCURRENCE': {
        const parent = ref(a[3]);
        const child = ref(a[4]);
        if (parent !== null && child !== null) nauos.push({ parent, child });
        break;
      }
      case 'PRODUCT_DEFINITION_SHAPE': {
        const d = ref(a[2]);
        if (d !== null) pdsDefinition.set(id, d);
        break;
      }
      case 'SHAPE_DEFINITION_REPRESENTATION': {
        const d = ref(a[0]);
        const r = ref(a[1]);
        if (d !== null && r !== null) sdr.push({ definition: d, rep: r });
        break;
      }
      case 'SHAPE_REPRESENTATION_RELATIONSHIP': {
        // only the simple (non-complex) instances: part representation <-> its geometry representation.
        // Assembly placements are complex instances and are not captured by scanEntities.
        const r1 = ref(a[2]);
        const r2 = ref(a[3]);
        if (r1 !== null && r2 !== null) {
          for (const [x, y] of [
            [r1, r2],
            [r2, r1],
          ]) {
            let arr = repLinks.get(x);
            if (!arr) repLinks.set(x, (arr = []));
            arr.push(y);
          }
        }
        break;
      }
    }
  }

  const defs = new Map<number, StepProductDef>();
  for (const [pd, f] of pdFormation) {
    const p = formationProduct.get(f);
    const names = p !== undefined ? productNames.get(p) : undefined;
    defs.set(pd, { id: pd, name: names?.name ?? '', productId: names?.productId ?? '', solids: 0, shells: 0, children: [] });
  }

  const childSet = new Set<number>();
  for (const n of nauos) {
    const parent = defs.get(n.parent);
    if (!parent || !defs.has(n.child)) continue;
    parent.children.push(n.child);
    childSet.add(n.child);
  }

  const countBodies = (rep: number, seen: Set<number>): { solids: number; shells: number } => {
    const res = { solids: 0, shells: 0 };
    if (seen.has(rep)) return res;
    seen.add(rep);
    const e = ents.get(rep);
    if (!e || !isRepresentation(e.type)) return res;
    for (const item of list(e.args[1])) {
      const id = ref(item);
      const ie = id !== null ? ents.get(id) : undefined;
      if (!ie) continue;
      if (ie.type === 'MANIFOLD_SOLID_BREP' || ie.type === 'BREP_WITH_VOIDS' || ie.type === 'FACETED_BREP') res.solids++;
      else if (ie.type === 'SHELL_BASED_SURFACE_MODEL') res.shells += list(ie.args[1]).length;
      else if (ie.type === 'MAPPED_ITEM') {
        const mapId = ref(ie.args[1]);
        const map = mapId !== null ? ents.get(mapId) : undefined;
        const mapped = map ? ref(map.args[1]) : null;
        if (mapped !== null) {
          const sub = countBodies(mapped, seen);
          res.solids += sub.solids;
          res.shells += sub.shells;
        }
      }
    }
    for (const other of repLinks.get(rep) ?? []) {
      const oe = ents.get(other);
      // follow links to geometry representations only (not to other parts' plain SHAPE_REPRESENTATIONs)
      if (!oe || oe.type === 'SHAPE_REPRESENTATION') continue;
      const sub = countBodies(other, seen);
      res.solids += sub.solids;
      res.shells += sub.shells;
    }
    return res;
  };

  for (const { definition, rep } of sdr) {
    const pd = pdsDefinition.get(definition);
    const def = pd !== undefined ? defs.get(pd) : undefined;
    if (!def) continue; // PRODUCT_DEFINITION_SHAPE of an assembly occurrence, not of a product
    const b = countBodies(rep, new Set());
    def.solids += b.solids;
    def.shells += b.shells;
  }

  const roots = [...defs.keys()].filter((id) => !childSet.has(id));
  return { roots, defs };
}

// ---------------------------------------------------------------------------
// Tree reconstruction
// ---------------------------------------------------------------------------

const norm = (s: string) => s.normalize('NFC').trim();

/** OpenCascade mis-decoded the name (raw bytes) – we cannot compare it reliably. */
const unreliable = (s: string) => /[�\u0080-ÿ]/.test(s);

function nameMatches(occtName: string, def: StepProductDef): boolean {
  if (!occtName || unreliable(occtName)) return true;
  const n = norm(occtName);
  return n === norm(def.name) || n === norm(def.productId);
}

const displayName = (def: StepProductDef) => def.name || def.productId;

function prune(node: SceneNode): boolean {
  node.children = node.children.filter(prune);
  return node.meshes.length > 0 || node.children.length > 0;
}

/**
 * Rebuild the subtree under one OpenCascade mesh node (a component or a root part)
 * from the STEP product definition. Returns null when the predicted mesh order does
 * not match what OpenCascade produced.
 */
function expandComponent(occt: OcctNode, def: StepProductDef, structure: StepStructure, meshNames: string[]): SceneNode | null {
  const solidSlots: { node: SceneNode; def: StepProductDef }[] = [];
  const shellSlots: { node: SceneNode; def: StepProductDef }[] = [];
  let budget = 200_000;
  const build = (d: StepProductDef, depth: number): SceneNode => {
    if (depth > 64 || --budget < 0) throw new Error('assembly too deep');
    const node: SceneNode = { name: displayName(d), meshes: [], children: [] };
    for (let i = 0; i < d.solids; i++) solidSlots.push({ node, def: d });
    for (let i = 0; i < d.shells; i++) shellSlots.push({ node, def: d });
    for (const c of d.children) {
      const cd = structure.defs.get(c);
      if (cd) node.children.push(build(cd, depth + 1));
    }
    return node;
  };
  let top: SceneNode;
  try {
    top = build(def, 0);
  } catch {
    return null;
  }
  const slots = [...solidSlots, ...shellSlots];
  let meshes = occt.meshes;
  if (meshes.length === slots.length + 1 && meshNames[meshes[meshes.length - 1]] === '') {
    // occt-import-js appends one extra mesh for faces that do not belong to any shell
    top.meshes.push(meshes[meshes.length - 1]);
    meshes = meshes.slice(0, -1);
  }
  if (meshes.length !== slots.length || slots.length === 0) return null;
  for (let i = 0; i < meshes.length; i++) {
    if (!nameMatches(meshNames[meshes[i]], slots[i].def)) return null;
  }
  for (let i = 0; i < meshes.length; i++) slots[i].node.meshes.push(meshes[i]);
  prune(top);
  return top;
}

/** OpenCascade's own (flattened) structure, made a little friendlier. */
function flatNode(occt: OcctNode, meshNames: string[]): SceneNode {
  const node: SceneNode = { name: occt.name, meshes: [], children: occt.children.map((c) => flatNode(c, meshNames)) };
  const named = occt.meshes.filter((m) => meshNames[m] && meshNames[m] !== occt.name);
  if (occt.meshes.length <= 1 || named.length === 0) {
    node.meshes = [...occt.meshes];
  } else {
    occt.meshes.forEach((m, i) => node.children.push({ name: meshNames[m] || `实体 ${i + 1}`, meshes: [m], children: [] }));
  }
  return node;
}

export interface SceneTree {
  root: SceneNode;
  hierarchy: 'step' | 'partial' | 'flat';
}

export function buildSceneTree(occtRoot: OcctNode, meshNames: string[], structure: StepStructure | null): SceneTree {
  let mapped = 0;
  let total = 0;
  const unusedRoots = structure ? [...structure.roots] : [];

  const mapTop = (f: OcctNode): SceneNode => {
    if (!structure) return flatNode(f, meshNames);
    const idx = unusedRoots.findIndex((r) => nameMatches(f.name, structure.defs.get(r)!));
    if (idx < 0) return flatNode(f, meshNames);
    const rootDef = structure.defs.get(unusedRoots[idx])!;
    unusedRoots.splice(idx, 1);

    if (f.children.length === 0) {
      // the free shape is a single part (or occt treated it as one)
      total++;
      const n = expandComponent(f, rootDef, structure, meshNames);
      if (n) mapped++;
      return n ?? flatNode(f, meshNames);
    }
    const childDefs = rootDef.children.map((c) => structure.defs.get(c));
    if (childDefs.length !== f.children.length || childDefs.some((d, k) => !d || !nameMatches(f.children[k].name, d))) {
      total += f.children.length;
      return flatNode(f, meshNames);
    }
    const node: SceneNode = { name: displayName(rootDef), meshes: [...f.meshes], children: [] };
    f.children.forEach((comp, k) => {
      total++;
      const n = expandComponent(comp, childDefs[k]!, structure, meshNames);
      if (n) mapped++;
      node.children.push(n ?? flatNode(comp, meshNames));
    });
    prune(node);
    return node;
  };

  let root: SceneNode = { name: occtRoot.name, meshes: [...occtRoot.meshes], children: occtRoot.children.map(mapTop) };
  // skip the anonymous document root when it only wraps one assembly
  if (!root.name && root.meshes.length === 0 && root.children.length === 1) root = root.children[0];

  const hierarchy = total > 0 && mapped === total ? 'step' : mapped > 0 ? 'partial' : 'flat';
  return { root, hierarchy };
}
