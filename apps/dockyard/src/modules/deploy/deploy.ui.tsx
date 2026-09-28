import { routes } from "../../../.elysiax";
import type { Component } from "@workspace/htmx";
import type { Deployment, DeployTarget, Domain } from "../../shared/schema";
import type { RepoBrief } from "../github/github.service";
import type { DbRef } from "./deploy.service";
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

/** 右侧抽屉（Railway 式配置面板）。结构与 snippets/sheet.html 一致，配色走 harbor 主题；
 *  没用原生 <dialog>——htmx 片段直接挂 #modal-root，现有关窗约定（点遮罩/✕）不变 */
const Drawer: Component<{ title: string; sub?: string; wide?: boolean }> = ({ title, sub, wide, children }) => (
  <div class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.remove()">
    <div class={`fixed inset-y-0 right-0 left-auto flex h-full ${wide ? "w-[50vw]" : "w-[36rem]"} max-w-full flex-col border-l border-harbor-700 bg-harbor-900 shadow-2xl`}>
      <div class="flex items-start justify-between border-b border-harbor-800 px-5 py-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold text-neutral-100">{title}</h3>
          {sub ? <p class="text-xs text-neutral-500">{sub}</p> : null}
        </div>
        <button class="text-neutral-500 hover:text-neutral-200" onclick="this.closest('.fixed.inset-0').remove()">✕</button>
      </div>
      <div class="flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  </div>
);

/** 抽屉里的分区标题（Railway 面板的 Settings/Networking/Variables 区块感） */
const Section: Component<{ title: string; hint?: string }> = ({ title, hint, children }) => (
  <section class="flex flex-col gap-2">
    <div class="flex items-baseline justify-between">
      <h4 class="text-xs font-semibold tracking-wide text-neutral-300 uppercase">{title}</h4>
      {hint ? <span class="text-[11px] text-neutral-600">{hint}</span> : null}
    </div>
    {children}
  </section>
);

/** 提交按钮（带请求中状态：识别要调 gh API / 部署要克隆，必须给用户即时反馈） */
const SubmitBtn: Component<{ label: string; busy: string }> = ({ label, busy }) => (
  <button
    type="submit"
    class="inline-flex items-center justify-center gap-2 rounded px-3 py-1.5 text-sm font-semibold transition-colors bg-brass-500 text-harbor-950 hover:bg-brass-600 [.htmx-request_&]:pointer-events-none [.htmx-request_&]:opacity-70"
  >
    <span class="htmx-indicator animate-spin">◌</span>
    <span class="[.htmx-request_&]:hidden">{label}</span>
    <span class="htmx-indicator">{busy}</span>
  </button>
);

