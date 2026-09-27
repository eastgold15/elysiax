import type { Component } from "@workspace/htmx";
import type { Project } from "../../shared/schema";
import { PageHeader } from "../ui-kit/ui-kit.ui";

/**
 * 画布是客户端孤岛：这里只渲染壳（页头 + 点阵底板），
 * 卡片/菜单/拖拽全部由 src/pages/canvas.ts 以 JSON 数据驱动。
 */
const CanvasShell: Component<{ project: Project; projects: Project[] }> = ({ project, projects }) => (
  <div class="flex h-full flex-col">
    <PageHeader title={project.name} sub="画布 · 空白处右键添加服务器">
      {projects.length > 1 ? (
        <select
          class="rounded border border-harbor-700 bg-harbor-950 px-2 py-1 text-sm text-neutral-300"
          onchange="const id=this.value; htmx.ajax('GET','/api/canvas/ui/'+id,{target:'#main',swap:'innerHTML'})"
        >
          {projects.map((p) => (
            <option value={String(p.id)} selected={p.id === project.id}>{p.name}</option>
          ))}
        </select>
      ) : null}
    </PageHeader>
    <div id="canvas-root" data-project-id={String(project.id)} class="dock-grid relative flex-1 overflow-auto" />
  </div>
);

export default CanvasShell;
