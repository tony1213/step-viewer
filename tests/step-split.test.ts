import { describe, expect, it } from 'vitest';
import { importSplit, invert, multiply, planSplit, transformPoint, writePartFile, type Mat, type StepReader } from '../src/core/step-split';
import { entityParts, entityRefs, parseStepStructure } from '../src/core/step-structure';
import type { OcctResult } from '../src/core/types';

/** Synthetic AP214 assembly with real placements, units and colours (geometry is a stub). */
class StepFile {
  private next = 100;
  private readonly lines: string[] = [];
  readonly mm: number;
  readonly inch: number;

  constructor() {
    const mmUnit = this.complex(`LENGTH_UNIT ( ) NAMED_UNIT ( * ) SI_UNIT ( .MILLI., .METRE. )`);
    const dims = this.add(`DIMENSIONAL_EXPONENTS ( 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 )`);
    const inchMeasure = this.add(`LENGTH_MEASURE_WITH_UNIT ( LENGTH_MEASURE ( 25.4 ), #${mmUnit} )`);
    const inchUnit = this.complex(`CONVERSION_BASED_UNIT ( 'INCH', #${inchMeasure} ) LENGTH_UNIT ( ) NAMED_UNIT ( #${dims} )`);
    const angle = this.complex(`NAMED_UNIT ( * ) PLANE_ANGLE_UNIT ( ) SI_UNIT ( $, .RADIAN. )`);
    const context = (unit: number) =>
      this.complex(
        `GEOMETRIC_REPRESENTATION_CONTEXT ( 3 ) GLOBAL_UNIT_ASSIGNED_CONTEXT ( ( #${angle}, #${unit} ) ) REPRESENTATION_CONTEXT ( 'NONE', 'WORKASPACE' )`,
      );
    this.mm = context(mmUnit);
    this.inch = context(inchUnit);
  }

  add(body: string): number {
    const id = this.next++;
    this.lines.push(`#${id} = ${body} ;`);
    return id;
  }

  complex(body: string): number {
    const id = this.next++;
    this.lines.push(`#${id} =( ${body} ) ;`);
    return id;
  }

  /** placement at `at` whose local x axis is `x` (z stays +Z) */
  placement(at: number[], x = [1, 0, 0]): number {
    const p = this.add(`CARTESIAN_POINT ( 'NONE', ( ${at.map((v) => v.toFixed(1)).join(', ')} ) )`);
    const z = this.add(`DIRECTION ( 'NONE', ( 0.0, 0.0, 1.0 ) )`);
    const xd = this.add(`DIRECTION ( 'NONE', ( ${x.map((v) => v.toFixed(1)).join(', ')} ) )`);
    return this.add(`AXIS2_PLACEMENT_3D ( 'NONE', #${p}, #${z}, #${xd} )`);
  }