// ── 部署 app 向导（Railway/openship 两步式，右侧抽屉）──
// Step 1：gh 仓库选择器 → 识别；Step 2：识别结果确认（服务/域名/变量/打包）→ 创建即部署
export const NewAppDrawer: Component<{ nodeId: number; repos: RepoBrief[]; error?: string; prefillRepo?: string }> = ({ nodeId, repos, error, prefillRepo }) => (
  <Drawer title="部署 app" sub="从 GitHub 仓库部署到这台服务器">
    <form class="flex flex-col gap-4" hx-post={routes.deploy.uiDetect()} hx-target="#modal-root" hx-swap="innerHTML">
      <input type="hidden" name="nodeId" value={String(nodeId)} />
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <Section title="仓库" hint={`gh 账号下 ${repos.length} 个`}>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-neutral-400">选择仓库（可输入过滤）</span>
          <input
            class="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
            type="text"
            name="repoUrl"
            list="gh-repos"
            placeholder="owner/repo"
            autocomplete="off"
            value={prefillRepo ?? ""}
            required
          />
          <datalist id="gh-repos">
            {repos.map((r) => (
              <option value={r.fullName}>{`${r.private ? "🔒" : "🌐"} ${r.branch}`}</option>
            ))}
          </datalist>
        </label>
      </Section>
      <Section title="基本">
        <div class="grid grid-cols-2 gap-2">
          <Field label="名称" name="name" placeholder="my-app" required />
          <Field label="分支" name="branch" value="main" />
        </div>
        <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-app" required />
      </Section>
      <div class="text-xs text-neutral-500">下一步会读取仓库的 openship.json / compose 自动识别服务、端口与域名。</div>
      <SubmitBtn label="下一步：识别仓库" busy="识别中…（调 GitHub API，通常几秒）" />
    </form>
  </Drawer>
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
    <input type="hidden" name="svcName" value={svc.name} />
    <div class="grid grid-cols-4 gap-2">
      <label class="flex flex-col gap-0.5">
        <span class={labelCls}>
          <input
            type="checkbox"
            name={`svcExpose_${svc.name}`}
            checked={svc.exposed}
            class="mr-1 accent-brass-500"
            {...{ onchange: `const p=this.closest('label').querySelector('input[type=number]');p.disabled=!this.checked` }}
          />
          对外端口
        </span>
        <input class={`${inputCls} disabled:opacity-40`} type="number" name={`svcPort_${svc.name}`} value={svc.port ? String(svc.port) : ""} placeholder="内部" disabled={!svc.exposed} />
      </label>
      <label class="col-span-3 flex flex-col gap-0.5">
        <span class={labelCls}>绑定域名（留空 = 不绑，需先勾对外）</span>
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

/** 数据库依赖选择器：勾选 = 记录血缘（画布连线）+ 把连接串追加进 envText。
 *  联动是纯声明式的 onchange 行内脚本：按 data-line 精确增删，取消勾选即移除 */
export const DbRefPicker: Component<{ refs: DbRef[]; selected: number[] }> = ({ refs, selected }) => (
  <div class="flex flex-col gap-1.5">
    {refs.map((r) => (
      <label class="flex cursor-pointer items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-brass-500/60 has-checked:bg-brass-500/5">
        <input
          type="checkbox"
          name="depIds"
          value={String(r.id)}
          checked={selected.includes(r.id)}
          class="accent-brass-500"
          data-line={`${r.envKey}=${r.url}`}
          onchange="const ta=this.closest('form').querySelector('[name=envText]');if(!ta)return;const ls=ta.value.split('\n').filter(l=>l.trim()&&l!==this.dataset.line);if(this.checked){ls.push(this.dataset.line);ta.scrollTop=ta.scrollHeight}ta.value=ls.join('\n')"
        />
        <span class="shrink-0 text-neutral-200">{r.logical ? "⛁" : "🗄"} {r.name}</span>
        <span class="flex min-w-0 flex-col">
          <span class="text-neutral-600">
            {r.dbType}{r.logical ? " · 逻辑库" : ""} → <span class="mono text-tide-400">{r.envKey}</span>
          </span>
          <span class="mono truncate text-[10px] text-neutral-700">{r.displayUrl}</span>
        </span>
      </label>
    ))}
    <div class="text-[11px] text-neutral-600">勾选即注入连接串到下方变量；取消即移除。多个同类型数据库请自行改变量名。</div>
  </div>
);

/** Step 2：识别结果确认（右侧抽屉，分区同 Railway 服务面板）。errors 硬阻断，warnings 只提示 */
export const AppDetectStep: Component<{
  carry: { nodeId: number; name: string; repoUrl?: string; branch: string; remoteDir: string };
  detect: DetectResult;
  envText: string;
  dbRefs: DbRef[];
  /** 部署前置检查匹配到的服务器共享资源（中间件复用询问） */
  sharedMatches?: { service: string; name: string; dbType: string; envKey: string; url: string; displayUrl: string }[];
  error?: string;
}> = ({ carry, detect, envText, dbRefs, sharedMatches, error }) => (
  <Drawer title={carry.name} sub={carry.repoUrl ? `${carry.repoUrl}@${carry.branch}` : "本地文件夹导入"}>
    <form class="flex flex-col gap-5" hx-post={routes.deploy.targetsApp()} hx-target="#modal-root" hx-swap="innerHTML">
      <input type="hidden" name="nodeId" value={String(carry.nodeId)} />
      <input type="hidden" name="name" value={carry.name} />
      <input type="hidden" name="repoUrl" value={carry.repoUrl ?? ""} />
      <input type="hidden" name="branch" value={carry.branch} />
      <input type="hidden" name="remoteDir" value={carry.remoteDir} />

      <div class="flex items-center gap-2 text-xs text-neutral-400">
        识别来源
        {detect.source === "openship.json" ? <Chip tone="ok">openship.json</Chip>
          : detect.source === "compose" ? <Chip tone="warn">compose 探测</Chip>
          : <Chip tone="warn">未识别</Chip>}
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {detect.errors.map((e) => <ErrorBanner>{e}</ErrorBanner>)}
      {detect.warnings.length > 0 ? (
        <div class="rounded bg-brass-500/10 px-3 py-2 text-xs text-brass-500">
          {detect.warnings.map((w) => <div>⚠️ {w}</div>)}
        </div>
      ) : null}

      {detect.services.length > 0 ? (
        <Section title="服务" hint={`${detect.services.length} 个 · 端口/域名/资源`}>
          {detect.services.map((svc) => <ServiceCard svc={svc} />)}
        </Section>
      ) : null}

      {(sharedMatches?.length ?? 0) > 0 ? (
        <Section title="复用服务器资源？" hint="前置检查：服务器已有匹配的共享中间件">
          <div class="flex flex-col gap-1.5">
            {sharedMatches!.map((m) => (
              <label class="flex cursor-pointer items-center gap-2 rounded border border-tide-400/30 bg-tide-400/5 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-tide-400/70">
                <input
                  type="checkbox"
                  name={`reuse_${m.service}`}
                  checked
                  class="accent-tide-400"
                  data-line={`${m.envKey}=${m.url}`}
                  onchange="const ta=this.closest('form').querySelector('[name=envText]');if(!ta)return;const ls=ta.value.split('\n').filter(l=>l.trim()&&l!==this.dataset.line);if(this.checked){ls.push(this.dataset.line);ta.scrollTop=ta.scrollHeight}ta.value=ls.join('\n')"
                />
                <span class="flex min-w-0 flex-col">
                  <span>服务 <span class="mono text-neutral-200">{m.service}</span> 复用共享资源「{m.name}」（{m.dbType}）→ <span class="mono text-tide-400">{m.envKey}</span></span>
                  <span class="mono truncate text-[10px] text-neutral-600">{m.displayUrl}</span>
                </span>
              </label>
            ))}
            <div class="text-[11px] text-neutral-600">勾选 = 跳过该中间件部署，自动注入共享连接串；取消 = 随项目完整部署。</div>
          </div>
        </Section>
      ) : null}

      {dbRefs.length > 0 ? (
        <Section title="依赖数据库" hint="画布连线 + 注入连接串">
          <DbRefPicker refs={dbRefs} selected={[]} />
        </Section>
      ) : null}

      <Section title="变量" hint="compose 插值用 · 加密保存">
        <textarea
          class={`${inputCls} mono h-28 px-3 py-2 text-xs leading-relaxed`}
          name="envText"
          placeholder="KEY=value"
        >{envText}</textarea>
      </Section>

      <Section title="打包" hint="compose 构建与部署">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-neutral-400">compose 文件路径</span>
          <input class={`${inputCls} px-3 py-1.5`} type="text" name="composePath" value={detect.composePath} required />
        </label>
      </Section>

      <div class="flex flex-col gap-2 border-t border-harbor-800 pt-4">
        <div class="text-xs text-neutral-500">创建后立即部署并打开日志。</div>
        <SubmitBtn label="创建并部署" busy="创建中…" />
      </div>
    </form>
  </Drawer>
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
              hx-delete={routes.deploy.domainsById(d.id)}
              hx-target="#modal-root"
              hx-swap="innerHTML"
              hx-confirm={`解绑 ${d.hostname}？`}
            >✕</button>
          </div>
        </div>
      ))}
      <form class="flex items-end gap-2" hx-post={routes.deploy.targetsByIdDomains(target.id)} hx-target="#modal-root" hx-swap="innerHTML">
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

