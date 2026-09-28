/** @jsxImportSource react */
/**
 * 画布 React 岛的挂载器：模块脚本随 index.html 全程存活，
 * 壳（canvas.ui.tsx 的 #canvas-island）随 htmx 片段进出 #main——afterSwap 后同步挂载/卸载。
 * Console 终端挂点在抽屉片段里（data-console-target），抽屉被 .remove() 时不触发 htmx 事件，
 * 所以用 MutationObserver 兜底卸载，防 WebSocket / exec 流泄漏。
 */
import { createRoot, type Root } from "react-dom/client";
import { Board } from "./board";
import { ConsoleView } from "./console";

let root: Root | null = null;
let mounted: Element | null = null;

const consoleRoots = new Map<Element, Root>();

function syncIsland() {
  const el = document.getElementById("canvas-island");
  if (el !== mounted) {
    root?.unmount();
    root = null;
    mounted = null;
    if (el) {
      root = createRoot(el);
      root.render(<Board projectId={Number(el.dataset["projectId"])} />);
      mounted = el;
    }
  }
  syncConsoles();
}

function syncConsoles() {
  // 卸载已不在文档里的终端（抽屉关闭）
  for (const [el, r] of consoleRoots) {
    if (!el.isConnected) {
      r.unmount();
      consoleRoots.delete(el);
    }
  }
  // 挂载新出现的终端挂点
  for (const el of document.querySelectorAll("[data-console-target]")) {
    if (consoleRoots.has(el)) continue;
    const r = createRoot(el);
    r.render(
      <ConsoleView
        targetId={Number((el as HTMLElement).dataset["consoleTarget"])}
        service={(el as HTMLElement).dataset["consoleService"] || undefined}
      />,
    );
    consoleRoots.set(el, r);
  }
}

document.addEventListener("htmx:afterSwap", syncIsland);
// 抽屉/弹窗被 htmx 之外的方式移除（点遮罩 .remove()）时也要清理
new MutationObserver(() => syncConsoles()).observe(document.body, { childList: true, subtree: true });
syncIsland();
