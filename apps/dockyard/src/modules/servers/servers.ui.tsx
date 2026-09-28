import { routes } from "../../../.elysiax";
import type { Component } from "@workspace/htmx";
import type { Server } from "../../shared/schema";
import { Badge, Button, Empty, Field, PageHeader } from "../ui-kit/ui-kit.ui";

const dockerBadge = (s: Server) => {
  if (s.dockerStatus === "ok") return <Badge label={`docker ${s.dockerVersion ?? "ok"}`} tone="ok" />;
  if (s.dockerStatus === "missing") return <Badge label="无 docker" tone="err" />;
  return <Badge label="未检测" tone="muted" />;
};

export const ServerRow: Component<{ server: Server; message?: string }> = ({ server, message }) => (
  <div class="border-b border-harbor-800/60" id={`server-${server.id}`}>
    <div class="flex h-12 items-center gap-4 px-6 hover:bg-harbor-900">
      <span class="text-sm font-medium text-neutral-100">{server.name}</span>
      <span class="mono text-xs text-neutral-500">{server.user}@{server.host}:{server.port}</span>
      <span class="mono text-xs text-neutral-600">{server.authType}</span>
      <span class="ml-auto">{dockerBadge(server)}</span>
      <Button label="共享资源" variant="ghost" small hxGet={routes.resources.uiByServerId(server.id)} hxTarget="#modal-root" hxSwap="innerHTML" />
      <Button label="检测" variant="ghost" small hxPost={routes.servers.ById(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
      {server.dockerStatus === "missing" ? (
        <Button label="安装 docker" small hxPost={routes.servers.ById(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
      ) : null}
      <Button label="删除" variant="danger" small hxDelete={routes.servers.ById(server.id)} hxTarget="#main" hxSwap="innerHTML" hxConfirm={`删除服务器「${server.name}」？`} />
    </div>
    {message ? (
      <pre class="mono mx-6 mb-3 max-h-40 overflow-auto rounded bg-harbor-950 p-2 text-xs whitespace-pre-wrap text-neutral-400">{message}</pre>
    ) : null}
  </div>
);

/** TOFU 确认：首次连接展示指纹，用户显式信任 */
export const TrustPrompt: Component<{ server: Server; fingerprint: string; algorithm: string }> = ({
  server, fingerprint, algorithm,
}) => (
  <div class="border-b border-brass-600/40 bg-brass-500/5 px-6 py-4" id={`server-${server.id}`}>
    <div class="text-sm font-medium text-brass-500">确认主机指纹 — {server.name}</div>
    <div class="mt-1 text-xs text-neutral-400">
      首次连接 <span class="mono">{server.host}</span>，请核对 {algorithm} 指纹：
    </div>
    <code class="mono mt-2 block rounded bg-harbor-950 p-2 text-xs text-brass-500">{fingerprint}</code>
    <form class="mt-3 flex gap-2" hx-post={routes.servers.ById(server.id)} hx-target={`#server-${server.id}`} hx-swap="outerHTML">
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <Button label="信任并继续" type="submit" small />
      <Button label="取消" variant="ghost" small hxGet={routes.servers.ByIdCard(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
    </form>
  </div>
);

const ServerList: Component<{ servers: Server[] }> = ({ servers }) => (
  <div class="flex h-full flex-col">
    <PageHeader title="服务器" sub={`${servers.length} 台`}>
      <button
        class="inline-flex items-center rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 hover:bg-brass-600"
        onclick="document.getElementById('add-server-form').classList.toggle('hidden')"
      >
        添加服务器
      </button>
    </PageHeader>

    <div id="add-server-form" class="hidden border-b border-harbor-800 bg-harbor-900 px-6 py-4">
      <form class="grid max-w-3xl grid-cols-2 gap-3" hx-post={routes.servers.index()} hx-target="#main" hx-swap="innerHTML">
        <Field label="名称" name="name" placeholder="生产机" />
        <Field label="主机" name="host" placeholder="192.168.1.10" />
        <Field label="端口" name="port" type="number" value="22" />
        <Field label="用户" name="user" placeholder="root" />
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs text-neutral-500">认证方式</span>
          <select class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200" name="authType">
            <option value="key">私钥文件</option>
            <option value="agent">ssh-agent</option>
            <option value="password">密码</option>
          </select>
        </label>
        <Field label="私钥路径（key 时）" name="keyPath" placeholder="~/.ssh/id_ed25519" />
        <Field label="密码（password 时）" name="password" type="password" />
        <div class="col-span-2">
          <Button label="添加" type="submit" />
        </div>
      </form>
    </div>

    {servers.length === 0 ? (
      <Empty text="还没有服务器——添加一台，Dockyard 会检测它的 docker" />
    ) : (
      <div class="flex-1 overflow-auto">
        {servers.map((s) => (
          <ServerRow server={s} />
        ))}
      </div>
    )}
  </div>
);

export default ServerList;