/** 已有 app 的变量抽屉：改 .env + 调整数据库依赖（保存后需重新部署生效） */
export const EnvDrawer: Component<{
  target: DeployTarget;
  envText: string;
  dbRefs: DbRef[];
  error?: string;
}> = ({ target, envText, dbRefs, error }) => (
  <Drawer title={`变量 — ${target.name}`} sub="保存后重新部署生效">
    <form class="flex flex-col gap-5" hx-post={routes.deploy.targetsByIdEnv(target.id)} hx-target="#modal-root" hx-swap="innerHTML">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {dbRefs.length > 0 ? (
        <Section title="依赖数据库" hint="画布连线 + 注入连接串">
          <DbRefPicker refs={dbRefs} selected={target.dependsOn ?? []} />
        </Section>
      ) : null}
      <Section title="变量" hint="compose 插值用 · 加密保存">
        <textarea
          class={`${inputCls} mono h-56 px-3 py-2 text-xs leading-relaxed`}
          name="envText"
          placeholder="KEY=value"
        >{envText}</textarea>
      </Section>
      <SubmitBtn label="保存变量" busy="保存中…" />
    </form>
  </Drawer>
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
    <form class="flex flex-col gap-3" hx-post={routes.deploy.targetsDb()} hx-target="#modal-root" hx-swap="innerHTML">
      <input type="hidden" name="nodeId" value={String(nodeId)} />
      <Field label="名称" name="name" placeholder="my-pg" required />
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-neutral-400">类型</span>
        <select
          class="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
          name="dbType"
          hx-get={`${routes.deploy.uiInstances()}?nodeId=${nodeId}`}
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
          ? { "hx-get": `${routes.deploy.uiTargetsByIdLogBody(target.id)}${dep ? `?dep=${dep.id}` : ""}`, "hx-trigger": "every 1s", "hx-swap": "innerHTML" }
          : {})}
      >
        {dep?.logText ?? "尚未部署"}
      </pre>
    </Modal>
  );
};

