/**
 * Acceptance tests on real STEP files (skipped unless the variables are set):
 *   STEP_SAMPLE=/path/to/model.STEP npm test
 *   STEP_SAMPLE_LARGE=/path/to/big-assembly.STEP npm test   (part-by-part import of a file too big for one pass)
 * For the reference sample (升降机构组件-V1.STEP) it also checks a face against the
 * values measured in SolidWorks (area 41759.59 mm², perimeter 899.38 mm).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { faceArea, faceBoundary, faceMetrics, vertexDegrees } from '../src/core/geom';
import { MESH_PARAMS, processOcctResult } from '../src/core/pipeline';
import { importSplit, inProcessMesher, planSplit, type StepReader } from '../src/core/step-split';
import { parseStepStructure, type StepStructure } from '../src/core/step-structure';
import type { ImportResult, OcctResult, SceneNode } from '../src/core/types';

const sample = process.env.STEP_SAMPLE;
const large = process.env.STEP_SAMPLE_LARGE;
const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js') as () => Promise<StepReader>;

/** bounding box of every tree node's own meshes, keyed by its path (repeated names numbered) */
function nodeBoxes(result: ImportResult): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const walk = (n: SceneNode, path: string) => {
    let key = `${path}/${n.name}`;
    for (let i = 2; out.has(key); i++) key = `${path}/${n.name}#${i}`;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const mi of n.meshes) {
      const p = result.meshes[mi].position;
      for (let i = 0; i < p.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          b[c] = Math.min(b[c], p[i + c]);
          b[c + 3] = Math.max(b[c + 3], p[i + c]);
        }
      }
    }
    out.set(key, b);
    n.children.forEach((c) => walk(c, key));
  };
  walk(result.root, '');
  return out;
}

async function splitImport(structure: StepStructure): Promise<ImportResult> {
  const plan = planSplit(structure);
  return (await importSplit(structure, plan, inProcessMesher(occtimportjs))).result;
}

