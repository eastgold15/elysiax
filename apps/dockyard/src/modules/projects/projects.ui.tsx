import type { Component } from "@workspace/htmx";
import type { Project } from "../../shared/schema";
import { Button, Empty, PageHeader } from "../ui-kit/ui-kit.ui";

const ProjectList: Component<{ projects: Project[] }> = ({ projects }) => (
  <div class="flex h-full flex-col">
    <PageHeader title="项目空间" sub={`${projects.length} 个`}>
      <form class="flex gap-2" hx-post="/api/projects" hx-target="#main" hx-swap="innerHTML">
        <input
          class="w-48 rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
          type="text"
          name="name"
          placeholder="新项目名"
          required
        />
        <Button label="创建" type="submit" />
      </form>
    </PageHeader>

    {projects.length === 0 ? (
      <Empty text="还没有项目空间——创建一个，把服务器和部署组织进去" />
    ) : (
      <div class="flex-1 overflow-auto">
        {projects.map((p) => (
          <div class="group flex h-12 items-center gap-4 border-b border-harbor-800/60 px-6 hover:bg-harbor-900">
            <a
              href="#"
              class="text-sm font-medium text-neutral-100 hover:text-brass-500"
              hx-get={`/api/canvas/ui/${p.id}`}
              hx-target="#main"
              hx-swap="innerHTML"
            >
              {p.name}
            </a>
            <span class="mono text-xs text-neutral-600">{p.slug}</span>
            <span class="mono ml-auto text-xs text-neutral-600">
              {p.createdAt.toLocaleDateString("zh-CN")}
            </span>
            <Button
              label="删除"
              variant="danger"
              small
              hxDelete={`/api/projects/${p.id}`}
              hxTarget="#main"
              hxSwap="innerHTML"
              hxConfirm={`删除项目「${p.name}」及其画布与部署配置？`}
            />
          </div>
        ))}
      </div>
    )}
  </div>
);

export default ProjectList;