// ── 服务抽屉（Railway Service View）：点画布服务卡/db 卡弹出 ──
export type ServiceTab = "deployments" | "logs" | "variables" | "metrics" | "settings" | "backups";

const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

const fmtAgo = (d: Date) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return new Date(d).toLocaleDateString("zh-CN");
};

/** 一次性资源快照（hx 4s 轮询，元素随关窗移除即停） */
export const MetricsPanel: Component<{
  targetId: number; svc?: string;
  stats?: { state: string; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number } | null;
}> = ({ targetId, svc, stats }) => (
  <div
    id="svc-metrics"
    hx-get={`${routes.deploy.uiTargetsByIdServiceMetrics(targetId)}${svc ? `?svc=${encodeURIComponent(svc)}` : ""}`}
    hx-trigger={`${stats === undefined ? "load, " : ""}every 4s`}
    hx-swap="innerHTML"
  >
    {stats === undefined ? (
      <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">加载中…</div>
    ) : !stats ? (
      <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">指标不可用（容器未运行或服务器离线）</div>
    ) : stats.state !== "running" ? (
      <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">容器状态：{stats.state}</div>
    ) : (
      <div class="flex flex-col gap-3">
        {([
          { label: "CPU", pct: Math.min(100, stats.cpuPercent), text: `${stats.cpuPercent}%` },
          { label: "内存", pct: stats.memLimit ? Math.min(100, (stats.memUsage / stats.memLimit) * 100) : 0, text: `${fmtBytes(stats.memUsage)} / ${fmtBytes(stats.memLimit)}` },
        ]).map((m) => (
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs text-neutral-400"><span>{m.label}</span><span class="mono">{m.text}</span></div>
            <div class="h-1.5 overflow-hidden rounded bg-harbor-800">
              <div class={`h-full rounded ${m.pct > 85 ? "bg-signal-500" : "bg-tide-400"}`} style={`width:${m.pct.toFixed(1)}%`} />
            </div>
          </div>
        ))}
        <div class="flex justify-between text-xs text-neutral-400">
          <span>网络</span>
          <span class="mono">↓ {fmtBytes(stats.netRx)} · ↑ {fmtBytes(stats.netTx)}</span>
        </div>
      </div>
    )}
  </div>
);

