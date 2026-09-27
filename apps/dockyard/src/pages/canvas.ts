/**
 * 画布客户端只剩「无法声明式」的部分，全部封装在 Web Component 里：
 * - <dy-card>：自由坐标拖拽/resize（pointer capture），结束时 PATCH 持久化；
 *   拖拽期间置 data-dragging，htmx:beforeSwap 取消该次 morph，防止位置回弹
 * - 右键菜单：菜单项本身仍是声明式的（hx-get/hx-post/hx-delete），
 *   这里只负责定位、挂载、htmx.process 激活
 * 渲染与数据流已全部上移到服务端片段（canvas.ui.tsx）+ morph 轮询。
 */
interface Htmx {
  ajax(verb: string, url: string, opts: { target: string; swap: string }): void;
  process(elt: Element): void;
}
declare const htmx: Htmx;

// ── <dy-card>：拖拽/resize 隔离单元 ──
class DyCard extends HTMLElement {
  connectedCallback() {
    this.addEventListener("pointerdown", this.onPointerDown);
  }
  disconnectedCallback() {
    this.removeEventListener("pointerdown", this.onPointerDown);
  }

  private onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, a")) return;
    const resize = target.closest("[data-resize-handle]");
    const drag = target.closest("[data-drag-handle]");
    if (!resize && !drag) return;

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = {
      left: parseFloat(this.style.left),
      top: parseFloat(this.style.top),
      w: this.offsetWidth,
      h: this.offsetHeight,
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (dx === 0 && dy === 0) return;
      this.setAttribute("data-dragging", ""); // morph 轮询见此标记跳过本次 swap
      if (resize) {
        this.style.width = `${Math.max(220, orig.w + dx)}px`;
        this.style.height = `${Math.max(150, orig.h + dy)}px`;
      } else {
        this.style.left = `${orig.left + dx}px`;
        this.style.top = `${orig.top + dy}px`;
      }
    };
    const onUp = async (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (dx === 0 && dy === 0) return;
      const patch = resize
        ? { w: this.offsetWidth, h: this.offsetHeight }
        : { x: Math.round(orig.left + dx), y: Math.round(orig.top + dy) };
      // PATCH 落地后再放行 morph，避免服务器旧坐标回弹
      await fetch(`/api/canvas/nodes/${this.dataset.nodeId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      this.removeAttribute("data-dragging");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };
}
customElements.define("dy-card", DyCard);

// 拖拽/resize 进行中：取消该次 morph swap（下一次轮询自然补上）
document.addEventListener("htmx:beforeSwap", (e) => {
  const target = (e as CustomEvent).detail?.target as Element | undefined;
  if (target?.id === "canvas-root" && document.querySelector("dy-card[data-dragging]")) {
    e.preventDefault();
  }
});

// ── 右键菜单（动态定位的壳，菜单项是声明式 hx-* 按钮）──
let menuEl: HTMLDivElement | null = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
interface MenuItem {
  attrs: string;
  label: string;
  danger?: boolean;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function openMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "dy-menu fixed z-50 min-w-40 rounded border border-harbor-700 bg-harbor-900 py-1 shadow-2xl";
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  const itemCls = "block w-full px-3 py-1.5 text-left text-sm hover:bg-harbor-800";
  menuEl.innerHTML = items
    .map(({ attrs, label, danger }) => `<button class="${itemCls} ${danger ? "text-signal-500" : "text-neutral-200"}" ${attrs}>${esc(label)}</button>`)
    .join("");
  document.body.appendChild(menuEl);
  htmx.process(menuEl); // 动态插入的 hx-* 需要激活
}

document.addEventListener("click", (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
// 菜单项触发请求后菜单即可关闭（请求由 htmx 继续）
document.addEventListener("htmx:beforeRequest", (e) => {
  if (menuEl?.contains((e as CustomEvent).detail?.elt as Node)) closeMenu();
});

document.addEventListener("contextmenu", (e) => {
  const root = document.getElementById("canvas-root");
  if (!root || !root.contains(e.target as Node)) return;
  e.preventDefault();

  const card = (e.target as HTMLElement).closest<HTMLElement>("dy-card");
  if (card) {
    const nodeId = card.dataset.nodeId;
    openMenu(e.clientX, e.clientY, [
      { label: "部署 app", attrs: `hx-get="/api/deploy/ui/new-app/${nodeId}" hx-target="#modal-root"` },
      { label: "部署数据库", attrs: `hx-get="/api/deploy/ui/new-db/${nodeId}" hx-target="#modal-root"` },
      { label: "移除卡片", danger: true, attrs: `hx-delete="/api/canvas/nodes/${nodeId}" hx-swap="none" hx-confirm="移除这张卡片？（服务器与部署目标不动）"` },
    ]);
    return;
  }

  // 空白处：添加服务器卡片（坐标在菜单创建时定死，hx-vals 直接带上）
  const serversEl = document.getElementById("canvas-servers");
  const servers = serversEl ? (JSON.parse(serversEl.textContent ?? "[]") as { id: number; name: string }[]) : [];
  if (servers.length === 0) return;
  const rect = root.getBoundingClientRect();
  const x = Math.round(e.clientX - rect.left + root.scrollLeft);
  const y = Math.round(e.clientY - rect.top + root.scrollTop);
  openMenu(
    e.clientX,
    e.clientY,
    servers.map((s) => ({
      label: `＋ ${s.name}`,
      attrs: `hx-post="/api/canvas/projects/${root.dataset.projectId}/nodes" hx-vals='${JSON.stringify({ serverId: s.id, x, y })}' hx-swap="none"`,
    })),
  );
});
