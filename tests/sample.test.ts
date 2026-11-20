/**
 * Acceptance test on a real STEP file (skipped unless STEP_SAMPLE is set):
 *   STEP_SAMPLE=/path/to/model.STEP npm test
 * For the reference sample (升降机构组件-V1.STEP) it also checks a face against the
 * values measured in SolidWorks (area 41759.59 mm², perimeter 899.38 mm).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { faceArea, faceBoundary, faceMetrics, vertexDegrees } from '../src/core/geom';
import { processOcctResult } from '../src/core/pipeline';
import { parseStepStructure } from '../src/core/step-structure';
import type { OcctResult, SceneNode } from '../src/core/types';

const sample = process.env.STEP_SAMPLE;

describe.skipIf(!sample)('real STEP file', () => {
  it('imports with hierarchy, edges and measurable faces', async () => {
    const require = createRequire(import.meta.url);
    const occtimportjs = require('occt-import-js') as () => Promise<{ ReadStepFile: (b: Uint8Array, p: object) => OcctResult }>;
    const occt = await occtimportjs();
    const bytes = new Uint8Array(readFileSync(sample!));

    let t = performance.now();
    const structure = parseStepStructure(bytes);
    const structureMs = performance.now() - t;
    t = performance.now();
    const raw = occt.ReadStepFile(bytes, {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    const parseMs = performance.now() - t;
    expect(raw.success).toBe(true);

    const { result } = processOcctResult(raw, { format: 'step', structure, parseMs });
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
});
