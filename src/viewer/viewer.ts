import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { AxisGizmo } from './gizmo';

export type UpAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';
export type Projection = 'perspective' | 'orthographic';
type Cam = THREE.PerspectiveCamera | THREE.OrthographicCamera;

const AXIS_VEC: Record<UpAxis, [number, number, number]> = {
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
};
/** "Front" direction for each up axis; right = up × front keeps a right-handed frame. */
const FRONT_OF: Record<UpAxis, [number, number, number]> = {
  '+Y': [0, 0, 1],
  '-Y': [0, 0, -1],
  '+Z': [0, -1, 0],
  '-Z': [0, 1, 0],
  '+X': [0, 0, -1],
  '-X': [0, 0, 1],
};

export const upVector = (axis: UpAxis) => new THREE.Vector3(...AXIS_VEC[axis]);

interface CameraAnimation {
  start: number;
  duration: number;
  fromDir: THREE.Vector3;
  rot: THREE.Quaternion;
  fromLen: number;
  toLen: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromZoom: number;
  toZoom: number;
}

const FOV = 35;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** helpers that are not part of the model (measurements, section outline) */
  readonly overlay = new THREE.Group();
  readonly labelRenderer: CSS2DRenderer;
  readonly perspCamera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  camera: Cam;
  controls!: OrbitControls;
  upAxis: UpAxis = '+Y';
  /** called before every rendered frame */
  readonly beforeRender = new Set<() => void>();
  /** called when the user starts dragging / zooming */
  onInteract: () => void = () => {};

  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.35);
  private readonly gizmo: AxisGizmo;
  private readonly bounds = new THREE.Sphere(new THREE.Vector3(), 100);
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private orthoHeight = 200;
  private dirty = true;
  private anim: CameraAnimation | null = null;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.classList.add('label-layer');
    container.appendChild(this.labelRenderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();

    this.perspCamera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1e5);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1e5);
    this.camera = this.perspCamera;
    this.scene.add(this.perspCamera, this.orthoCamera, this.overlay);
    this.headlight.position.set(0.35, 0.6, 1);
    this.attachHeadlight();

    this.gizmo = new AxisGizmo(container, (dir) => this.lookFrom(dir));
    this.createControls(new THREE.Vector3());
    this.perspCamera.position.set(300, 200, 300);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.loop);
  }

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------

  requestRender(): void {
    this.dirty = true;
  }

  private readonly loop = (time: number) => {
    if (this.anim) this.stepAnimation(time);
    if (!this.dirty) return;
    this.dirty = false;
    for (const f of this.beforeRender) f();
    this.updateClipping();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    this.gizmo.update(this.camera);
  };

  /** Render immediately (used for screenshots so the drawing buffer is fresh). */
  renderNow(): void {
    for (const f of this.beforeRender) f();
    this.updateClipping();
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  private aspect(): number {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  private updateOrthoFrustum(): void {
    const half = this.orthoHeight / 2;
    const a = this.aspect();
    this.orthoCamera.top = half;
    this.orthoCamera.bottom = -half;
    this.orthoCamera.left = -half * a;
    this.orthoCamera.right = half * a;
    this.orthoCamera.updateProjectionMatrix();
  }

  /** Keep near/far tight around the model for good depth precision at any zoom level. */
  private updateClipping(): void {
    const cam = this.camera;
    const r = Math.max(this.bounds.radius, 1e-3);
    const toCenter = cam.position.distanceTo(this.bounds.center);
    const toTarget = cam.position.distanceTo(this.controls.target);
    if (cam instanceof THREE.PerspectiveCamera) {
      let near = toTarget / 60;
      if (toCenter > r * 1.05) near = Math.max(near, toCenter - r * 1.05);
      cam.near = Math.max(near, r * 1e-5);
      cam.far = toCenter + r * 1.5;
    } else {
      cam.near = Math.max(1e-3, toCenter - r * 1.5);
      cam.far = toCenter + r * 1.5;
    }
    cam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------------
  // camera & controls
  // ---------------------------------------------------------------------------

  private attachHeadlight(): void {
    this.headlight.removeFromParent();
    this.headlight.target.removeFromParent();
    this.camera.add(this.headlight);
    this.camera.add(this.headlight.target);
  }

  private createControls(target: THREE.Vector3): void {
    this.controls?.dispose();
    this.perspCamera.up.copy(upVector(this.upAxis));
    this.orthoCamera.up.copy(upVector(this.upAxis));
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.target.copy(target);
    c.zoomToCursor = true;
    c.screenSpacePanning = true;
    c.rotateSpeed = 0.9;
    c.zoomSpeed = 1.6;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    c.minZoom = 1e-3;
    c.maxZoom = 1e5;
    c.addEventListener('change', () => this.requestRender());
    c.addEventListener('start', () => {
      this.anim = null;
      this.onInteract();
    });
    this.controls = c;
    this.applyDistanceLimits();
    c.update();
  }

  private applyDistanceLimits(): void {
    const r = Math.max(this.bounds.radius, 1e-3);
    this.controls.minDistance = r * 1e-4;
    this.controls.maxDistance = r * 60;
  }

  /** Model bounds drive clipping planes, zoom limits and fitting. */
  setBounds(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    box.getBoundingSphere(this.bounds);
    this.applyDistanceLimits();
    this.requestRender();
  }

  get projection(): Projection {
    return this.camera instanceof THREE.PerspectiveCamera ? 'perspective' : 'orthographic';
  }

  setProjection(p: Projection): void {
    if (p === this.projection) return;
    this.anim = null;
    const target = this.controls.target.clone();
    const dir = this.camera.position.clone().sub(target).normalize();
    const halfFov = THREE.MathUtils.degToRad(FOV) / 2;
    if (p === 'orthographic') {
      const d = this.perspCamera.position.distanceTo(target);
      this.orthoHeight = 2 * d * Math.tan(halfFov);
      this.orthoCamera.zoom = 1;
      this.updateOrthoFrustum();
      const dist = Math.max(d, this.bounds.radius * 4);
      this.orthoCamera.position.copy(target).addScaledVector(dir, dist);
      this.orthoCamera.quaternion.copy(this.perspCamera.quaternion);
      this.camera = this.orthoCamera;
    } else {
      const visible = this.orthoHeight / this.orthoCamera.zoom;
      const d = visible / (2 * Math.tan(halfFov));
      this.perspCamera.position.copy(target).addScaledVector(dir, d);
      this.perspCamera.quaternion.copy(this.orthoCamera.quaternion);
      this.camera = this.perspCamera;
    }
    this.attachHeadlight();
    this.createControls(target);
    this.requestRender();
  }

  setUpAxis(axis: UpAxis): void {
    this.upAxis = axis;
    this.anim = null;
    this.createControls(this.controls.target.clone());
  }

  viewDirection(name: ViewName): THREE.Vector3 {
    const up = upVector(this.upAxis);
    const front = new THREE.Vector3(...FRONT_OF[this.upAxis]);
    const right = new THREE.Vector3().crossVectors(up, front);
    switch (name) {
      case 'front':
        return front;
      case 'back':
        return front.negate();
      case 'right':
        return right;
      case 'left':
        return right.negate();
      case 'top':
        return up.addScaledVector(front, 1e-3).normalize();
      case 'bottom':
        return up.negate().addScaledVector(front, 1e-3).normalize();
      case 'iso':
        return front.add(right).add(up).normalize();
    }
  }

  /** Camera direction (from target towards camera). */
  currentDirection(): THREE.Vector3 {
    return this.camera.position.clone().sub(this.controls.target).normalize();
  }

  /** Fit `box` into the view, looking from `direction` (default: current direction). */
  fit(box: THREE.Box3, direction?: THREE.Vector3, animate = true): void {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    const dir = (direction ?? this.currentDirection()).clone().normalize();
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const vFov = THREE.MathUtils.degToRad(FOV);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.aspect());
      const d = (r / Math.sin(Math.min(vFov, hFov) / 2)) * 1.04;
      this.animateTo(sphere.center.clone().addScaledVector(dir, d), sphere.center, undefined, animate);
    } else {
      const need = 2 * r * 1.08 * Math.max(1, 1 / this.aspect());
      const d = Math.max(this.bounds.radius, r) * 4;
      this.animateTo(sphere.center.clone().addScaledVector(dir, d), sphere.center, this.orthoHeight / need, animate);
    }
  }

  /** Look at the current target from `dir`, keeping the distance (axis gizmo). */
  lookFrom(dir: THREE.Vector3): void {
    const up = upVector(this.upAxis);
    const d = dir.clone().normalize();
    if (Math.abs(d.dot(up)) > 0.999) d.addScaledVector(new THREE.Vector3(...FRONT_OF[this.upAxis]), 1e-3).normalize();
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.animateTo(this.controls.target.clone().addScaledVector(d, dist), this.controls.target.clone(), undefined, true);
  }

  /** Make `point` the orbit center without moving the view direction (double-click). */
  setOrbitCenter(point: THREE.Vector3): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.animateTo(point.clone().add(offset), point, undefined, true);
  }

  private animateTo(pos: THREE.Vector3, target: THREE.Vector3, zoom: number | undefined, animate: boolean): void {
    const cam = this.camera;
    const fromOffset = cam.position.clone().sub(this.controls.target);
    const toOffset = pos.clone().sub(target);
    const fromLen = fromOffset.length() || 1;
    const toLen = toOffset.length() || 1;
    const fromDir = fromOffset.normalize();
    const toDir = toOffset.normalize();
    const anim: CameraAnimation = {
      start: performance.now(),
      duration: animate ? 380 : 0,
      fromDir,
      rot: new THREE.Quaternion().setFromUnitVectors(fromDir, toDir),
      fromLen,
      toLen,
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      fromZoom: cam.zoom,
      toZoom: zoom ?? cam.zoom,
    };
    this.anim = anim;
    if (!animate) this.stepAnimation(anim.start + 1);
    this.requestRender();
  }

  private stepAnimation(now: number): void {
    const a = this.anim!;
    const t = a.duration > 0 ? Math.min(1, (now - a.start) / a.duration) : 1;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const q = new THREE.Quaternion().slerp(a.rot, e);
    const dir = a.fromDir.clone().applyQuaternion(q);
    const target = a.fromTarget.clone().lerp(a.toTarget, e);
    const len = a.fromLen + (a.toLen - a.fromLen) * e;
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, len);
    this.camera.zoom = a.fromZoom + (a.toZoom - a.fromZoom) * e;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
    if (t >= 1) this.anim = null;
  }

  // ---------------------------------------------------------------------------
  // picking helpers
  // ---------------------------------------------------------------------------

  raycasterAt(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  /** World units covered by one CSS pixel at `point`. */
  worldPerPixel(point: THREE.Vector3): number {
    const h = Math.max(1, this.renderer.domElement.clientHeight);
    const cam = this.camera;
    if (cam instanceof THREE.PerspectiveCamera) {
      const forward = cam.getWorldDirection(new THREE.Vector3());
      const depth = Math.max(point.clone().sub(cam.position).dot(forward), cam.near);
      return (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / h;
    }
    return (cam.top - cam.bottom) / cam.zoom / h;
  }

  /** CSS-pixel position of a world point inside the viewport, or null when behind the camera. */
  toScreen(point: THREE.Vector3): { x: number; y: number } | null {
    const v = point.clone().project(this.camera);
    if (v.z < -1 || v.z > 1) return null;
    const el = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
