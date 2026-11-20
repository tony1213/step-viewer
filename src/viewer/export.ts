import * as THREE from 'three';
import type { Model, NodeInfo } from './model';
import { upVector, type Viewer } from './viewer';

export function download(blob: Blob, fileName: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** PNG of the current view on the viewport background, including measurement labels. */
export async function screenshot(viewer: Viewer, baseName: string): Promise<void> {
  viewer.renderNow();
  const src = viewer.renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, out.height);
  grad.addColorStop(0, '#fdfdfe');
  grad.addColorStop(1, '#dfe5ee');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);

  // CSS2D labels are DOM elements: paint them at their on-screen positions
  const scale = src.width / Math.max(1, src.clientWidth);
  const origin = src.getBoundingClientRect();
  const font = getComputedStyle(document.body).fontFamily;
  for (const el of viewer.labelRenderer.domElement.querySelectorAll<HTMLElement>('.measure-label')) {
    if (el.style.display === 'none' || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const x = (r.left - origin.left) * scale;
    const y = (r.top - origin.top) * scale;
    const style = getComputedStyle(el);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = 1.5 * scale;
    roundRect(ctx, x, y, r.width * scale, r.height * scale, 6 * scale);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = 'top';
    const lines = el.innerText.split('\n').filter(Boolean);
    lines.forEach((line, i) => {
      ctx.font = `${i === 0 ? 600 : 500} ${12 * scale}px ${font}`;
      ctx.fillStyle = i === 0 ? '#1d2330' : '#6b3fa0';
      ctx.fillText(line, x + 7 * scale, y + (3 + i * 16) * scale);
    });
  }
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('截图失败');
  download(blob, `${baseName}.png`);
  viewer.requestRender();
}

/**
 * GLB of the visible parts (current colours, transparency and explode offsets).
 * Converted to metres and rotated so the chosen up axis becomes glTF's +Y.
 */
export async function exportGLB(model: Model, viewer: Viewer, baseName: string): Promise<void> {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const root = new THREE.Group();
  root.name = baseName;
  root.scale.setScalar(0.001);
  root.quaternion.setFromUnitVectors(upVector(viewer.upAxis), new THREE.Vector3(0, 1, 0));
  const materials: THREE.Material[] = [];

  const clone = (n: NodeInfo): THREE.Object3D | null => {
    if (!n.visible) return null;
    const g = new THREE.Group();
    g.name = n.label;
    g.position.copy(n.group.position);
    const transparent = model.xray || model.isTransparent(n);
    for (const rec of n.meshes) {
      const useVertexColors = rec.hasVertexColors && !model.colorByPart;
      const mat = new THREE.MeshStandardMaterial({
        name: n.label,
        color: useVertexColors ? 0xffffff : (model.colorByPart ? rec.partColor : rec.baseColor).clone(),
        vertexColors: useVertexColors,
        metalness: 0.1,
        roughness: 0.6,
        side: rec.data.closed ? THREE.FrontSide : THREE.DoubleSide,
        transparent,
        opacity: transparent ? 0.3 : 1,
      });
      materials.push(mat);
      const m = new THREE.Mesh(rec.mesh.geometry, mat);
      m.name = rec.mesh.name;
      g.add(m);
    }
    for (const c of n.children) {
      const cc = clone(c);
      if (cc) g.add(cc);
    }
    return g.children.length ? g : null;
  };

  const tree = clone(model.tree);
  if (!tree) throw new Error('没有可见的零件可以导出');
  root.add(tree);
  root.updateMatrixWorld(true);
  try {
    const glb = (await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true })) as ArrayBuffer;
    download(new Blob([glb], { type: 'model/gltf-binary' }), `${baseName}.glb`);
  } finally {
    materials.forEach((m) => m.dispose());
  }
}
