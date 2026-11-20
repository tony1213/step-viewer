import * as THREE from 'three';

const SVG_NS = 'http://www.w3.org/2000/svg';
const AXES = [
  { key: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#e5484d' },
  { key: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#30a46c' },
  { key: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#3e63dd' },
];

/** Small clickable XYZ triad (SVG) that follows the camera orientation. */
export class AxisGizmo {
  readonly el: SVGSVGElement;
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private lastKey = '';

  constructor(container: HTMLElement, onPick: (dir: THREE.Vector3) => void) {
    this.el = document.createElementNS(SVG_NS, 'svg');
    this.el.classList.add('axis-gizmo');
    this.el.setAttribute('viewBox', '0 0 92 92');
    container.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const end = (e.target as Element).closest('[data-dir]');
      if (!end) return;
      const [x, y, z] = end.getAttribute('data-dir')!.split(',').map(Number);
      onPick(new THREE.Vector3(x, y, z));
    });
  }

  update(camera: THREE.Camera): void {
    this.q.copy(camera.quaternion).invert();
    const c = 46;
    const len = 30;
    const items: { key: string; color: string; sign: number; dir: string; x: number; y: number; z: number }[] = [];
    for (const a of AXES) {
      for (const sign of [1, -1]) {
        this.v.copy(a.dir).multiplyScalar(sign).applyQuaternion(this.q);
        items.push({
          key: a.key,
          color: a.color,
          sign,
          dir: `${a.dir.x * sign},${a.dir.y * sign},${a.dir.z * sign}`,
          x: c + this.v.x * len,
          y: c - this.v.y * len,
          z: this.v.z,
        });
      }
    }
    const key = items.map((i) => `${i.x.toFixed(1)},${i.y.toFixed(1)}`).join(';');
    if (key === this.lastKey) return;
    this.lastKey = key;
    items.sort((a, b) => a.z - b.z);
    let svg = '';
    for (const it of items) {
      const pos = it.sign > 0;
      if (pos) {
        svg += `<line x1="${c}" y1="${c}" x2="${it.x.toFixed(2)}" y2="${it.y.toFixed(2)}" stroke="${it.color}" stroke-width="2.5"/>`;
      }
      const title = `从 ${pos ? '+' : '−'}${it.key} 方向看`;
      svg +=
        `<g class="gz-end" data-dir="${it.dir}"><title>${title}</title>` +
        `<circle cx="${it.x.toFixed(2)}" cy="${it.y.toFixed(2)}" r="${pos ? 9 : 6}" fill="${pos ? it.color : 'var(--gizmo-neg)'}" stroke="${it.color}" stroke-width="1.5"/>` +
        (pos ? `<text x="${it.x.toFixed(2)}" y="${it.y.toFixed(2)}">${it.key}</text>` : '') +
        `</g>`;
    }
    this.el.innerHTML = svg;
  }
}