describe.skipIf(!sample)('real STEP file', () => {
  let whole: { structure: StepStructure; result: ImportResult } | null = null;

  it('imports with hierarchy, edges and measurable faces', async () => {
    const occt = await occtimportjs();
    const bytes = new Uint8Array(readFileSync(sample!));

    let t = performance.now();
    const structure = parseStepStructure(bytes);
    const structureMs = performance.now() - t;
    t = performance.now();
    const raw = occt.ReadStepFile(bytes, { ...MESH_PARAMS }) as OcctResult;
    const parseMs = performance.now() - t;
    expect(raw.success).toBe(true);

    const { result } = processOcctResult(raw, { format: 'step', structure, parseMs });
    whole = { structure, result };
    const { stats } = result;
    let depth = 0;
    let nodes = 0;
    const names = new Set<string>();
    const walk = (n: SceneNode, d: number) => {
      nodes++;
      depth = Math.max(depth, d);
      names.add(n.name);
      n.children.forEach((c) => walk(c, d + 1));
    };
    walk(result.root, 1);
    const edgeSegments = result.meshes.reduce((s, m) => s + m.edges.length / 6, 0);
    const circles = result.meshes.reduce((s, m) => s + m.circles.length, 0);
    const closedMeshes = result.meshes.filter((m) => m.closed).length;
    console.log(
      `[sample] ${basename(sample!)}: structure ${structureMs.toFixed(0)} ms, occt ${parseMs.toFixed(0)} ms, post ${stats.postMs.toFixed(0)} ms; ` +
        `${stats.meshCount} meshes, ${stats.triangles} triangles, ${edgeSegments} edge segments, ${circles} circles, ` +
        `${closedMeshes} closed; tree ${nodes} nodes, depth ${depth}, hierarchy=${stats.hierarchy}`,
    );

    expect(stats.meshCount).toBeGreaterThan(0);
    expect(edgeSegments).toBeGreaterThan(0);

    if (basename(sample!).includes('升降机构组件')) {
      expect(stats.hierarchy).toBe('step');
      expect(result.root.name).toBe('升降机构组件-V1');
      expect(depth).toBeGreaterThanOrEqual(5);
      for (const n of ['升降电机固定底板', '本体固定板', '升降限位滚轮座', '1111']) expect(names.has(n)).toBe(true);

      // find the face SolidWorks measured: area 41759.59 mm², perimeter 899.38 mm
      const hits: string[] = [];
      result.meshes.forEach((m, mi) => {
        const degrees = vertexDegrees(m.edges);
        for (let f = 0; f < m.faceRanges.length / 2; f++) {
          const first = m.faceRanges[2 * f];
          const last = m.faceRanges[2 * f + 1];
          const rawArea = faceArea(m.position, m.index, first, last);
          if (Math.abs(rawArea - 41759.59) / 41759.59 > 0.003) continue;
          const rawPerimeter = faceBoundary(m.position, m.index, first, last).length;
          const exact = faceMetrics(m.position, m.index, first, last, degrees);
          hits.push(
            `mesh ${mi} "${m.name}" face ${f}: mesh area ${rawArea.toFixed(2)} / perimeter ${rawPerimeter.toFixed(2)} → ` +
              `corrected area ${exact.area.toFixed(2)} / perimeter ${exact.perimeter.toFixed(2)}`,
          );
          if (Math.abs(exact.area - 41759.59) < 0.5 && Math.abs(exact.perimeter - 899.38) < 0.05) hits.push('MATCH');
        }
      });
      console.log('[sample] candidate faces:\n  ' + hits.join('\n  '));
      expect(hits).toContain('MATCH');
    }
  });

  it('gives the same model when read part by part', async () => {
    expect(whole).not.toBeNull();
    const t = performance.now();
    const split = await splitImport(whole!.structure);
    console.log(`[sample] part by part: ${(performance.now() - t).toFixed(0)} ms, ${split.stats.split!.parts} parts, ${split.stats.triangles} triangles`);
    expect(split.stats.split!.failed).toEqual([]);
    expect(split.stats.split!.unplaced).toBe(0);
    expect(split.meshes.length).toBe(whole!.result.meshes.length);
    // every occurrence lands where OpenCascade put it (differences = tessellation only)
    const a = nodeBoxes(whole!.result);
    const b = nodeBoxes(split);
    expect([...b.keys()]).toEqual([...a.keys()]);
    let worst = 0;
    for (const [key, box] of a) if (Number.isFinite(box[0])) worst = Math.max(worst, ...box.map((v, i) => Math.abs(v - b.get(key)![i])));
    expect(worst).toBeLessThan(0.5);
    if (basename(sample!).includes('升降机构组件')) {
      const found = split.meshes.some((m) => {
        const degrees = vertexDegrees(m.edges);
        for (let f = 0; f < m.faceRanges.length / 2; f++) {
          const r = faceMetrics(m.position, m.index, m.faceRanges[2 * f], m.faceRanges[2 * f + 1], degrees);
          if (Math.abs(r.area - 41759.59) < 0.5 && Math.abs(r.perimeter - 899.38) < 0.05) return true;
        }
        return false;
      });
      expect(found).toBe(true);
    }
  });
});

describe.skipIf(!large)('large STEP file (part by part)', () => {
  it('meshes every part within the 2 GB WebAssembly heap', async () => {
    const t = performance.now();
    const structure = parseStepStructure(new Uint8Array(readFileSync(large!)));
    const result = await splitImport(structure);
    const s = result.stats.split!;
    console.log(`[large] ${basename(large!)}: ${(performance.now() - t).toFixed(0)} ms, ${s.parts} parts, ${s.instances} occurrences, ${result.stats.triangles} triangles`);
    expect(s.failed).toEqual([]);
    expect(s.unplaced).toBe(0);
    expect(result.stats.triangles).toBeGreaterThan(0);
  }, 900_000);
});