  product(name: string, ctx: number) {
    const p = this.add(`PRODUCT ( '${name}', '${name}', '', ( #1 ) )`);
    const f = this.add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE ( 'ANY', '', #${p}, .NOT_KNOWN. )`);
    const pd = this.add(`PRODUCT_DEFINITION ( 'UNKNOWN', '', #${f}, #2 )`);
    const pds = this.add(`PRODUCT_DEFINITION_SHAPE ( 'NONE', 'NONE', #${pd} )`);
    const origin = this.placement([0, 0, 0]);
    const sr = this.add(`SHAPE_REPRESENTATION ( '${name}', ( #${origin} ), #${ctx} )`);
    this.add(`SHAPE_DEFINITION_REPRESENTATION ( #${pds}, #${sr} )`);
    return { pd, sr, origin, ctx };
  }

  /** a part whose (stub) solid has points `pts`, optionally coloured */
  part(name: string, ctx: number, pts: number[][], colour = false) {
    const prod = this.product(name, ctx);
    const verts = pts.map((pt) => this.add(`VERTEX_POINT ( 'NONE', #${this.add(`CARTESIAN_POINT ( 'NONE', ( ${pt.map((v) => v.toFixed(1)).join(', ')} ) )`)} )`));
    const shell = this.add(`CLOSED_SHELL ( 'NONE', ( ${verts.map((v) => `#${v}`).join(', ')} ) )`);
    const solid = this.add(`MANIFOLD_SOLID_BREP ( '${name}', #${shell} )`);
    const absr = this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION ( '${name}', ( #${solid}, #${prod.origin} ), #${ctx} )`);
    this.add(`SHAPE_REPRESENTATION_RELATIONSHIP ( 'NONE', 'NONE', #${prod.sr}, #${absr} )`);
    let styled = 0;
    if (colour) {
      const rgb = this.add(`COLOUR_RGB ( '', 1.0, 0.0, 0.0 )`);
      const fill = this.add(`FILL_AREA_STYLE_COLOUR ( '', #${rgb} )`);
      const style = this.add(`PRESENTATION_STYLE_ASSIGNMENT ( ( #${fill} ) )`);
      styled = this.add(`STYLED_ITEM ( 'colour', ( #${style} ), #${solid} )`);
    }
    return { ...prod, solid, styled };
  }

  /** child placed at `at` (rotated so its x axis points along `x`) */
  use(parent: { pd: number; sr: number; origin: number; ctx: number }, child: { pd: number; sr: number; origin: number }, at: number[], x?: number[], reversed = false) {
    const nauo = this.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE ( 'NAUO', ' ', '', #${parent.pd}, #${child.pd}, $ )`);
    const where = this.placement(at, x);
    // component first (most writers) or assembly first (e.g. SolidWorks)
    const [r1, r2, i1, i2] = reversed ? [parent.sr, child.sr, where, child.origin] : [child.sr, parent.sr, child.origin, where];
    const idt = this.add(`ITEM_DEFINED_TRANSFORMATION ( 'NONE', 'NONE', #${i1}, #${i2} )`);
    const rel = this.complex(
      `REPRESENTATION_RELATIONSHIP ('NONE','NONE', #${r1}, #${r2} ) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION ( #${idt} )SHAPE_REPRESENTATION_RELATIONSHIP( )`,
    );
    const pds = this.add(`PRODUCT_DEFINITION_SHAPE ( 'NONE', 'NONE', #${nauo} )`);
    this.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION ( #${rel}, #${pds} )`);
  }

  bytes(): Uint8Array {
    const text = `ISO-10303-21;\nHEADER;\nFILE_SCHEMA (( 'AUTOMOTIVE_DESIGN' ));\nENDSEC;\nDATA;\n${this.lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
    return new TextEncoder().encode(text);
  }
}

const near = (m: Mat, expected: number[]) => [...m].forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));

describe('entity access', () => {
  it('parses complex instances and finds references outside strings', () => {
    const f = new StepFile();
    const a = f.add(`CARTESIAN_POINT ( 'a #999 b', ( 0.0, 0.0, 0.0 ) )`);
    const c = f.complex(`REPRESENTATION_RELATIONSHIP ('x;y','', #5, #6 ) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION ( #7 )SHAPE_REPRESENTATION_RELATIONSHIP( )`);
    const { index } = parseStepStructure(f.bytes());
    const parts = entityParts(index, index.find(c));
    expect([...parts.keys()]).toEqual(['REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION', 'SHAPE_REPRESENTATION_RELATIONSHIP']);
    expect(parts.get('REPRESENTATION_RELATIONSHIP')![0]).toEqual({ s: 'x;y' });
    const refs: number[] = [];
    entityRefs(index, index.find(a), refs);
    expect(refs).toEqual([]);
    entityRefs(index, index.find(c), refs);
    expect(refs).toEqual([5, 6, 7]);
  });
});

describe('planSplit', () => {
  const f = new StepFile();
  const bolt = f.part('BOLT', f.mm, [[0, 0, 0], [10, 0, 0], [0, 5, 0]], true);
  const plate = f.part('PLATE', f.inch, [[0, 0, 0], [2, 1, 0.5]]);
  const sub = f.product('SUB', f.mm);
  const top = f.product('TOP', f.mm);
  f.use(sub, bolt, [100, 0, 0], [0, 1, 0]); // rotated 90° about z
  f.use(sub, bolt, [0, 20, 0], undefined, true); // relationship written assembly-first
  f.use(top, sub, [0, 50, 0]);
  f.use(top, plate, [1000, 0, 0]);
  const structure = parseStepStructure(f.bytes());
  const plan = planSplit(structure);

  it('finds each part once with its number of occurrences', () => {
    expect(plan.parts.map((p) => [p.name, p.uses])).toEqual([
      ['BOLT', 2],
      ['PLATE', 1],
    ]);
    expect(plan.unplaced).toBe(0);
  });

  it('places occurrences in both relationship orientations and nested assemblies', () => {
    const [subNode, plateNode] = plan.roots[0].children;
    near(subNode.matrix, [1, 0, 0, 0, 0, 1, 0, 50, 0, 0, 1, 0]);
    near(subNode.children[0].matrix, [0, -1, 0, 100, 1, 0, 0, 50, 0, 0, 1, 0]);
    near(subNode.children[1].matrix, [1, 0, 0, 0, 0, 1, 0, 70, 0, 0, 1, 0]);
    near(plateNode.matrix, [1, 0, 0, 1000, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(transformPoint(subNode.children[0].matrix, [10, 0, 0]).map((v) => Math.round(v))).toEqual([100, 60, 0]);
  });

  it('reads part bounds in millimetres (inch part scaled)', () => {
    expect([...plan.parts[0].box!]).toEqual([0, 0, 0, 10, 5, 0]);
    expect([...plan.parts[1].box!].map((v) => +v.toFixed(3))).toEqual([0, 0, 0, 50.8, 25.4, 12.7]);
    expect(plan.deflection).toBeGreaterThan(0);
  });

  it('writes self-contained part files with their colours and nothing of the assembly', () => {
    const text = new TextDecoder().decode(writePartFile(structure.index, plan.parts[0]));
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    for (const s of ["PRODUCT ( 'BOLT'", 'SHAPE_DEFINITION_REPRESENTATION', 'SHAPE_REPRESENTATION_RELATIONSHIP', 'ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SOLID_BREP', 'STYLED_ITEM', 'COLOUR_RGB', 'SI_UNIT']) {
      expect(text).toContain(s);
    }
    for (const s of ["'PLATE'", "'SUB'", "'TOP'", 'NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION', 'ITEM_DEFINED_TRANSFORMATION']) {
      expect(text).not.toContain(s);
    }
  });

  it('meshes each part once and places every occurrence', async () => {
    // a fake OpenCascade returning one triangle per part file, at the part's origin
    let calls = 0;
    const reader: StepReader = {
      ReadStepFile: (): OcctResult => {
        calls++;
        return {
          success: true,
          root: { name: '', meshes: [0], children: [] },
          meshes: [{ name: 'x', attributes: { position: { array: [0, 0, 0, 10, 0, 0, 0, 5, 0] } }, index: { array: [0, 1, 2] }, brep_faces: [{ first: 0, last: 0, color: null }] }],
        };
      },
    };
    const { result } = await importSplit(structure, plan, { concurrency: 2, mesh: async (_s, file, params) => (await import('../src/core/step-split')).meshPartFile(reader, file, params) });
    expect(calls).toBe(2);
    expect(result.stats.split).toMatchObject({ parts: 2, failed: [], unplaced: 0 });
    expect(result.root.name).toBe('TOP');
    expect(result.root.children.map((c) => c.name)).toEqual(['SUB', 'PLATE']);
    const sub = result.root.children[0];
    const firstBolt = result.meshes[sub.children[0].meshes[0]];
    expect([...firstBolt.position.slice(3, 6)].map((v) => Math.round(v))).toEqual([100, 60, 0]);
    // occurrences of one part share the index buffer
    expect(result.meshes[sub.children[1].meshes[0]].index).toBe(firstBolt.index);
    expect(new Set(result.meshes.map((m) => m.position.buffer)).size).toBe(result.meshes.length);
  });

  it('inverts placements exactly', () => {
    const m = plan.roots[0].children[0].children[0].matrix;
    near(multiply(m, invert(m)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });
});
