import { describe, expect, it } from 'vitest';
import { buildSceneTree, decodeStepString, parseStepStructure } from '../src/core/step-structure';
import type { OcctNode } from '../src/core/types';

/** Generates a small but realistic STEP product structure (SolidWorks style). */
class StepBuilder {
  private next = 100;
  private lines: string[] = [];
  private add(body: string): number {
    const id = this.next++;
    this.lines.push(`#${id} = ${body} ;`);
    return id;
  }
  private product(name: string): { pd: number; sr: number } {
    const p = this.add(`PRODUCT ( '${name}', '${name}', '', ( #1 ) )`);
    const f = this.add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE ( 'ANY', '', #${p}, .NOT_KNOWN. )`);
    const pd = this.add(`PRODUCT_DEFINITION ( 'UNKNOWN', '', #${f}, #2 )`);
    const pds = this.add(`PRODUCT_DEFINITION_SHAPE ( 'NONE', 'NONE',  #${pd} )`);
    const sr = this.add(`SHAPE_REPRESENTATION ( '${name}', ( #3 ), #4 )`);
    this.add(`SHAPE_DEFINITION_REPRESENTATION ( #${pds}, #${sr} )`);
    return { pd, sr };
  }
  part(name: string, solids: number, shells = 0): { pd: number; sr: number } {
    const res = this.product(name);
    const items: number[] = [];
    for (let i = 0; i < solids; i++) items.push(this.add(`MANIFOLD_SOLID_BREP ( 'NONE', #9 )`));
    if (shells) items.push(this.add(`SHELL_BASED_SURFACE_MODEL ( 'NONE', ( ${Array(shells).fill('#9').join(', ')} ) )`));
    if (items.length) {
      const absr = this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION ( '${name}', ( ${items.map((i) => `#${i}`).join(', ')} ), #4 )`);
      this.add(`SHAPE_REPRESENTATION_RELATIONSHIP ( 'NONE', 'NONE', #${absr}, #${res.sr} )`);
    }
    return res;
  }
  assembly(name: string, children: { pd: number; sr: number }[]): { pd: number; sr: number } {
    const res = this.product(name);
    for (const c of children) {
      const nauo = this.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE ( 'NAUO${this.next}', ' ', '', #${res.pd}, #${c.pd}, $ )`);
      // complex placement entity (must not be mistaken for a part's geometry link)
      const id = this.next++;
      this.lines.push(
        `#${id} =( REPRESENTATION_RELATIONSHIP ('NONE','NONE', #${c.sr}, #${res.sr} ) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION ( #8 )SHAPE_REPRESENTATION_RELATIONSHIP( ) );`,
      );
      const pds = this.add(`PRODUCT_DEFINITION_SHAPE ( 'NONE', 'NONE', #${nauo} )`);
      this.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION ( #${id}, #${pds} )`);
    }
    return res;
  }
  bytes(): Uint8Array {
    const text = `ISO-10303-21;\nHEADER;\nFILE_NAME ('a;b.STEP', '', ( '' ), ( '' ), '', '', '' );\nENDSEC;\nDATA;\n${this.lines.join('\n')}\n/* comment ; with ' quote */\nENDSEC;\nEND-ISO-10303-21;\n`;
    return new TextEncoder().encode(text);
  }
}

const leaf = (name: string, meshes: number[]): OcctNode => ({ name, meshes, children: [] });

describe('decodeStepString', () => {
  it('decodes escapes and raw UTF-8', () => {
    expect(decodeStepString('\\X2\\5347964d\\X0\\-V1')).toBe('升降-V1');
    expect(decodeStepString("Part''s \\X\\E9 \\\\")).toBe("Part's é \\");
    expect(decodeStepString('\\X4\\0001F600\\X0\\')).toBe('😀');
    const utf8 = String.fromCharCode(...new TextEncoder().encode('底板'));
    expect(decodeStepString(utf8)).toBe('底板');
  });
});

describe('parseStepStructure + buildSceneTree', () => {
  const b = new StepBuilder();
  const p1 = b.part('\\X2\\5e95677f\\X0\\', 2); // 底板, two bodies
  const p2 = b.part("Part''s B", 1);
  const shell = b.part('SHELL', 0, 2);
  const sub = b.assembly('SUB', [shell, p2, p2]);
  const top = b.assembly('TOP', [p1, sub, p2]);
  const structure = parseStepStructure(b.bytes());

  it('reads products, assembly links and body counts', () => {
    expect(structure.roots).toEqual([top.pd]);
    const topDef = structure.defs.get(top.pd)!;
    expect(topDef.name).toBe('TOP');
    expect(topDef.children).toEqual([p1.pd, sub.pd, p2.pd]);
    expect(structure.defs.get(p1.pd)).toMatchObject({ name: '底板', solids: 2, shells: 0 });
    expect(structure.defs.get(p2.pd)).toMatchObject({ name: "Part's B", solids: 1, shells: 0 });
    expect(structure.defs.get(shell.pd)).toMatchObject({ solids: 0, shells: 2 });
    expect(structure.defs.get(sub.pd)).toMatchObject({ solids: 0, shells: 0, children: [shell.pd, p2.pd, p2.pd] });
  });

  // occt-import-js output: components are flat; inside SUB the solids come first, then the shells
  const occtRoot: OcctNode = {
    name: '',
    meshes: [],
    children: [
      {
        name: 'TOP',
        meshes: [],
        children: [leaf('底板', [0, 1]), leaf('SUB', [2, 3, 4, 5]), leaf("Part's B", [6])],
      },
    ],
  };
  const names = ['', '', "Part's B", "Part's B", '', '', "Part's B"];

  it('rebuilds the full hierarchy when the mesh order validates', () => {
    const { root, hierarchy } = buildSceneTree(occtRoot, names, structure);
    expect(hierarchy).toBe('step');
    expect(root.name).toBe('TOP');
    expect(root.children.map((c) => c.name)).toEqual(['底板', 'SUB', "Part's B"]);
    expect(root.children[0].meshes).toEqual([0, 1]);
    const subNode = root.children[1];
    expect(subNode.meshes).toEqual([]);
    expect(subNode.children.map((c) => [c.name, c.meshes])).toEqual([
      ['SHELL', [4, 5]],
      ["Part's B", [2]],
      ["Part's B", [3]],
    ]);
    expect(root.children[2].meshes).toEqual([6]);
  });

  it('falls back to the flat tree when names contradict the predicted order', () => {
    const wrong = [...names];
    wrong[2] = '底板';
    const { root, hierarchy } = buildSceneTree(occtRoot, wrong, structure);
    expect(hierarchy).toBe('partial');
    const subNode = root.children[1];
    expect(subNode.name).toBe('SUB');
    // flat fallback lists the meshes as children
    expect(subNode.children.map((c) => c.meshes)).toEqual([[2], [3], [4], [5]]);
  });

  it('works without structure (IGES / BREP)', () => {
    const { root, hierarchy } = buildSceneTree(occtRoot, names, null);
    expect(hierarchy).toBe('flat');
    expect(root.children).toHaveLength(3);
  });
});
