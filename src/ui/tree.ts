import type { Model, NodeInfo } from '../viewer/model';
import { ICONS, esc } from './dom';

export interface TreeEvents {
  select(node: NodeInfo): void;
  focus(node: NodeInfo): void;
  toggleVisible(node: NodeInfo): void;
  context(node: NodeInfo, x: number, y: number): void;
}

/** Assembly tree with visibility toggles, search and selection sync. */
export class AssemblyTree {
  private model: Model | null = null;
  private readonly rows = new Map<number, HTMLElement>();
  private readonly boxes = new Map<number, HTMLElement>();
  private readonly expanded = new Set<number>();
  private query = '';

  constructor(
    private readonly el: HTMLElement,
    private readonly events: TreeEvents,
  ) {
    el.addEventListener('click', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.tree-row');
      const node = row && this.nodeOf(row);
      if (!node) return;
      if ((e.target as Element).closest('.caret')) this.toggle(node);
      else if ((e.target as Element).closest('.eye')) this.events.toggleVisible(node);
      else this.events.select(node);
    });
    el.addEventListener('dblclick', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.tree-row');
      const node = row && this.nodeOf(row);
      if (node && !(e.target as Element).closest('.caret, .eye')) this.events.focus(node);
    });
    el.addEventListener('contextmenu', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.tree-row');
      const node = row && this.nodeOf(row);
      if (!node) return;
      e.preventDefault();
      this.events.select(node);
      this.events.context(node, e.clientX, e.clientY);
    });
  }

  private nodeOf(row: HTMLElement): NodeInfo | undefined {
    return this.model?.nodes[Number(row.dataset.id)];
  }

  setModel(model: Model | null): void {
    this.model = model;
    this.el.innerHTML = '';
    this.rows.clear();
    this.boxes.clear();
    this.expanded.clear();
    this.query = '';
    if (!model) return;
    // open the first levels so the top components are visible right away
    for (const n of model.nodes) if (n.depth < 1 || (n.depth < 2 && n.parent?.children.length === 1)) this.expanded.add(n.id);
    const frag = document.createDocumentFragment();
    this.buildRow(model.tree, frag);
    this.el.appendChild(frag);
    this.refresh();
  }

  private buildRow(node: NodeInfo, parent: DocumentFragment | HTMLElement): void {
    const model = this.model!;
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.id = String(node.id);
    row.setAttribute('role', 'treeitem');
    row.style.paddingLeft = `${4 + node.depth * 14}px`;
    const isAsm = node.children.length > 0;
    const badge = isAsm ? `<span class="badge" title="包含的零件数">${model.partCount(node)}</span>` : '';
    row.title = node.name;
    row.innerHTML =
      `<span class="caret${isAsm ? '' : ' empty'}">${ICONS.caret}</span>` +
      `<button class="eye" title="显示 / 隐藏">${ICONS.eye}</button>` +
      (isAsm ? ICONS.asm : ICONS.part) +
      `<span class="name">${esc(node.label)}</span>${badge}`;
    parent.appendChild(row);
    this.rows.set(node.id, row);
    if (isAsm) {
      const box = document.createElement('div');
      box.className = 'tree-children';
      box.setAttribute('role', 'group');
      for (const c of node.children) this.buildRow(c, box);
      parent.appendChild(box);
      this.boxes.set(node.id, box);
    }
  }

  private toggle(node: NodeInfo): void {
    if (this.expanded.has(node.id)) this.expanded.delete(node.id);
    else this.expanded.add(node.id);
    this.applyExpansion();
  }

  expandAll(open: boolean): void {
    if (!this.model) return;
    this.expanded.clear();
    if (open) {
      for (const n of this.model.nodes) if (n.children.length) this.expanded.add(n.id);
    } else {
      this.expanded.add(this.model.tree.id);
    }
    this.applyExpansion();
  }

  private applyExpansion(): void {
    for (const [id, box] of this.boxes) {
      const open = this.expanded.has(id) || this.query !== '';
      box.classList.toggle('collapsed', !open);
      this.rows.get(id)!.classList.toggle('expanded', open);
    }
  }

  /** Update visibility / transparency / selection states. */
  refresh(): void {
    const model = this.model;
    if (!model) return;
    for (const node of model.nodes) {
      const row = this.rows.get(node.id)!;
      const shown = model.isShown(node);
      row.classList.toggle('selected', model.selected === node);
      row.classList.toggle('is-hidden', !node.visible);
      row.classList.toggle('ancestor-hidden', node.visible && !shown);
      row.classList.toggle('transparent', node.transparent);
      const vis = node.visible ? '1' : '0';
      if (row.dataset.vis !== vis) {
        row.dataset.vis = vis;
        row.querySelector('.eye')!.innerHTML = node.visible ? ICONS.eye : ICONS.eyeOff;
      }
    }
    this.applyExpansion();
  }

  /** Expand the ancestors of `node` and scroll it into view. */
  reveal(node: NodeInfo): void {
    for (let n = node.parent; n; n = n.parent) this.expanded.add(n.id);
    this.applyExpansion();
    this.rows.get(node.id)?.scrollIntoView({ block: 'nearest' });
  }

  setFilter(query: string): void {
    const model = this.model;
    if (!model) return;
    this.query = query.trim().toLowerCase();
    const keep = new Set<number>();
    if (this.query) {
      for (const n of model.nodes) {
        if (n.label.toLowerCase().includes(this.query) || n.name.toLowerCase().includes(this.query)) {
          for (let p: NodeInfo | null = n; p && !keep.has(p.id); p = p.parent) keep.add(p.id);
        }
      }
    }
    for (const n of model.nodes) {
      const row = this.rows.get(n.id)!;
      row.hidden = this.query !== '' && !keep.has(n.id);
      const nameEl = row.querySelector('.name')!;
      const idx = this.query ? n.label.toLowerCase().indexOf(this.query) : -1;
      nameEl.innerHTML =
        idx >= 0
          ? `${esc(n.label.slice(0, idx))}<mark>${esc(n.label.slice(idx, idx + this.query.length))}</mark>${esc(n.label.slice(idx + this.query.length))}`
          : esc(n.label);
    }
    this.applyExpansion();
  }
}
