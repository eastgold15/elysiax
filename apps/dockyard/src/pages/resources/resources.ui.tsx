import { routes } from "../../../.elysiax";
import type { Component } from "@workspace/htmx";
import type { Server, ServerResource } from "../../shared/schema";
import { Button, Field } from "../ui-kit/ui-kit.ui";

const DB_TYPES = ["postgres", "mysql", "redis", "mongo"] as const;

const Modal: Component<{ title: string }> = ({ title, children }) => (
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70" onclick="if(event.target===this)this.remove()">
    <div class="max-h-[85vh] w-[36rem] overflow-y-auto rounded border border-harbor-700 bg-harbor-900 p-5 shadow-2xl">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-neutral-100">{title}</h3>
        <button class="text-neutral-500 hover:text-neutral-200" onclick="this.closest('.fixed').remove()">✕</button>
      </div>
      {children}
    </div>
  </div>
);

const ResourceRow: Component<{ resource: ServerResource; url: string | null }> = ({ resource, url }) => (
  <div class="flex flex-col gap-1 rounded border border-harbor-800 bg-harbor-950 px-3 py-2">
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium text-neutral-200">{resource.name}</span>
      <span class="mono rounded bg-harbor-800 px-1.5 py-0.5 text-[11px] text-neutral-500">{resource.dbType}</span>
      <span class={`mono rounded px-1.5 py-0.5 text-[11px] ${url ? "bg-tide-400/10 text-tide-400" : "bg-brass-500/15 text-brass-500"}`}>
        {url ? "已就绪" : "未部署"}
      </span>
      <span class="ml-auto flex gap-2">
        {!url ? (
          <Button label="部署" small hxPost={routes.resources.ByIdDeploy(resource.id)} hxTarget="#shared-resources-body" hxSwap="innerHTML" />
        ) : null}
        <Button label="删除" variant="danger" small hxDelete={routes.resources.ById(resource.id)} hxTarget="#shared-resources-body" hxSwap="innerHTML"
          hxConfirm={`删除共享资源「${resource.name}」的记录？（远端容器和数据卷保留，需手动清理）`} />
      </span>
    </div>
    <div class="flex items-center gap-2 text-xs text-neutral-500">
      <span class="mono text-brass-500">{resource.envKey}</span>
      {url ? <span class="mono truncate text-neutral-600" title={url}>{url}</span> : <span>部署后自动生成连接串</span>}
    </div>
  </div>
);

/** 共享资源清单弹窗主体（部署/删除后整段刷新） */
export const ResourceListBody: Component<{
  server: Server;
  resources: { resource: ServerResource; url: string | null }[];
  message?: string;
}> = ({ server, resources, message }) => (
  <div id="shared-resources-body" class="flex flex-col gap-3">
    {message ? <pre class="mono max-h-40 overflow-auto rounded bg-harbor-950 p-2 text-xs whitespace-pre-wrap text-signal-500">{message}</pre> : null}
    {resources.length === 0 ? (
      <p class="text-xs text-neutral-500">还没有共享资源——部署 Redis / 数据库后，连接串会成为这台服务器的共享变量，任何项目都能引用。</p>
    ) : (
      resources.map((r) => <ResourceRow resource={r.resource} url={r.url} />)
    )}
    <form class="mt-2 grid grid-cols-[1fr_auto_auto] items-end gap-2 border-t border-harbor-800 pt-3" hx-post={routes.resources.index()} hx-target="#shared-resources-body" hx-swap="innerHTML">
      <input type="hidden" name="serverId" value={`${server.id}`} />
      <Field label="名称" name="name" placeholder="redis-main" />
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-xs text-neutral-500">类型</span>
        <select class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200" name="dbType">
          {DB_TYPES.map((d) => <option value={d}>{d}</option>)}
        </select>
      </label>
      <Button label="创建" type="submit" small />
    </form>
  </div>
);

/** 服务器共享资源弹窗（视角 B：单独预部署中间件） */
export const SharedResourcesModal: Component<{
  server: Server;
  resources: { resource: ServerResource; url: string | null }[];
  message?: string;
}> = ({ server, resources, message }) => (
  <Modal title={`共享资源 — ${server.name}`}>
    <ResourceListBody server={server} resources={resources} message={message} />
  </Modal>
);

export default SharedResourcesModal;
