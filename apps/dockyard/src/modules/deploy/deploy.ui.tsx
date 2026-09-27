import type { Component } from "@workspace/htmx";
import type { Deployment, DeployTarget, Domain } from "../../shared/schema";
import { serviceEnvToText, type DetectResult, type DetectedService } from "./detect";
import { Button, Field } from "../ui-kit/ui-kit.ui";

const Modal: Component<{ title: string; wide?: boolean }> = ({ title, wide, children }) => (
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70" onclick="if(event.target===this)this.remove()">
    <div class={`${wide ? "w-[42rem]" : "w-96"} max-h-[85vh] overflow-y-auto rounded border border-harbor-700 bg-harbor-900 p-5 shadow-2xl`}>
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-neutral-100">{title}</h3>
        <button class="text-neutral-500 hover:text-neutral-200" onclick="this.closest('.fixed').remove()">✕</button>
      </div>
      {children}
    </div>
  </div>
);

const ErrorBanner: Component = ({ children }) => (
  <div class="rounded bg-signal-500/15 px-3 py-2 text-xs text-signal-500">{children}</div>
);

const Chip: Component<{ tone?: "ok" | "warn" | "muted" }> = ({ tone = "muted", children }) => (
  <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${
    tone === "ok" ? "bg-tide-400/10 text-tide-400"
    : tone === "warn" ? "bg-brass-500/15 text-brass-500"
    : "bg-harbor-800 text-neutral-500"
  }`}>{children}</span>
);

// ── 部署 app 向导（Railway/openship 两步式）──
// Step 1：仓库信息 → 识别；Step 2：识别结果确认（服务/域名/环境变量）→ 创建即部署
export const NewAppModal: Component<{ nodeId: number; error?: string }> = ({ nodeId, error }) => (
  <Modal title="部署 app · 1/2 仓库">
    <form class="flex flex-col gap-3" hx-post="/api/deploy/ui/detect" hx-target="#modal-root" hx-swap="innerHTML">
      <input type="hidden" name="nodeId" value={String(nodeId)} />
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <Field label="名称" name="name" placeholder="my-app" required />
      <Field label="仓库" name="repoUrl" required placeholder="owner/repo 或 https://github.com/owner/repo" />
      <Field label="分支" name="branch" value="main" />
      <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-app" required />
      <div class="text-xs text-neutral-500">下一步会克隆仓库并读取 openship.json / compose 自动识别服务与端口。</div>
      <Button label="下一步：识别仓库" type="submit" />
    </form>
  </Modal>
);

const inputCls = "rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200";
const labelCls = "text-[11px] text-neutral-500";

const ServiceCard: Component<{ svc: DetectedService }> = ({ svc }) => (
  <div class="rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5">
    <div class="mb-2 flex items-center gap-2">
      <span class="text-xs font-medium text-neutral-200 mono">{svc.name}</span>
      {svc.exposed ? <Chip tone="ok">对外</Chip> : <Chip>内部</Chip>}
      {svc.cpuCores || svc.memoryMb ? (
        <Chip tone="warn">
          {[svc.cpuCores ? `${svc.cpuCores}C` : "", svc.memoryMb ? `${svc.memoryMb}M` : ""].filter(Boolean).join(" ")}
        </Chip>
      ) : null}
    </div>
    <div class="grid grid-cols-4 gap-2">
      <label class="flex flex-col gap-0.5">
        <span class={labelCls}>对外端口</span>
        <input class={inputCls} type="number" name={`svcPort_${svc.name}`} value={svc.port ? String(svc.port) : ""} placeholder="—" />
      </label>
      <label class="col-span-3 flex flex-col gap-0.5">
        <span class={labelCls}>绑定域名（留空 = 不绑）</span>
        <input class={inputCls} type="text" name={`svcDomain_${svc.name}`} value={svc.domain ?? ""} placeholder="api.example.com" />
      </label>
      <label class="col-span-2 flex flex-col gap-0.5">
        <span class={labelCls}>CPU 上限（核）</span>
        <input class={inputCls} type="number" step="0.1" name={`svcCpu_${svc.name}`} value={svc.cpuCores ? String(svc.cpuCores) : ""} placeholder="不限" />
      </label>
      <label class="col-span-2 flex flex-col gap-0.5">
        <span class={labelCls}>内存上限（MB）</span>
        <input class={inputCls} type="number" name={`svcMem_${svc.name}`} value={svc.memoryMb ? String(svc.memoryMb) : ""} placeholder="不限" />
      </label>
    </div>
    {Object.keys(svc.env).length > 0 ? (
      <details class="mt-2">
        <summary class="cursor-pointer text-[11px] text-neutral-500 select-none">
          环境变量（{Object.keys(svc.env).length}）· 随 override 注入容器
        </summary>
        <textarea
          class={`${inputCls} mono mt-1 h-28 w-full px-2 py-1.5 text-[11px] leading-relaxed`}
          name={`svcEnv_${svc.name}`}
        >{serviceEnvToText(svc.env)}</textarea>
      </details>
    ) : null}
  </div>
);

/** Step 2：识别结果确认。errors 硬阻断（配置文件本身坏了），warnings 只提示 */
export const AppDetectStep: Component<{
  carry: { nodeId: number; name: string; repoUrl: string; branch: string; remoteDir: string };
  detect: DetectResult;
  envText: string;
  error?: string;
}> = ({ carry, detect, envText, error }) => (
  <Modal title={`部署 app · 2/2 确认配置 — ${carry.name}`} wide>
    <form class="flex flex-col gap-4" hx-post="/api/deploy/targets/app" hx-target="#modal-root" hx-swap="innerHTML">
      <input type="hidden" name="nodeId" value={String(carry.nodeId)} />
      <input type="hidden" name="name" value={carry.name} />
      <input type="hidden" name="repoUrl" value={carry.repoUrl} />
      <input type="hidden" name="branch" value={carry.branch} />
      <input type="hidden" name="remoteDir" value={carry.remoteDir} />

      <div class="flex items-center gap-2 text-xs text-neutral-400">
        识别来源
        {detect.source === "openship.json" ? <Chip tone="ok">openship.json</Chip>
          : detect.source === "compose" ? <Chip tone="warn">compose 探测</Chip>
          : <Chip tone="warn">未识别</Chip>}
        <span class="mono text-neutral-600">{detect.composePath}</span>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {detect.errors.map((e) => <ErrorBanner>{e}</ErrorBanner>)}
      {detect.warnings.length > 0 ? (
        <div class="rounded bg-brass-500/10 px-3 py-2 text-xs text-brass-500">
          {detect.warnings.map((w) => <div>⚠️ {w}</div>)}
        </div>
      ) : null}

      <label class="flex flex-col gap-1 text-sm">
        <span class="text-neutral-400">compose 文件路径</span>
        <input class={`${inputCls} px-3 py-1.5`} type="text" name="composePath" value={detect.composePath} required />
      </label>

      {detect.services.length > 0 ? (
        <div class="flex flex-col gap-2">
          <div class="text-xs font-medium text-neutral-400">服务（{detect.services.length}）</div>
          {detect.services.map((svc) => <ServiceCard svc={svc} />)}
        </div>
      ) : null}

      {envText.trim() ? (
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-neutral-400">全局环境变量（compose ${"{VAR}"} 插值用，加密保存）</span>
          <textarea
            class={`${inputCls} mono h-28 px-3 py-2 text-xs leading-relaxed`}
            name="envText"
            placeholder="KEY=value"
          >{envText}</textarea>
        </label>
      ) : null}

      <div class="text-xs text-neutral-500">创建后立即部署并打开日志。</div>
      <Button label="创建并部署" type="submit" />
    </form>
  </Modal>
);

// ── 域名管理（绑定 → edge 反代 + 自动证书）──
const dnsChip = (d: Domain) =>
  d.dnsStatus === "ok" ? <Chip tone="ok">DNS ✓</Chip>
  : d.dnsStatus === "mismatch" ? <Chip tone="warn">DNS 未指向本机</Chip>
  : <Chip>DNS 未检测</Chip>;
const sslChip = (d: Domain) =>
  d.sslStatus === "active" ? <Chip tone="ok">🔒 HTTPS</Chip>
  : d.sslStatus === "pending" ? <Chip tone="warn">证书待签发</Chip>
  : d.sslStatus === "error" ? <Chip tone="warn">证书异常</Chip>
  : <Chip>无证书</Chip>;

export const DomainsModal: Component<{ target: DeployTarget; domains: Domain[]; error?: string }> = ({ target, domains, error }) => (
  <Modal title={`域名 — ${target.name}`}>
    <div class="flex flex-col gap-3">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {domains.length === 0 ? <div class="text-xs text-neutral-500">还没有绑定域名。绑定后自动反代并签发 HTTPS 证书。</div> : null}
      {domains.map((d) => (
        <div class="flex items-center justify-between gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
          <div class="flex flex-col gap-1">
            <a class="text-xs font-medium text-tide-400 hover:text-tide-300 mono" href={`https://${d.hostname}`} target="_blank" rel="noreferrer">{d.hostname}</a>
            <span class="text-[11px] text-neutral-500 mono">→ :{d.targetPort}{d.serviceName ? `（${d.serviceName}）` : ""}</span>
          </div>
          <div class="flex items-center gap-1.5">
            {dnsChip(d)}{sslChip(d)}
            <button
              class="text-neutral-600 hover:text-signal-500"
              hx-delete={`/api/deploy/domains/${d.id}`}
              hx-target="#modal-root"
              hx-swap="innerHTML"
              hx-confirm={`解绑 ${d.hostname}？`}
            >✕</button>
          </div>
        </div>
      ))}
      <form class="flex items-end gap-2" hx-post={`/api/deploy/targets/${target.id}/domains`} hx-target="#modal-root" hx-swap="innerHTML">
        <label class="flex flex-1 flex-col gap-0.5">
          <span class={labelCls}>域名</span>
          <input class={inputCls} type="text" name="hostname" placeholder="app.example.com" required />
        </label>
        <label class="flex w-24 flex-col gap-0.5">
          <span class={labelCls}>端口</span>
          <input class={inputCls} type="number" name="targetPort" required />
        </label>
        <Button label="绑定" type="submit" />
      </form>
      <div class="text-xs text-neutral-500">域名 A 记录指向服务器 IP 后，证书会自动签发。</div>
    </div>
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
  // dep 可能还没建行（创建即部署的竞态）：无 dep 也轮询，直到出现终态
  const active = !dep || (dep.status !== "success" && dep.status !== "failed");
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
