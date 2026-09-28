import type { Component } from "@workspace/htmx";
import type { Project } from "../../shared/schema";
import { PageHeader } from "../ui-kit/ui-kit.ui";

/**
 * 画布 = React 岛（@xyflow/react）：卡片/连线/拖拽建依赖全在岛里（island/），
 * 数据走 /api/canvas/ui/:id/board JSON，本文件只剩壳——页头 + 岛屿挂载点。
 * 岛屿随 htmx 片段进出 #main，island/index.tsx 在 htmx:afterSwap 时挂载/卸载。
 * 模态框（变量/域名/日志/新建目标）仍是服务端片段，岛里按钮调全局 htmx.ajax 进 #modal-root。
 */
const CanvasShell: Component<{ project: Project; projects: Project[] }> = ({ project, projects }) => (
  <div class="flex h-full flex-col">
    <PageHeader title={project.name} sub="画布 · 空白处右键添加服务器，拖动行尾圆点连线建依赖">
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
    <div id="canvas-island" data-project-id={String(project.id)} class="relative flex-1" />
  </div>
);

export default CanvasShell;
