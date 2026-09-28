/** @jsxImportSource react */
/**
 * 画布 React 岛的挂载器：模块脚本随 index.html 全程存活，
 * 壳（canvas.ui.tsx 的 #canvas-island）随 htmx 片段进出 #main——afterSwap 后同步挂载/卸载。
 */
import { createRoot, type Root } from "react-dom/client";
import { Board } from "./board";

let root: Root | null = null;
let mounted: Element | null = null;

function syncIsland() {
  const el = document.getElementById("canvas-island");
  if (el === mounted) return;
  root?.unmount();
  root = null;
  mounted = null;
  if (el) {
    root = createRoot(el);
    root.render(<Board projectId={Number(el.dataset["projectId"])} />);
    mounted = el;
  }
}

document.addEventListener("htmx:afterSwap", syncIsland);
syncIsland();
