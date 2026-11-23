# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-only viewer for mechanical STEP / IGES / BREP files, built with Vite, TypeScript, three.js and occt-import-js (OpenCascade compiled to WebAssembly).
- Models are parsed inside the browser and never uploaded.
- All user-facing text (UI, toasts, errors, README) is Chinese.
- The scope is deliberately web-only: no CLI launcher and no desktop file-type integration.

## Commands

```bash
npm run dev                                 # Vite dev server on http://127.0.0.1:5280
npm start                                   # production build + vite preview on 127.0.0.1:5280, opens the browser
npm test                                    # vitest run; real-file tests are skipped unless the env vars below are set
npx vitest run tests/edges.test.ts          # a single test file
npx vitest run -t "drops B-rep faces"       # tests whose name matches
npm run typecheck                           # tsc on tsconfig.json (src, DOM) and tsconfig.node.json (tests + src/core, no DOM)
npm run build                               # typecheck + vite build → dist/
STEP_SAMPLE=/path/model.STEP npm test       # acceptance on a real file, including part-by-part vs whole-file comparison
STEP_SAMPLE_LARGE=/path/big.STEP npm test   # part-by-part import of a file too big for one pass (takes minutes)
```

- **Toolchain:** there is no linter, so `npm run typecheck` is the static check. TypeScript is v7 (native `tsc`). vitest 5 needs Node ≥ 22.12; CI uses Node 24.
- **CAD files stay out of the repo:** `*.step`, `*.stp`, `*.iges`, `*.igs`, `*.brep`, `*.brp` and `*.glb` are gitignored. Samples live outside the repo and are usually proprietary.

**URL parameters** (handled in `src/main.ts`):
- `?model=<url>&name=<file>` fetches and opens a model. A file placed in `dist/` for this is deleted by the next build.
- `?debug` exposes `window.stepViewer` (the App) and `window.stepViewerPick(x, y)` for browser automation.
- `?split=1` forces part-by-part reading; `?split=0` disables it.

Measure parse speed in headless Chrome. A tab with a debugger attached (for example Claude in Chrome) runs WASM about 5× slower, because the debugger disables tier-up.

## Deployment

**Pushing to `main` publishes the public site.** `.github/workflows/deploy.yml` runs `npm ci`, `npm test` and `npm run build`, then deploys `dist/` to GitHub Pages at https://tony1213.github.io/step-viewer/.

**Keep every URL relative.** `vite.config.ts` sets `base: './'`, so one build works both at `/` locally and under `/step-viewer/`.
- Workers: `new URL('./x.worker.ts', import.meta.url)`.
- The WASM file: a `?url` import.

## Architecture

### Load pipeline

1. **`src/main.ts` (`App`)** wires the toolbar, tree, panels and shortcuts. It takes a file from the picker, from drag and drop or from `?model=`, and hands it to `ModelLoader`.
2. **`ModelLoader` (`src/loader.ts`)** starts a fresh `occt.worker` per file, so the WASM heap is released afterwards. It relays stage and progress messages (`src/worker/protocol.ts`), and cancelling terminates the worker.
3. **`src/worker/occt.worker.ts`** loads OpenCascade and parses the STEP product structure itself (`core/step-structure.ts`). It then reads the whole file, or goes part by part (see below).
   - The result is an `ImportResult` (`core/types.ts`): `MeshData[]`, a `SceneNode` tree and stats.
   - Its typed-array buffers are transferred to the main thread, not copied.
4. **`src/viewer/model.ts` (`Model`)** turns the tree into three.js groups, display modes and section caps.
   - `Viewer` owns the renderer, both cameras, the controls and the up axis.
   - `picking` (BVH), `measure`, `section`, `explode` and `export` all operate on the `Model`.

### Invariants that span several files

- **Geometry is in model space, in mm.**
  - `MeshData.position` is already placed, and scene-tree nodes carry no transforms.
  - Explode only offsets groups.
  - Measurements keep their points in mesh coordinates and are re-evaluated after an explode.
  - GLB export scales to metres and rotates the chosen up axis to +Y.
- **B-rep faces are triangle ranges.** `MeshData.faceRanges` holds one inclusive `[first, last]` pair per B-rep face.
  - Picking (`findFace`), face highlighting, the area and perimeter in `core/geom.ts`, and edge extraction all rely on these ranges.
  - Faces that OpenCascade failed to triangulate come back with `last = -1`. `convertMesh` drops them; otherwise -1 wraps to 2^32-1 and edge extraction hangs.
- **Edges are B-rep face boundaries, not angle-threshold feature edges** (`core/edges.ts`).
  - Vertices are welded by quantized position, then each face's boundary segments are kept.
  - Circles and arcs are detected from the resulting polylines.
  - `MAX_ARC_STEP` is derived from `MESH_PARAMS.angularDeflection` (`core/mesh-params.ts`), so changing the triangulation parameters also changes circle detection.
- **The assembly tree is rebuilt from the STEP file.** occt-import-js flattens everything below the first assembly level.
  - `core/step-structure.ts` reads the product structure (NAUO links) and predicts the order in which OpenCascade emits meshes.
  - It checks that prediction against the mesh names and rebuilds the real tree.
  - `stats.hierarchy` records the outcome: `'step'`, `'partial'`, or `'flat'` when it falls back to OpenCascade's tree.
- **`src/core` is pure and DOM-free.**
  - `tsconfig.node.json` type-checks it without the DOM lib.
  - The same code runs in workers, on the main thread and in Node tests.
  - Browser-only code (for example the Web Worker pool) belongs in `src/worker`.

### Large STEP files: part-by-part import

OpenCascade's WASM heap is capped at 2 GB, and it needs roughly 35 MB of heap per MB of STEP. Above about 40–60 MB a whole-file read fills the heap, and BRepMesh then silently produces no triangles. `occt.worker.ts` handles this as follows:

- **Files over 30 MB (`SPLIT_ABOVE`) go through `core/step-split.ts`:**
  - `planSplit` cuts each part into a standalone STEP file: the entity closure of its shape representations, plus their styled items.
  - `importSplit` meshes each unique part once through a `Mesher`: up to 4 nested `mesh.worker`s in the browser, or `inProcessMesher` in Node tests.
  - Each occurrence is then placed via NAUO → CDSR → representation relationship → `ITEM_DEFINED_TRANSFORMATION`, with unit conversion such as inches to mm.
- **Files up to 60 MB (`WHOLE_MAX`)** are read whole instead if any occurrence's placement cannot be read.
- **A whole-file read that yields 0 triangles** is retried part by part.
- **SolidWorks convention:** it writes the assembly as `rep_1` of the placing relationship. The transform's direction is therefore decided by which representation belongs to the child.

### Tests

- **Synthetic unit tests:** most of `tests/*.test.ts` covers `src/core` with synthetic data. `tests/step-split.test.ts` builds STEP text with a small in-file builder.
- **Real-file tests:** `tests/sample.test.ts` runs OpenCascade in Node on the files named by `STEP_SAMPLE` / `STEP_SAMPLE_LARGE`.
  - The reference assembly is `升降机构组件-V1.STEP`. For it, the test asserts a face with SolidWorks' measured area 41759.59 mm² and perimeter 899.38 mm.
  - It also checks that part-by-part placement matches the whole-file read within 0.5 mm.
  - Re-run these after changing geometry, edges, tessellation or STEP parsing.

## Conventions

- Commit messages: `feat: …`, `fix: …`, `ci: …`, with the description in Chinese.
- Dev and preview servers bind to 127.0.0.1:5280 only.
