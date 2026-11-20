import './style.css';
import { CancelledError, ModelLoader } from './loader';
import { loadSettings, saveSettings } from './settings';
import { $, esc, fmtInt, fmtSeconds, fmtSize } from './ui/dom';
import { InfoPanel } from './ui/info-panel';
import { AssemblyTree } from './ui/tree';
import { ExplodeTool, type ExplodeLevel } from './viewer/explode';
import { exportGLB, screenshot } from './viewer/export';
import { MeasureTool } from './viewer/measure';
import { Model, type DisplayMode, type NodeInfo } from './viewer/model';
import { buildBVHInBackground, pick } from './viewer/picking';
import { SectionTool, type Axis } from './viewer/section';
import { Viewer, type UpAxis, type ViewName } from './viewer/viewer';
import type { Stage } from './worker/protocol';

const STAGE_TEXT: Record<Stage | 'download' | 'build', string> = {
  download: '正在读取文件…',
  init: '正在加载解析引擎…',
  structure: '正在读取装配结构…',
  parse: '正在解析几何并生成网格（大文件可能需要数十秒）…',
  edges: '正在生成边线…',
  build: '正在构建场景…',
};

/** Rough progress per stage; the long OpenCascade stage advances with time against a size-based estimate. */
const STAGE_PROGRESS: Record<Stage | 'download' | 'build', number> = {
  download: 0.01,
  init: 0.03,
  structure: 0.06,
  parse: 0.1,
  edges: 0.92,
  build: 0.97,
};
const PARSE_MS_PER_MB = 650;

