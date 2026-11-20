import * as THREE from 'three';
import type { MeasureTool } from '../viewer/measure';
import type { Model, NodeInfo } from '../viewer/model';
import { ICONS, esc, fmt, fmtInt, fmtSeconds, fmtSize } from './dom';

export interface InfoActions {
  hide(node: NodeInfo): void;
  isolate(node: NodeInfo): void;
  transparent(node: NodeInfo): void;
  focus(node: NodeInfo): void;
  select(node: NodeInfo): void;
  removeMeasure(id: number): void;
}

const vec = (v: THREE.Vector3, d = 2) => `${fmt(v.x, d)}, ${fmt(v.y, d)}, ${fmt(v.z, d)}`;
const size = (box: THREE.Box3) => {
  const s = box.getSize(new THREE.Vector3());
  return `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm`;
};

/** Right-hand panel: selection details, measurement results, model statistics. */
export class InfoPanel {
  private model: Model | null = null;
  private node: NodeInfo | null = null;

  constructor(
    private readonly els: { selection: HTMLElement; measureCard: HTMLElement; measure: HTMLElement; model: HTMLElement },
    actions: InfoActions,
  ) {
    els.selection.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
      const node = this.node;
      if (!btn || !node) return;
      switch (btn.dataset.act) {
        case 'hide':
          return actions.hide(node);
        case 'isolate':
          return actions.isolate(node);
        case 'transparent':
          return actions.transparent(node);
        case 'focus':
          return actions.focus(node);
        case 'parent':
          if (node.parent) actions.select(node.parent);
          return;
      }
    });
    els.measure.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('[data-remove]');
      if (btn) actions.removeMeasure(Number(btn.dataset.remove));
    });
  }

  showSelection(model: Model | null, node: NodeInfo | null): void {
    this.model = model;
    this.node = node;
    const el = this.els.selection;
    if (!model || !node) {
      el.innerHTML = '<p class="muted">在模型或装配结构中单击零件。</p>';
      return;
    }
    const isAsm = node.children.length > 0;
    const kind = isAsm
      ? `装配体（${model.partCount(node)} 个零件）`
      : `零件${node.meshes.length > 1 ? `（${node.meshes.length} 个实体）` : ''}`;
    const box = model.boxOf(node, false);
    const path = model
      .pathOf(node)
      .slice(0, -1)
      .map((n) => esc(n.label))
      .join(' › ');
    el.innerHTML =
      `<div class="title">${esc(node.label)}</div>` +
      `<dl>` +
      `<dt>类型</dt><dd>${kind}</dd>` +
      (box.isEmpty() ? '' : `<dt>外形尺寸</dt><dd>${size(box)}<div class="muted">X × Y × Z（包围盒）</div></dd>`) +
      `<dt>三角面</dt><dd>${fmtInt(model.triangleCount(node))}</dd>` +
      (node.name !== node.label.replace(/ <\d+>$/, '') ? `<dt>完整名称</dt><dd>${esc(node.name)}</dd>` : '') +
      (path ? `<dt>位置</dt><dd class="path">${path}</dd>` : '') +
      `</dl>` +
      `<div class="actions">` +
      `<button class="btn" data-act="focus">缩放至</button>` +
      `<button class="btn" data-act="hide">${node.visible ? '隐藏' : '显示'}</button>` +
      `<button class="btn" data-act="isolate">仅显示</button>` +
      `<button class="btn" data-act="transparent">${node.transparent ? '取消透明' : '透明'}</button>` +
      (node.parent ? `<button class="btn" data-act="parent">选择上级</button>` : '') +
      `</div>`;
  }

  refreshSelection(): void {
    this.showSelection(this.model, this.node);
  }

  showMeasure(tool: MeasureTool | null): void {
    const card = this.els.measureCard;
    if (!tool || (!tool.active && tool.results.length === 0)) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    let html = '';
    const info = tool.info;
    if (info?.kind === 'face') {
      html +=
        `<div class="face-report"><dl>` +
        `<dt>面</dt><dd>${esc(info.part)}</dd>` +
        `<dt>面积</dt><dd><span class="big-num">${fmt(info.area)}</span> mm²</dd>` +
        `<dt>周长</dt><dd>${fmt(info.perimeter)} mm</dd>` +
        `<dt>类型</dt><dd>${info.normal ? `平面，法向 (${vec(info.normal, 3)})` : '曲面（面积为网格近似值）'}</dd>` +
        `</dl></div>`;
    } else if (info?.kind === 'circle') {
      html +=
        `<div class="face-report"><dl>` +
        `<dt>${info.full ? '圆' : '圆弧'}</dt><dd>${esc(info.part)}</dd>` +
        `<dt>${info.full ? '直径' : '半径'}</dt><dd><span class="big-num">${info.full ? 'Ø ' : 'R '}${fmt(info.full ? info.diameter : info.diameter / 2)}</span> mm</dd>` +
        `<dt>圆心</dt><dd>${vec(info.center)}</dd>` +
        `</dl></div>`;
    }
    if (tool.hasPending) html += `<p class="muted" style="margin-top:6px">已选第 1 点，点击第 2 点测量距离。</p>`;
    else if (!info && tool.results.length === 0) html += `<p class="muted">点击模型表面开始测量。</p>`;
    for (const r of [...tool.results].reverse()) {
      html +=
        `<div class="measure-item">` +
        `<button class="icon-btn del" data-remove="${r.id}" title="删除">${ICONS.close}</button>` +
        `<div>距离 <span class="big-num">${fmt(r.distance)}</span> mm</div>` +
        `<div class="sub">ΔX ${fmt(r.delta.x)} · ΔY ${fmt(r.delta.y)} · ΔZ ${fmt(r.delta.z)}</div>` +
        (r.planeDistance !== null ? `<div class="perp">平行平面间距 ${fmt(r.planeDistance)} mm</div>` : '') +
        `<div class="sub muted">${esc(r.from)} → ${esc(r.to)}</div>` +
        `</div>`;
    }
    this.els.measure.innerHTML = html;
  }

  showModel(model: Model | null, extra?: { fileSize: number; totalMs: number }): void {
    const el = this.els.model;
    if (!model) {
      el.innerHTML = '<p class="muted">尚未打开文件。</p>';
      return;
    }
    const s = model.stats;
    const box = model.boxOf(model.tree, false);
    let notice = '';
    if (s.format === 'step' && s.hierarchy !== 'step') {
      notice = `<div class="notice">${
        s.hierarchy === 'partial' ? '部分子装配无法还原层级，' : '未能还原完整装配层级，'
      }这些部分按 OpenCascade 的简化结构显示（不影响几何与测量）。</div>`;
    }
    el.innerHTML =
      `<dl>` +
      `<dt>文件</dt><dd>${esc(model.fileName)}</dd>` +
      (extra ? `<dt>大小</dt><dd>${fmtSize(extra.fileSize)}</dd>` : '') +
      `<dt>格式</dt><dd>${s.format.toUpperCase()}</dd>` +
      `<dt>零件 / 实体</dt><dd>${fmtInt(model.partCount())} / ${fmtInt(s.meshCount)}</dd>` +
      `<dt>三角面</dt><dd>${fmtInt(s.triangles)}</dd>` +
      `<dt>总尺寸</dt><dd>${size(box)}</dd>` +
      (extra ? `<dt>加载耗时</dt><dd>${fmtSeconds(extra.totalMs)}（几何解析 ${fmtSeconds(s.parseMs)}）</dd>` : '') +
      `</dl>${notice}`;
  }
}