export const ServiceDrawer: Component<{
  target: DeployTarget;
  svc?: string;
  tab: ServiceTab;
  deployments?: Deployment[];
  envText?: string;
  domains?: Domain[];
  backups?: { file: string; size: number; at: Date }[];
  metrics?: { state: string; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number } | null;
  dbRefs?: DbRef[];
  selectedDeps?: number[];
  resources?: { cpuCores?: number; memoryMb?: number };
  notice?: string;
  error?: string;
}> = ({ target, svc, tab, deployments, envText, domains, backups, metrics, dbRefs, selectedDeps, resources, notice, error }) => {
  const isDbInstance = target.kind === "db" && !target.instanceOf;
  const tabs: { key: ServiceTab; label: string }[] = [
    { key: "deployments", label: "Deployments" },
    { key: "logs", label: "Logs" },
    ...(svc ? [{ key: "variables" as const, label: "Variables" }] : []),
    { key: "metrics", label: "Metrics" },
    { key: "settings", label: "Settings" },
    ...(isDbInstance ? [{ key: "backups" as const, label: "Backups" }] : []),
  ];
  const tabUrl = (k: ServiceTab) =>
    `${routes.deploy.uiTargetsByIdService(target.id)}?tab=${k}${svc ? `&svc=${encodeURIComponent(svc)}` : ""}`;
  const svcField = svc ? <input type="hidden" name="svc" value={svc} /> : null;
  return (
    <Drawer wide title={svc ? `${target.name} / ${svc}` : target.name} sub={svc ? "服务" : target.kind === "db" ? "数据库" : "应用"}>
      <div class="flex flex-col gap-4">
        {/* Tab 栏（hx 换整抽屉，保留在 #modal-root） */}
        <div class="flex gap-1 border-b border-harbor-800 pb-2">
          {tabs.map((tb) => (
            <button
              hx-get={tabUrl(tb.key)}
              hx-target="#modal-root"
              hx-swap="innerHTML"
              class={`rounded px-2.5 py-1 text-xs transition-colors ${tab === tb.key ? "bg-brass-500/15 font-medium text-brass-500" : "text-neutral-400 hover:bg-harbor-800 hover:text-neutral-200"}`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {notice ? <div class="rounded bg-tide-400/10 px-3 py-2 text-xs text-tide-400">{notice}</div> : null}
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {tab === "deployments" ? (
          <>
            <div class="flex gap-2">
              <button
                class="rounded bg-brass-500 px-3 py-1.5 text-xs font-semibold text-harbor-950 hover:bg-brass-600"
                {...{ onclick: `htmx.ajax('POST','${routes.deploy.targetsByIdDeploy(target.id)}',{swap:'none'}).then(()=>htmx.ajax('GET','${routes.deploy.uiTargetsByIdLog(target.id)}',{target:'#modal-root',swap:'innerHTML'}))` }}
              >
                重新部署
              </button>
              <form hx-post={routes.deploy.targetsByIdServiceRestart(target.id)} hx-target="#modal-root" hx-swap="innerHTML">
                {svcField}
                <button class="rounded border border-harbor-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-harbor-800" type="submit">
                  重启{svc ? "服务" : "容器"}
                </button>
              </form>
            </div>
            <div class="flex flex-col">
              {(deployments ?? []).length === 0 ? <div class="py-4 text-center text-xs text-neutral-600">还没有部署记录</div> : null}
              {(deployments ?? []).map((d) => (
                <div class="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
                  <Chip tone={d.status === "success" ? "ok" : d.status === "failed" ? "warn" : "muted"}>{d.status}</Chip>
                  <span class="text-neutral-500">#{d.id}</span>
                  <span class="text-neutral-400">{fmtAgo(d.startedAt)}</span>
                  {d.finishedAt ? <span class="mono text-neutral-600">{Math.round((new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) / 1000)}s</span> : null}
                  <button
                    class="ml-auto text-tide-400 hover:text-tide-300"
                    hx-get={`${routes.deploy.uiTargetsByIdLog(target.id)}?dep=${d.id}`}
                    hx-target="#modal-root"
                    hx-swap="innerHTML"
                  >
                    日志
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {tab === "logs" ? (
          <pre
            class="mono max-h-[70vh] overflow-auto rounded bg-harbor-950 p-3 text-xs leading-relaxed whitespace-pre-wrap text-neutral-300"
            hx-get={`${routes.deploy.uiTargetsByIdServiceLogs(target.id)}${svc ? `?svc=${encodeURIComponent(svc)}` : ""}`}
            hx-trigger="load, every 2s"
            hx-swap="innerHTML"
          >
            加载中…
          </pre>
        ) : null}

        {tab === "variables" && svc ? (
          <form class="flex flex-col gap-3" hx-post={routes.deploy.targetsByIdServiceEnv(target.id)} hx-target="#modal-root" hx-swap="innerHTML">
            {svcField}
            <p class="text-xs text-neutral-500">
              随 override compose 注入该服务容器（enc1: 加密保存在控制面本地，不入 git），重新部署后生效。
            </p>
            {(dbRefs ?? []).length > 0 ? (
              <Section title="引用数据库" hint="勾选 = 画布连线 + 连接串追加进变量">
                <DbRefPicker refs={dbRefs ?? []} selected={selectedDeps ?? []} />
              </Section>
            ) : null}
            <textarea class={`${inputCls} mono h-56 px-3 py-2 text-xs leading-relaxed`} name="envText" placeholder="KEY=value">{envText ?? ""}</textarea>
            <SubmitBtn label="保存变量" busy="保存中…" />
          </form>
        ) : null}

        {tab === "metrics" ? <MetricsPanel targetId={target.id} svc={svc} stats={metrics} /> : null}

        {tab === "settings" ? (
          <>
            {svc ? (
              <Section title="资源限制" hint="override compose · 重新部署生效">
                <form class="flex items-end gap-2" hx-post={routes.deploy.targetsByIdServiceResources(target.id)} hx-target="#modal-root" hx-swap="innerHTML">
                  {svcField}
                  <label class="flex flex-1 flex-col gap-0.5">
                    <span class={labelCls}>CPU 上限（核）</span>
                    <input class={inputCls} type="number" step="0.1" min="0" name="cpuCores" value={resources?.cpuCores ? String(resources.cpuCores) : ""} placeholder="不限" />
                  </label>
                  <label class="flex flex-1 flex-col gap-0.5">
                    <span class={labelCls}>内存上限（MB）</span>
                    <input class={inputCls} type="number" min="0" name="memoryMb" value={resources?.memoryMb ? String(resources.memoryMb) : ""} placeholder="不限" />
                  </label>
                  <SubmitBtn label="保存" busy="…" />
                </form>
              </Section>
            ) : null}
            <Section title="源">
              <div class="flex flex-col gap-1 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5 text-xs text-neutral-400">
                {target.repoUrl ? <div class="mono">{target.repoUrl}@{target.branch}</div> : null}
                {target.kind === "db" ? <div>类型 {target.dbType}{target.instanceOf ? "（逻辑库）" : "（实例）"}</div> : null}
                {svc ? <div class="mono">compose 服务 {svc} · {target.composePath}</div> : null}
                <div class="mono text-neutral-600">{target.remoteDir}</div>
              </div>
            </Section>
            <Section title="域名" hint="edge 反代 + 自动证书">
              <div class="flex flex-col gap-1.5">
                {(domains ?? []).filter((d) => (svc ? d.serviceName === svc : true)).map((d) => (
                  <div class="flex items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs">
                    <span class="mono text-neutral-200">{d.hostname}</span>
                    <span class="text-neutral-600">:{d.targetPort}</span>
                    {dnsChip(d)}{sslChip(d)}
                    <button
                      class="ml-auto text-neutral-600 hover:text-signal-500"
                      hx-delete={`${routes.deploy.targetsByIdServiceDomainsByDomainId(target.id, d.id)}${svc ? `?svc=${encodeURIComponent(svc)}` : ""}`}
                      hx-target="#modal-root"
                      hx-swap="innerHTML"
                      hx-confirm={`解绑 ${d.hostname}？`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <form class="flex items-end gap-2" hx-post={routes.deploy.targetsByIdServiceDomains(target.id)} hx-target="#modal-root" hx-swap="innerHTML">
                  {svcField}
                  <label class="flex flex-1 flex-col gap-0.5">
                    <span class={labelCls}>域名</span>
                    <input class={inputCls} type="text" name="hostname" placeholder="api.example.com" required />
                  </label>
                  <label class="flex w-20 flex-col gap-0.5">
                    <span class={labelCls}>端口</span>
                    <input class={inputCls} type="number" name="targetPort" required />
                  </label>
                  <SubmitBtn label="绑定" busy="…" />
                </form>
              </div>
            </Section>
          </>
        ) : null}

        {tab === "backups" && isDbInstance ? (
          <>
            <form hx-post={routes.deploy.targetsByIdBackup(target.id)} hx-target="#modal-root" hx-swap="innerHTML">
              <SubmitBtn label="立即备份" busy="备份中…（远端 dump → 本地落盘）" />
            </form>
            <div class="flex flex-col">
              {(backups ?? []).length === 0 ? <div class="py-4 text-center text-xs text-neutral-600">还没有备份</div> : null}
              {(backups ?? []).map((b) => (
                <div class="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
                  <span class="mono text-neutral-300">{b.file}</span>
                  <span class="text-neutral-600">{fmtBytes(b.size)}</span>
                  <span class="text-neutral-500">{fmtAgo(b.at)}</span>
                  <a class="ml-auto text-tide-400 hover:text-tide-300" href={routes.deploy.backupsByIdByFile(target.id, b.file)} download={b.file}>
                    下载
                  </a>
                </div>
              ))}
            </div>
            <p class="text-[11px] text-neutral-600">备份保存在控制面本地（~/.local/share/dockyard/backups/）。恢复请下载后在服务器上手动执行，避免误覆盖。</p>
          </>
        ) : null}
      </div>
    </Drawer>
  );
};

// 模块约定：.ui.tsx 需 default export（deploy 无独立页面，占位）
const DeployUi: Component = () => <div class="text-sm text-neutral-400">deploy 模块（无独立页面）</div>;
export default DeployUi;
