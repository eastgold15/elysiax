import type { Component } from "@workspace/htmx";
import type { Deployment, DeployTarget } from "../../shared/schema";
import { Button, Field } from "../ui-kit/ui-kit.ui";

const Modal: Component<{ title: string }> = ({ title, children }) => (
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70" onclick="if(event.target===this)this.remove()">
    <div class="w-96 rounded border border-harbor-700 bg-harbor-900 p-5 shadow-2xl">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-neutral-100">{title}</h3>
        <button class="text-neutral-500 hover:text-neutral-200" onclick="this.closest('.fixed').remove()">✕</button>
      </div>
      {children}
    </div>
  </div>
);

export const NewAppModal: Component<{ nodeId: number; error?: string }> = ({ nodeId, error }) => (
  <Modal title="部署 app（GitHub 仓库）">
    <form class="flex flex-col gap-3" hx-post="/api/deploy/targets/app" hx-target="#modal-root" hx-swap="innerHTML">
      <input type="hidden" name="nodeId" value={String(nodeId)} />
      {error ? <div class="rounded bg-signal-500/15 px-3 py-2 text-xs text-signal-500">{error}</div> : null}
      <Field label="名称" name="name" placeholder="my-app" required />
      <Field label="仓库" name="repoUrl" required placeholder="owner/repo 或 https://github.com/owner/repo" />
      <Field label="分支" name="branch" value="main" />
      <Field label="compose 文件路径" name="composePath" value="docker-compose.yml" />
      <Field label="服务名（留空 = 全部）" name="serviceName" />
      <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-app" />
      <Button label="创建部署目标" type="submit" />
    </form>
  </Modal>
);

/** 类型选择后拉取：该服务器上可托管的同类型实例（redis 无逻辑库概念，不显示） */
export const InstanceOptions: Component<{ nodeId: number; instances: DeployTarget[] }> = ({
  instances,
}) => (
  <div id="instance-options" class="flex flex-col gap-1.5 text-sm">
    <label class="flex items-center gap-2 text-neutral-300">
      <input type="radio" name="instanceId" value="" checked /> 新建实例
    </label>
    {instances.map((i) => (
      <label class="flex items-center gap-2 text-neutral-300">
        <input type="radio" name="instanceId" value={String(i.id)} />
        在「{i.name}」中新建逻辑库（省一个容器的开销）
      </label>
    ))}
    {instances.length > 0 ? (
      <div class="text-xs text-neutral-500">选现有实例时无需填远端目录，凭据自动生成。</div>
    ) : null}
  </div>
);

export const NewDbModal: Component<{ nodeId: number; instances: DeployTarget[]; error?: string }> = ({ nodeId, instances, error }) => (
  <Modal title="部署数据库（官方镜像）">
    <form class="flex flex-col gap-3" hx-post="/api/deploy/targets/db" hx-target="#modal-root" hx-swap="innerHTML">
      <input type="hidden" name="nodeId" value={String(nodeId)} />
      <Field label="名称" name="name" placeholder="my-pg" required />
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-neutral-400">类型</span>
        <select
          class="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
          name="dbType"
          hx-get={`/api/deploy/ui/instances?nodeId=${nodeId}`}
          hx-target="#instance-options"
          hx-swap="outerHTML"
          hx-trigger="change"
          hx-include="this"
        >
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="redis">Redis</option>
          <option value="mongo">MongoDB</option>
        </select>
      </label>
      <InstanceOptions nodeId={nodeId} instances={instances} />
      <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-pg（新建实例时必填）" />
      {error ? <div class="rounded bg-signal-500/15 px-3 py-2 text-xs text-signal-500">{error}</div> : null}
      <div class="text-xs text-neutral-500">凭据自动生成并加密保存，数据卷持久化。</div>
      <Button label="创建并部署" type="submit" />
    </form>
  </Modal>
);

/** 部署日志（modal 内 1s 轮询直到终态） */
export const DeployLog: Component<{ target: DeployTarget; dep?: Deployment }> = ({ target, dep }) => {
  const active = dep && dep.status !== "success" && dep.status !== "failed";
  return (
    <Modal title={`部署日志 — ${target.name}`}>
      <pre
        class="mono max-h-96 overflow-auto rounded bg-harbor-950 p-3 text-xs whitespace-pre-wrap text-neutral-300"
        {...(active
          ? { "hx-get": `/api/deploy/ui/targets/${target.id}/log-body`, "hx-trigger": "every 1s", "hx-swap": "innerHTML" }
          : {})}
      >
        {dep?.logText ?? "尚未部署"}
      </pre>
    </Modal>
  );
};

// 模块约定：.ui.tsx 需 default export（deploy 无独立页面，占位）
const DeployUi: Component = () => <div class="text-sm text-neutral-400">deploy 模块（无独立页面）</div>;
export default DeployUi;