const VIEW_KEYS: Record<string, ViewName> = { '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '7': 'iso', '0': 'iso' };

class App {
  private readonly settings = loadSettings();
  private readonly viewer: Viewer;
  private readonly loader = new ModelLoader();
  private readonly tree: AssemblyTree;
  private readonly info: InfoPanel;
  private model: Model | null = null;
  private measure: MeasureTool | null = null;
  private section: SectionTool | null = null;
  private explode: ExplodeTool | null = null;
  private cancelBVH: (() => void) | null = null;
  private baseName = 'model';
  private loadTimer = 0;
  private toastTimer = 0;
  private hoverEvent: PointerEvent | null = null;
  private hoverQueued = false;
  private loadSize = 0;
  private loadStage: Stage | 'download' | 'build' = 'download';
  private stageStart = 0;

  private readonly el = {
    app: $('#app'),
    viewport: $('#viewport'),
    fileInput: $<HTMLInputElement>('#file-input'),
    empty: $('#empty-state'),
    drop: $('#drop-overlay'),
    loading: $('#loading'),
    loadingFile: $('#loading-file'),
    loadingStage: $('#loading-stage'),
    loadingTime: $('#loading-time'),
    progressBar: $('.progress-bar'),
    toast: $('#toast'),
    toastText: $('#toast-text'),
    measureHint: $('#measure-hint'),
    sectionPanel: $('#section-panel'),
    sectionRange: $<HTMLInputElement>('#section-range'),
    sectionValue: $<HTMLInputElement>('#section-value'),
    sectionFlip: $<HTMLInputElement>('#section-flip'),
    sectionShowPlane: $<HTMLInputElement>('#section-show-plane'),
    explodePanel: $('#explode-panel'),
    explodeRange: $<HTMLInputElement>('#explode-range'),
    explodeValue: $('#explode-value'),
    helpPanel: $('#help-panel'),
    upAxis: $<HTMLSelectElement>('#up-axis'),
    displayMode: $<HTMLSelectElement>('#display-mode'),
    search: $<HTMLInputElement>('#tree-search'),
    statusStats: $('#status-stats'),
    contextMenu: $('#context-menu'),
  };

  constructor() {
    this.viewer = new Viewer(this.el.viewport);
    this.viewer.setUpAxis(this.settings.upAxis);
    this.viewer.setProjection(this.settings.projection);
    this.viewer.onInteract = () => this.hideContextMenu();

    this.tree = new AssemblyTree($('#tree'), {
      select: (n) => this.select(n, 'tree'),
      focus: (n) => this.focus(n),
      toggleVisible: (n) => this.setVisible(n, !n.visible),
      context: (n, x, y) => this.showContextMenu(n, x, y),
    });
    this.info = new InfoPanel(
      { selection: $('#selection-info'), measureCard: $('#measure-card'), measure: $('#measure-info'), model: $('#model-info') },
      {
        hide: (n) => this.setVisible(n, !n.visible),
        isolate: (n) => this.isolate(n),
        transparent: (n) => this.toggleTransparent(n),
        focus: (n) => this.focus(n),
        select: (n) => this.select(n, 'panel'),
        removeMeasure: (id) => this.measure?.remove(id),
      },
    );

    this.bindToolbar();
    this.bindPanels();
    this.bindViewport();
    this.bindKeyboard();
    this.bindDragDrop();
    this.syncToolbar();
    void this.openFromUrl();
  }

  // ---------------------------------------------------------------------------
  // loading
  // ---------------------------------------------------------------------------

  private async openFile(file: File): Promise<void> {
    const t0 = performance.now();
    this.showLoading(file.name, file.size, t0);
    this.setStage('download');
    try {
      const buffer = await file.arrayBuffer();
      await this.openBuffer(file.name, buffer, t0);
    } catch (e) {
      this.hideLoading();
      this.showError(e);
    }
  }

  /** ?model=<url>&name=<file name> loads a model served over HTTP (handy for testing / links). */
  private async openFromUrl(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const url = params.get('model');
    if (!url) return;
    const name = params.get('name') || decodeURIComponent(url.split('?')[0].split('/').pop() || '') || 'model.step';
    const t0 = performance.now();
    this.showLoading(name, 0, t0);
    this.setStage('download');
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`无法下载模型（HTTP ${res.status}）`);
      await this.openBuffer(name, await res.arrayBuffer(), t0);
    } catch (e) {
      this.hideLoading();
      this.showError(e);
    }
  }

  private async openBuffer(name: string, buffer: ArrayBuffer, t0: number): Promise<void> {
    const size = buffer.byteLength;
    this.showLoading(name, size, t0);
    try {
      const result = await this.loader.load(name, buffer, (stage) => this.setStage(stage));
      this.setStage('build');
      await new Promise((r) => setTimeout(r, 0));
      const model = new Model(result, name);
      this.setModel(model, { fileSize: size, totalMs: performance.now() - t0 });
    } catch (e) {
      if (!(e instanceof CancelledError)) this.showError(e);
    } finally {
      this.hideLoading();
    }
  }

  private setModel(model: Model, extra: { fileSize: number; totalMs: number }): void {
    this.disposeModel();
    this.model = model;
    this.baseName = model.fileName.replace(/\.[^.]+$/, '') || 'model';
    this.viewer.scene.add(model.group);
    model.setDisplayMode(this.settings.displayMode);
    model.setColorByPart(this.settings.colorByPart);
    const box = model.boxOf(model.tree, false);
    this.viewer.setBounds(box);
    this.viewer.fit(box, this.viewer.viewDirection('iso'), false);

    this.measure = new MeasureTool(this.viewer, model);
    this.measure.onChange = () => this.info.showMeasure(this.measure);
    this.section = new SectionTool(this.viewer, model);
    this.explode = new ExplodeTool(model);

    this.tree.setModel(model);
    this.el.search.value = '';
    this.info.showSelection(model, null);
    this.info.showModel(model, extra);
    this.info.showMeasure(null);
    this.el.app.classList.remove('no-model');
    this.el.empty.hidden = true;
    document.title = `${model.fileName} - STEP 查看器`;
    this.el.statusStats.textContent = `${fmtInt(model.partCount())} 个零件 · ${fmtInt(model.stats.triangles)} 个三角面 · 解析 ${fmtSeconds(model.stats.parseMs)}`;
    this.cancelBVH = buildBVHInBackground(model);
    this.syncToolbar();
    this.viewer.requestRender();
    if (!this.settings.upAxisChosen) {
      this.showToast('提示：模型躺着或倒着时，可在工具栏「上方向」选择朝上的坐标轴，选择会被记住。', 'info', 9000);
    }
  }

  private disposeModel(): void {
    this.cancelBVH?.();
    this.cancelBVH = null;
    this.measure?.dispose();
    this.measure = null;
    this.section?.dispose();
    this.section = null;
    this.explode = null;
    this.model?.dispose();
    this.model = null;
    this.el.sectionPanel.hidden = true;
    this.el.explodePanel.hidden = true;
    this.el.measureHint.hidden = true;
    this.el.explodeRange.value = '0';
    this.el.explodeValue.textContent = '0%';
    this.el.viewport.classList.remove('measuring');
    this.tree.setModel(null);
  }

  private showLoading(name: string, size: number, t0: number): void {
    this.el.loading.hidden = false;
    this.el.loadingFile.textContent = size ? `${name}（${fmtSize(size)}）` : name;
    this.loadSize = size;
    window.clearInterval(this.loadTimer);
    const tick = () => {
      this.el.loadingTime.textContent = `已用 ${fmtSeconds(performance.now() - t0)}`;
      this.updateProgress();
    };
    tick();
    this.loadTimer = window.setInterval(tick, 250);
  }

  private setStage(stage: Stage | 'download' | 'build'): void {
    this.el.loadingStage.textContent = STAGE_TEXT[stage];
    this.loadStage = stage;
    this.stageStart = performance.now();
    this.updateProgress();
  }

  private updateProgress(): void {
    let p = STAGE_PROGRESS[this.loadStage];
    if (this.loadStage === 'parse') {
      const estimate = 1500 + (this.loadSize / 1e6) * PARSE_MS_PER_MB;
      p += (STAGE_PROGRESS.edges - p) * Math.min(0.95, (performance.now() - this.stageStart) / estimate);
    }
    this.el.progressBar.style.width = `${(p * 100).toFixed(1)}%`;
  }

  private hideLoading(): void {
    window.clearInterval(this.loadTimer);
    this.el.loading.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // toolbar & panels
  // ---------------------------------------------------------------------------

  private bindToolbar(): void {
    document.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('[data-action]');
      if (btn) this.runAction(btn.dataset.action!);
    });
    document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view as ViewName)));
    this.el.upAxis.addEventListener('change', () => this.setUpAxis(this.el.upAxis.value as UpAxis));
    this.el.displayMode.addEventListener('change', () => {
      this.settings.displayMode = this.el.displayMode.value as DisplayMode;
      saveSettings(this.settings);
      this.model?.setDisplayMode(this.settings.displayMode);
      this.viewer.requestRender();
    });
    this.el.fileInput.addEventListener('change', () => {
      const f = this.el.fileInput.files?.[0];
      this.el.fileInput.value = '';
      if (f) void this.openFile(f);
    });
    this.el.search.addEventListener('input', () => this.tree.setFilter(this.el.search.value));
  }

  private runAction(action: string): void {
    switch (action) {
      case 'open':
        this.el.fileInput.click();
        return;
      case 'fit':
        return this.fitAll();
      case 'projection':
        return this.toggleProjection();
      case 'color-by-part':
        return this.toggleColorByPart();
      case 'xray':
        return this.toggleXray();
      case 'measure':
        return this.toggleMeasure();
      case 'section':
        return this.toggleSection();
      case 'explode':
        return this.toggleExplode();
      case 'screenshot':
        void this.doScreenshot();
        return;
      case 'export-glb':
        void this.doExportGLB();
        return;
      case 'help':
        this.el.helpPanel.hidden = !this.el.helpPanel.hidden;
        return;
      case 'expand-all':
        return this.tree.expandAll(true);
      case 'collapse-all':
        return this.tree.expandAll(false);
      case 'show-all':
        return this.showAll();
      case 'cancel-load':
        return this.loader.cancel();
      case 'close-toast':
        return this.hideToast();
      case 'clear-measure':
        this.measure?.clear();
        return;
    }
  }

  private syncToolbar(): void {
    const set = (action: string, on: boolean) =>
      document.querySelectorAll(`.toolbar [data-action="${action}"]`).forEach((b) => b.classList.toggle('active', on));
    set('projection', this.viewer.projection === 'orthographic');
    set('color-by-part', this.settings.colorByPart);
    set('xray', !!this.model?.xray);
    set('measure', !!this.measure?.active);
    set('section', !!this.section?.enabled);
    set('explode', !this.el.explodePanel.hidden);
    this.el.upAxis.value = this.settings.upAxis;
    this.el.displayMode.value = this.settings.displayMode;
  }

  private bindPanels(): void {
    document.querySelectorAll<HTMLElement>('#section-axis [data-axis]').forEach((b) =>
      b.addEventListener('click', () => {
        this.section?.setAxis(b.dataset.axis as Axis);
        this.syncSectionPanel();
      }),
    );
    this.el.sectionRange.addEventListener('input', () => {
      const s = this.section;
      if (!s) return;
      s.setValue(s.min + ((s.max - s.min) * Number(this.el.sectionRange.value)) / 1000);
      this.el.sectionValue.value = s.value.toFixed(1);
    });
    this.el.sectionValue.addEventListener('change', () => {
      const v = Number(this.el.sectionValue.value);
      if (this.section && Number.isFinite(v)) this.section.setValue(v);
      this.syncSectionPanel();
    });
    this.el.sectionFlip.addEventListener('change', () => this.section?.setFlipped(this.el.sectionFlip.checked));
    this.el.sectionShowPlane.addEventListener('change', () => this.section?.setShowPlane(this.el.sectionShowPlane.checked));

    this.el.explodeRange.addEventListener('input', () => this.applyExplode());
    document.querySelectorAll<HTMLElement>('#explode-level [data-level]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!this.explode) return;
        this.explode.level = b.dataset.level as ExplodeLevel;
        this.applyExplode();
      }),
    );
  }

  private syncSectionPanel(): void {
    const s = this.section;
    if (!s) return;
    document.querySelectorAll<HTMLElement>('#section-axis [data-axis]').forEach((b) => b.classList.toggle('active', b.dataset.axis === s.axis));
    this.el.sectionRange.value = String(Math.round(((s.value - s.min) / (s.max - s.min || 1)) * 1000));
    this.el.sectionValue.value = s.value.toFixed(1);
    this.el.sectionFlip.checked = s.flipped;
    this.el.sectionShowPlane.checked = s.showPlane;
  }

  private applyExplode(): void {
    const ex = this.explode;
    const model = this.model;
    if (!ex || !model) return;
    const f = Number(this.el.explodeRange.value) / 100;
    ex.set(f, ex.level);
    this.el.explodeValue.textContent = `${Math.round(f * 100)}%`;
    document.querySelectorAll<HTMLElement>('#explode-level [data-level]').forEach((b) => b.classList.toggle('active', b.dataset.level === ex.level));
    this.viewer.setBounds(model.boxOf(model.tree, false));
    this.measure?.refresh();
    this.info.refreshSelection();
    this.viewer.requestRender();
  }

  // ---------------------------------------------------------------------------
  // view operations
  // ---------------------------------------------------------------------------

  private visibleBox() {
    const model = this.model!;
    const box = model.boxOf(model.tree, true);
    return box.isEmpty() ? model.boxOf(model.tree, false) : box;
  }

  private fitAll(): void {
    if (this.model) this.viewer.fit(this.visibleBox());
  }

  private setView(name: ViewName): void {
    if (this.model) this.viewer.fit(this.visibleBox(), this.viewer.viewDirection(name));
  }

  private focus(node: NodeInfo): void {
    const model = this.model;
    if (!model) return;
    let box = model.boxOf(node, true);
    if (box.isEmpty()) box = model.boxOf(node, false);
    this.viewer.fit(box);
  }

  private setUpAxis(axis: UpAxis): void {
    this.settings.upAxis = axis;
    this.settings.upAxisChosen = true;
    saveSettings(this.settings);
    this.viewer.setUpAxis(axis);
    if (this.model) this.setView('iso');
    this.syncToolbar();
  }

  private toggleProjection(): void {
    const p = this.viewer.projection === 'perspective' ? 'orthographic' : 'perspective';
    this.viewer.setProjection(p);
    this.settings.projection = p;
    saveSettings(this.settings);
    this.syncToolbar();
  }

  private toggleColorByPart(): void {
    this.settings.colorByPart = !this.settings.colorByPart;
    saveSettings(this.settings);
    this.model?.setColorByPart(this.settings.colorByPart);
    this.viewer.requestRender();
    this.syncToolbar();
  }

  private toggleXray(): void {
    if (!this.model) return;
    this.model.setXray(!this.model.xray);
    this.viewer.requestRender();
    this.syncToolbar();
  }

  private toggleMeasure(): void {
    const m = this.measure;
    if (!m || !this.model) return;
    m.setActive(!m.active);
    this.model.setHovered(null);
    this.el.viewport.classList.toggle('measuring', m.active);
    this.el.measureHint.hidden = !m.active;
    this.viewer.renderer.domElement.style.cursor = '';
    this.info.showMeasure(m);
    this.syncToolbar();
    this.viewer.requestRender();
  }

  private toggleSection(): void {
    const s = this.section;
    if (!s) return;
    s.setEnabled(!s.enabled);
    this.el.sectionPanel.hidden = !s.enabled;
    this.syncSectionPanel();
    this.syncToolbar();
  }

  private toggleExplode(): void {
    if (!this.explode) return;
    const open = this.el.explodePanel.hidden;
    this.el.explodePanel.hidden = !open;
    if (!open) {
      // leaving explode mode puts every part back
      this.el.explodeRange.value = '0';
    }
    this.applyExplode();
    this.syncToolbar();
  }

  // ---------------------------------------------------------------------------
  // selection, visibility
  // ---------------------------------------------------------------------------

  private select(node: NodeInfo | null, source: 'tree' | 'view' | 'panel'): void {
    const model = this.model;
    if (!model) return;
    model.setSelected(node);
    this.tree.refresh();
    if (node && source !== 'tree') this.tree.reveal(node);
    this.info.showSelection(model, node);
    this.viewer.requestRender();
  }

  private setVisible(node: NodeInfo, visible: boolean): void {
    const model = this.model;
    if (!model) return;
    model.setVisible(node, visible);
    if (!visible && model.hovered && model.isUnder(model.hovered, node)) model.setHovered(null);
    this.afterVisibilityChange();
  }

  private isolate(node: NodeInfo): void {
    if (!this.model) return;
    this.model.isolate(node);
    this.afterVisibilityChange();
  }

  private showAll(): void {
    if (!this.model) return;
    this.model.showAll();
    this.afterVisibilityChange();
  }

  private afterVisibilityChange(): void {
    this.tree.refresh();
    this.info.refreshSelection();
    this.measure?.clearHover();
    this.viewer.requestRender();
  }

  private toggleTransparent(node: NodeInfo): void {
    if (!this.model) return;
    this.model.setTransparent(node, !node.transparent);
    this.tree.refresh();
    this.info.refreshSelection();
    this.viewer.requestRender();
  }

  // ---------------------------------------------------------------------------
  // viewport input
  // ---------------------------------------------------------------------------

  private bindViewport(): void {
    const canvas = this.viewer.renderer.domElement;
    let down: { x: number; y: number; button: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button };
      this.hideContextMenu();
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      this.onCanvasClick(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons !== 0) return;
      this.hoverEvent = e;
      if (!this.hoverQueued) {
        this.hoverQueued = true;
        requestAnimationFrame(() => this.runHover());
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverEvent = null;
      if (this.model?.setHovered(null)) this.viewer.requestRender();
      this.measure?.clearHover();
    });
    canvas.addEventListener('dblclick', (e) => {
      if (!this.model) return;
      const hit = pick(this.viewer, this.model, e.clientX, e.clientY);
      if (hit) this.viewer.setOrbitCenter(hit.point);
    });
  }

  private runHover(): void {
    this.hoverQueued = false;
    const e = this.hoverEvent;
    const model = this.model;
    if (!e || !model) return;
    if (this.measure?.active) {
      this.measure.hover(e.clientX, e.clientY, e.shiftKey || e.altKey);
      return;
    }
    const hit = pick(this.viewer, model, e.clientX, e.clientY);
    if (model.setHovered(hit?.rec.node ?? null)) this.viewer.requestRender();
    this.viewer.renderer.domElement.style.cursor = hit ? 'pointer' : '';
  }

  private onCanvasClick(e: PointerEvent): void {
    const model = this.model;
    if (!model) return;
    if (this.measure?.active) {
      this.measure.click(e.clientX, e.clientY, e.shiftKey || e.altKey);
      return;
    }
    const hit = pick(this.viewer, model, e.clientX, e.clientY);
    this.select(hit ? hit.rec.node : null, 'view');
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('input, select, textarea')) {
        if (e.key === 'Escape') target.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        this.onEscape();
        return;
      }
      const model = this.model;
      if (!model) return;
      const sel = model.selected;
      if (VIEW_KEYS[e.key]) {
        this.setView(VIEW_KEYS[e.key]);
        e.preventDefault();
        return;
      }
      switch (e.key.toLowerCase()) {
        case 'f':
          this.fitAll();
          break;
        case 'z':
          if (sel) this.focus(sel);
          break;
        case 'h':
          if (e.shiftKey) this.showAll();
          else if (sel) this.setVisible(sel, !sel.visible);
          break;
        case 'i':
          if (sel) this.isolate(sel);
          break;
        case 't':
          if (sel) this.toggleTransparent(sel);
          break;
        case 'x':
          this.toggleXray();
          break;
        case 'p':
          this.toggleProjection();
          break;
        case 'm':
          this.toggleMeasure();
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  private onEscape(): void {
    this.hideContextMenu();
    if (!this.el.helpPanel.hidden) {
      this.el.helpPanel.hidden = true;
      return;
    }
    const m = this.measure;
    if (m?.active) {
      if (m.hasPending || m.info) m.cancelPending();
      else this.toggleMeasure();
      return;
    }
    if (this.model?.selected) this.select(null, 'view');
  }

  private bindDragDrop(): void {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      this.el.drop.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.el.drop.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.el.drop.hidden = true;
      const f = e.dataTransfer!.files[0];
      if (f) void this.openFile(f);
    });
  }

  // ---------------------------------------------------------------------------
  // context menu, toasts, export
  // ---------------------------------------------------------------------------

  private showContextMenu(node: NodeInfo, x: number, y: number): void {
    const menu = this.el.contextMenu;
    menu.innerHTML =
      `<button data-cm="focus">缩放至 <span class="muted">${esc(node.label)}</span></button>` +
      `<button data-cm="toggle">${node.visible ? '隐藏' : '显示'}</button>` +
      `<button data-cm="isolate">仅显示此项</button>` +
      `<button data-cm="transparent">${node.transparent ? '取消透明' : '设为透明'}</button>` +
      `<hr><button data-cm="show-all">全部显示</button>`;
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    menu.onclick = (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-cm]');
      if (!b) return;
      this.hideContextMenu();
      switch (b.dataset.cm) {
        case 'focus':
          return this.focus(node);
        case 'toggle':
          return this.setVisible(node, !node.visible);
        case 'isolate':
          return this.isolate(node);
        case 'transparent':
          return this.toggleTransparent(node);
        case 'show-all':
          return this.showAll();
      }
    };
    const close = (ev: PointerEvent) => {
      if (!menu.contains(ev.target as Node)) this.hideContextMenu();
    };
    setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
  }

  private hideContextMenu(): void {
    this.el.contextMenu.hidden = true;
  }

  private showError(e: unknown): void {
    console.error(e);
    this.showToast(e instanceof Error ? e.message : String(e), 'error');
  }

  private showToast(message: string, kind: 'error' | 'info', timeout = 0): void {
    this.el.toastText.textContent = message;
    this.el.toast.classList.toggle('info', kind === 'info');
    this.el.toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    if (timeout) this.toastTimer = window.setTimeout(() => this.hideToast(), timeout);
  }

  private hideToast(): void {
    this.el.toast.hidden = true;
  }

  private async doScreenshot(): Promise<void> {
    if (!this.model) return;
    try {
      await screenshot(this.viewer, this.baseName);
      this.showToast('截图已开始下载（PNG）', 'info', 2500);
    } catch (e) {
      this.showError(e);
    }
  }

  private async doExportGLB(): Promise<void> {
    if (!this.model) return;
    this.showToast('正在导出 GLB…', 'info');
    try {
      await exportGLB(this.model, this.viewer, this.baseName);
      this.showToast('GLB 已开始下载（单位：米，可见零件，含当前颜色与爆炸状态）', 'info', 3500);
    } catch (e) {
      this.showError(e);
    }
  }
}

const app = new App();
// ?debug exposes internals for automated UI tests
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, { stepViewer: app, stepViewerPick: (x: number, y: number) => pick(app['viewer'], app['model']!, x, y) });
}
