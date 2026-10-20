/** @jsxImportSource react */
/**
 * 画布抽屉/弹窗（原 deploy.ui.tsx 的 React 重写）：数据走 /api/canvas JSON，
 * 写操作 JSON 进出，错误内联回显；结构变更后 emitRefresh() 让画布重拉。
 * 替代了旧的 htmx.ajax 桥 + 服务端片段交换。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Deployment, DeployTarget, Domain } from "../../../shared/schema";
import type { RepoBrief } from "../../github/github.service";
import type { DbRef } from "../../deploy/deploy.service";
import type { DetectResult, DetectedService } from "../../deploy/detect";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { serviceEnvToText, textToEnvMap } from "../../deploy/env-text";
import { api, delJSON, getJSON, postJSON } from "./api";
import { ConsoleView } from "./console";
import { emitRefresh, useUi } from "./ui";

// ── 壳与通用件 ──

const Modal = ({ title, wide, children, onClose }: { title: string; wide?: boolean; children: React.ReactNode; onClose: () => void }) => (
  <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`${wide ? "w-[42rem]" : "w-96"} max-h-[85vh] overflow-y-auto rounded border border-harbor-700 bg-harbor-900 p-5 shadow-2xl`}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
        <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>✕</button>
      </div>
      {children}
    </div>
  </div>
);

/** 右侧抽屉（Railway 式配置面板） */
const Drawer = ({ title, sub, wide, children, onClose }: { title: string; sub?: string; wide?: boolean; children: React.ReactNode; onClose: () => void }) => (
  <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`fixed inset-y-0 right-0 left-auto flex h-full ${wide ? "w-[50vw]" : "w-[36rem]"} max-w-full flex-col border-l border-harbor-700 bg-harbor-900 shadow-2xl`}>
      <div className="flex items-start justify-between border-b border-harbor-800 px-5 py-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
          {sub ? <p className="text-xs text-neutral-500">{sub}</p> : null}
        </div>
        <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>✕</button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  </div>
);

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2">
    <div className="flex items-baseline justify-between">
      <h4 className="text-xs font-semibold tracking-wide text-neutral-300 uppercase">{title}</h4>
      {hint ? <span className="text-[11px] text-neutral-600">{hint}</span> : null}
    </div>
    {children}
  </section>
);

const ErrorBanner = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded bg-signal-500/15 px-3 py-2 text-xs text-signal-500">{children}</div>
);

const Notice = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded bg-tide-400/10 px-3 py-2 text-xs text-tide-400">{children}</div>
);

const Chip = ({ tone = "muted", children }: { tone?: "ok" | "warn" | "muted"; children: React.ReactNode }) => (
  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${
    tone === "ok" ? "bg-tide-400/10 text-tide-400"
    : tone === "warn" ? "bg-brass-500/15 text-brass-500"
    : "bg-harbor-800 text-neutral-500"
  }`}>{children}</span>
);

const inputCls = "rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200";
const labelCls = "text-[11px] text-neutral-500";

const Field = ({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <label className="flex flex-col gap-1 text-sm">
    <span className="text-xs text-neutral-500">{label}</span>
    <input className="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500" {...props} />
  </label>
);

/** 提交按钮（React 版 busy 状态：识别要调 gh API / 部署要克隆，必须给用户即时反馈） */
const SubmitBtn = ({ label, busyLabel, busy }: { label: string; busyLabel: string; busy: boolean }) => (
  <button
    type="submit"
    disabled={busy}
    className="inline-flex items-center justify-center gap-2 rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 transition-colors hover:bg-brass-600 disabled:pointer-events-none disabled:opacity-70"
  >
    {busy ? <span className="animate-spin">◌</span> : null}
    {busy ? busyLabel : label}
  </button>
);

// ── 共享类型（与 canvas.actions.tsx 的 JSON 响应对齐）──

interface Carry { nodeId: number; name: string; repoUrl?: string; branch: string; remoteDir: string }
interface SharedMatch { service: string; name: string; dbType: string; envKey: string; url: string; displayUrl: string }
interface DetectStepData { carry: Carry; detect: DetectResult; envText: string; dbRefs: DbRef[]; sharedMatches: SharedMatch[] }
type NewAppData =
  | { mode: "github"; repos: RepoBrief[]; error?: string; prefillRepo?: string }
  | ({ mode: "local" } & DetectStepData);

// ── 部署 app 向导（Railway/openship 两步式，右侧抽屉）──

export function NewAppWizard({ nodeId }: { nodeId: number }) {
  const ui = useUi();
  const [data, setData] = useState<NewAppData | null>(null);
  const [step2, setStep2] = useState<DetectStepData | null>(null);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    getJSON<NewAppData>(api.newAppByNodeId(nodeId))
      .then((d) => {
        if (d.mode === "local") setStep2(d);
        else setData(d);
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [nodeId]);

  if (step2) return <AppDetectStep data={step2} onBack={step2.carry.repoUrl ? () => setStep2(null) : undefined} />;
  if (loadError) return <Drawer title="部署 app" onClose={ui.close}><ErrorBanner>{loadError}</ErrorBanner></Drawer>;
  if (!data || data.mode !== "github") return <Drawer title="部署 app" onClose={ui.close}><div className="text-xs text-neutral-500">加载中…</div></Drawer>;
  return <NewAppStep1 nodeId={nodeId} repos={data.repos} initialError={data.error} prefillRepo={data.prefillRepo} onDetected={setStep2} />;
}

function NewAppStep1({ nodeId, repos, initialError, prefillRepo, onDetected }: {
  nodeId: number; repos: RepoBrief[]; initialError?: string; prefillRepo?: string;
  onDetected: (d: DetectStepData) => void;
}) {
  const ui = useUi();
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [repoUrl, setRepoUrl] = useState(prefillRepo ?? "");

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const d = await postJSON<DetectStepData>(api.detect(), {
        nodeId,
        name: String(fd.get("name") ?? ""),
        repoUrl: String(fd.get("repoUrl") ?? ""),
        branch: String(fd.get("branch") ?? "main") || "main",
        remoteDir: String(fd.get("remoteDir") ?? ""),
      });
      onDetected(d);
    } catch (err) {
      setError(`识别失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="部署 app" sub="从 GitHub 仓库部署到这台服务器" onClose={ui.close}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <Section title="仓库" hint={`gh 账号下 ${repos.length} 个`}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">选择仓库（可输入过滤）</span>
            <input
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
              type="text" name="repoUrl" list="gh-repos" placeholder="owner/repo"
              autoComplete="off" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required
            />
            <datalist id="gh-repos">
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>{`${r.private ? "🔒" : "🌐"} ${r.branch}`}</option>
              ))}
            </datalist>
          </label>
        </Section>
        <Section title="基本">
          <div className="grid grid-cols-2 gap-2">
            <Field label="名称" name="name" placeholder="my-app" required defaultValue={repoUrl.split("/")[1] ?? ""} key={repoUrl} />
            <Field label="分支" name="branch" defaultValue="main" />
          </div>
          <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-app" required defaultValue={repoUrl.split("/")[1] ? `~/dockyard/${repoUrl.split("/")[1]}` : ""} key={`dir-${repoUrl}`} />
        </Section>
        <div className="text-xs text-neutral-500">下一步会读取仓库的 openship.json / compose 自动识别服务、端口与域名。</div>
        <SubmitBtn label="下一步：识别仓库" busyLabel="识别中…（调 GitHub API，通常几秒）" busy={busy} />
      </form>
    </Drawer>
  );
}

/** 服务行编辑状态（step2 受控） */
interface SvcEdit {
  name: string; exposed: boolean; port?: number; domain?: string;
  cpuCores?: number; memoryMb?: number; envText: string;
}

const svcEditOf = (s: DetectedService): SvcEdit => ({
  name: s.name, exposed: s.exposed, port: s.port, domain: s.domain,
  cpuCores: s.cpuCores, memoryMb: s.memoryMb, envText: serviceEnvToText(s.env),
});

const numOrUndef = (v: string) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Step 2：识别结果确认。errors 硬阻断，warnings 只提示 */
function AppDetectStep({ data, onBack }: { data: DetectStepData; onBack?: () => void }) {
  const ui = useUi();
  const { carry, detect, dbRefs, sharedMatches } = data;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [services, setServices] = useState<SvcEdit[]>(detect.services.map(svcEditOf));
  const [envText, setEnvText] = useState(data.envText);
  const [composePath, setComposePath] = useState(detect.composePath);
  const [depIds, setDepIds] = useState<number[]>([]);
  const [reuse, setReuse] = useState<Set<string>>(new Set(sharedMatches.map((m) => m.service)));

  /** envText 行的声明式增删（替代旧 onchange 行内脚本） */
  const syncEnvLine = (line: string, on: boolean) =>
    setEnvText((cur) => {
      const lines = cur.split("\n").filter((l) => l.trim() && l !== line);
      if (on) lines.push(line);
      return lines.join("\n");
    });

  const patchSvc = (name: string, patch: Partial<SvcEdit>) =>
    setServices((cur) => cur.map((s) => (s.name === name ? { ...s, ...patch } : s)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { targetId } = await postJSON<{ targetId: number }>(api.targetsApp(), {
        nodeId: carry.nodeId,
        name: carry.name,
        repoUrl: carry.repoUrl || undefined,
        branch: carry.branch,
        composePath,
        remoteDir: carry.remoteDir,
        envText,
        services: services.map((s) => ({
          name: s.name,
          exposed: s.exposed,
          port: s.exposed ? s.port : undefined,
          domain: s.domain || undefined,
          cpuCores: s.cpuCores,
          memoryMb: s.memoryMb,
          env: textToEnvMap(s.envText),
        })),
        depIds,
        reuse: [...reuse],
      });
      emitRefresh();
      ui.open({ kind: "log", targetId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={carry.name} sub={carry.repoUrl ? `${carry.repoUrl}@${carry.branch}` : "本地文件夹导入"} onClose={ui.close}>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          识别来源
          {detect.source === "openship.json" ? <Chip tone="ok">openship.json</Chip>
            : detect.source === "compose" ? <Chip tone="warn">compose 探测</Chip>
            : <Chip tone="warn">未识别</Chip>}
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        {detect.errors.map((er) => <ErrorBanner key={er}>{er}</ErrorBanner>)}
        {detect.warnings.length > 0 ? (
          <div className="rounded bg-brass-500/10 px-3 py-2 text-xs text-brass-500">
            {detect.warnings.map((w) => <div key={w}>⚠️ {w}</div>)}
          </div>
        ) : null}

        {services.length > 0 ? (
          <Section title="服务" hint={`${services.length} 个 · 端口/域名/资源`}>
            {services.map((svc) => (
              <div key={svc.name} className="rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-medium text-neutral-200 mono">{svc.name}</span>
                  {svc.exposed ? <Chip tone="ok">对外</Chip> : <Chip>内部</Chip>}
                  {svc.cpuCores || svc.memoryMb ? (
                    <Chip tone="warn">
                      {[svc.cpuCores ? `${svc.cpuCores}C` : "", svc.memoryMb ? `${svc.memoryMb}M` : ""].filter(Boolean).join(" ")}
                    </Chip>
                  ) : null}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <label className="flex flex-col gap-0.5">
                    <span className={labelCls}>
                      <input
                        type="checkbox" checked={svc.exposed} className="mr-1 accent-brass-500"
                        onChange={(e) => patchSvc(svc.name, { exposed: e.target.checked })}
                      />
                      对外端口
                    </span>
                    <input
                      className={`${inputCls} disabled:opacity-40`} type="number" placeholder="内部"
                      value={svc.port ?? ""} disabled={!svc.exposed}
                      onChange={(e) => patchSvc(svc.name, { port: numOrUndef(e.target.value) })}
                    />
                  </label>
                  <label className="col-span-3 flex flex-col gap-0.5">
                    <span className={labelCls}>绑定域名（留空 = 不绑，需先勾对外）</span>
                    <input className={inputCls} type="text" placeholder="api.example.com" value={svc.domain ?? ""}
                      onChange={(e) => patchSvc(svc.name, { domain: e.target.value })} />
                  </label>
                  <label className="col-span-2 flex flex-col gap-0.5">
                    <span className={labelCls}>CPU 上限（核）</span>
                    <input className={inputCls} type="number" step="0.1" placeholder="不限" value={svc.cpuCores ?? ""}
                      onChange={(e) => patchSvc(svc.name, { cpuCores: numOrUndef(e.target.value) })} />
                  </label>
                  <label className="col-span-2 flex flex-col gap-0.5">
                    <span className={labelCls}>内存上限（MB）</span>
                    <input className={inputCls} type="number" placeholder="不限" value={svc.memoryMb ?? ""}
                      onChange={(e) => patchSvc(svc.name, { memoryMb: numOrUndef(e.target.value) })} />
                  </label>
                </div>
                {svc.envText.trim() ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-neutral-500 select-none">
                      环境变量 · 随 override 注入容器
                    </summary>
                    <textarea
                      className={`${inputCls} mono mt-1 h-28 w-full px-2 py-1.5 text-[11px] leading-relaxed`}
                      value={svc.envText}
                      onChange={(e) => patchSvc(svc.name, { envText: e.target.value })}
                    />
                  </details>
                ) : null}
              </div>
            ))}
          </Section>
        ) : null}

        {sharedMatches.length > 0 ? (
          <Section title="复用服务器资源？" hint="前置检查：服务器已有匹配的共享中间件">
            <div className="flex flex-col gap-1.5">
              {sharedMatches.map((m) => (
                <label key={m.service} className="flex cursor-pointer items-center gap-2 rounded border border-tide-400/30 bg-tide-400/5 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-tide-400/70">
                  <input
                    type="checkbox" checked={reuse.has(m.service)} className="accent-tide-400"
                    onChange={(e) => {
                      const on = e.target.checked;
                      setReuse((cur) => {
                        const next = new Set(cur);
                        if (on) next.add(m.service); else next.delete(m.service);
                        return next;
                      });
                      syncEnvLine(`${m.envKey}=${m.url}`, on);
                    }}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span>服务 <span className="mono text-neutral-200">{m.service}</span> 复用共享资源「{m.name}」（{m.dbType}）→ <span className="mono text-tide-400">{m.envKey}</span></span>
                    <span className="mono truncate text-[10px] text-neutral-600">{m.displayUrl}</span>
                  </span>
                </label>
              ))}
              <div className="text-[11px] text-neutral-600">勾选 = 跳过该中间件部署，自动注入共享连接串；取消 = 随项目完整部署。</div>
            </div>
          </Section>
        ) : null}

        {dbRefs.length > 0 ? (
          <Section title="依赖数据库" hint="画布连线 + 注入连接串">
            <DbRefPicker refs={dbRefs} selected={depIds} onToggle={(r, on) => {
              setDepIds((cur) => (on ? [...cur, r.id] : cur.filter((id) => id !== r.id)));
              syncEnvLine(`${r.envKey}=${r.url}`, on);
            }} />
          </Section>
        ) : null}

        <Section title="变量" hint="compose 插值用 · 加密保存">
          <textarea
            className={`${inputCls} mono h-28 px-3 py-2 text-xs leading-relaxed`}
            placeholder="KEY=value" value={envText} onChange={(e) => setEnvText(e.target.value)}
          />
        </Section>

        <Section title="打包" hint="compose 构建与部署">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">compose 文件路径</span>
            <input className={`${inputCls} px-3 py-1.5`} type="text" value={composePath} required
              onChange={(e) => setComposePath(e.target.value)} />
          </label>
        </Section>

        <div className="flex flex-col gap-2 border-t border-harbor-800 pt-4">
          <div className="text-xs text-neutral-500">创建后立即部署并打开日志。</div>
          <div className="flex gap-2">
            {onBack ? (
              <button type="button" className="rounded border border-harbor-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-harbor-800" onClick={onBack}>
                上一步
              </button>
            ) : null}
            <SubmitBtn label="创建并部署" busyLabel="创建中…" busy={busy} />
          </div>
        </div>
      </form>
    </Drawer>
  );
}

/** 数据库依赖选择器：勾选 = 记录血缘（画布连线）+ 把连接串注入 envText */
const DbRefPicker = ({ refs, selected, onToggle }: { refs: DbRef[]; selected: number[]; onToggle: (r: DbRef, on: boolean) => void }) => (
  <div className="flex flex-col gap-1.5">
    {refs.map((r) => (
      <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-brass-500/60 has-checked:bg-brass-500/5">
        <input
          type="checkbox" checked={selected.includes(r.id)} className="accent-brass-500"
          onChange={(e) => onToggle(r, e.target.checked)}
        />
        <span className="shrink-0 text-neutral-200">{r.logical ? "⛁" : "🗄"} {r.name}</span>
        <span className="flex min-w-0 flex-col">
          <span className="text-neutral-600">
            {r.dbType}{r.logical ? " · 逻辑库" : ""} → <span className="mono text-tide-400">{r.envKey}</span>
          </span>
          <span className="mono truncate text-[10px] text-neutral-700">{r.displayUrl}</span>
        </span>
      </label>
    ))}
    <div className="text-[11px] text-neutral-600">勾选即注入连接串到下方变量；取消即移除。多个同类型数据库请自行改变量名。</div>
  </div>
);

// ── 新建数据库 ──

type DbType = "postgres" | "mysql" | "redis" | "mongo";

export function NewDbModal({ nodeId }: { nodeId: number }) {
  const ui = useUi();
  const [dbType, setDbType] = useState<DbType>("postgres");
  const [instances, setInstances] = useState<DeployTarget[]>([]);
  const [instanceId, setInstanceId] = useState<string>("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInstanceId("");
    getJSON<{ instances: DeployTarget[] }>(`${api.instances()}?nodeId=${nodeId}&dbType=${dbType}`)
      .then((d) => setInstances(d.instances))
      .catch(() => setInstances([]));
  }, [nodeId, dbType]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await postJSON(api.targetsDb(), {
        nodeId,
        name: String(fd.get("name") ?? ""),
        dbType,
        instanceId: instanceId || undefined,
        remoteDir: String(fd.get("remoteDir") ?? "") || undefined,
      });
      emitRefresh();
      ui.close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="部署数据库（官方镜像）" onClose={ui.close}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="名称" name="name" placeholder="my-pg" required />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">类型</span>
          <select
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
            value={dbType} onChange={(e) => setDbType(e.target.value as DbType)}
          >
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="redis">Redis</option>
            <option value="mongo">MongoDB</option>
          </select>
        </label>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2 text-neutral-300">
            <input type="radio" name="instanceId" value="" checked={instanceId === ""} onChange={() => setInstanceId("")} /> 新建实例
          </label>
          {instances.map((i) => (
            <label key={i.id} className="flex items-center gap-2 text-neutral-300">
              <input type="radio" name="instanceId" value={String(i.id)} checked={instanceId === String(i.id)} onChange={() => setInstanceId(String(i.id))} />
              在「{i.name}」中新建逻辑库（省一个容器的开销）
            </label>
          ))}
          {instances.length > 0 ? (
            <div className="text-xs text-neutral-500">选现有实例时无需填远端目录，凭据自动生成。</div>
          ) : null}
        </div>
        <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-pg（新建实例时必填）" />
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <div className="text-xs text-neutral-500">凭据自动生成并加密保存，数据卷持久化。</div>
        <SubmitBtn label="创建并部署" busyLabel="创建中…" busy={busy} />
      </form>
    </Modal>
  );
}

// ── 域名管理 ──

const dnsChip = (d: Domain) =>
  d.dnsStatus === "ok" ? <Chip tone="ok">DNS ✓</Chip>
  : d.dnsStatus === "mismatch" ? <Chip tone="warn">DNS 未指向本机</Chip>
  : <Chip>DNS 未检测</Chip>;
const sslChip = (d: Domain) =>
  d.sslStatus === "active" ? <Chip tone="ok">🔒 HTTPS</Chip>
  : d.sslStatus === "pending" ? <Chip tone="warn">证书待签发</Chip>
  : d.sslStatus === "error" ? <Chip tone="warn">证书异常</Chip>
  : <Chip>无证书</Chip>;

interface DomainsData { target: DeployTarget; domains: Domain[] }

export function DomainsModal({ targetId }: { targetId: number }) {
  const ui = useUi();
  const [data, setData] = useState<DomainsData | null>(null);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    getJSON<DomainsData>(api.targetsByIdDomains(targetId)).then(setData).catch((e) => setError((e as Error).message));
  }, [targetId]);
  useEffect(load, [load]);

  const remove = async (d: Domain) => {
    if (!confirm(`解绑 ${d.hostname}？`)) return;
    try {
      await delJSON(api.domainsById(d.id));
      emitRefresh();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await postJSON(api.targetsByIdDomains(targetId), {
        hostname: String(fd.get("hostname") ?? ""),
        targetPort: Number(fd.get("targetPort")),
      });
      e.currentTarget.reset();
      emitRefresh();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={`域名 — ${data?.target.name ?? "…"}`} onClose={ui.close}>
      <div className="flex flex-col gap-3">
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        {data && data.domains.length === 0 ? <div className="text-xs text-neutral-500">还没有绑定域名。绑定后自动反代并签发 HTTPS 证书。</div> : null}
        {(data?.domains ?? []).map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
            <div className="flex flex-col gap-1">
              <a className="text-xs font-medium text-tide-400 hover:text-tide-300 mono" href={`https://${d.hostname}`} target="_blank" rel="noreferrer">{d.hostname}</a>
              <span className="text-[11px] text-neutral-500 mono">→ :{d.targetPort}{d.serviceName ? `（${d.serviceName}）` : ""}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {dnsChip(d)}{sslChip(d)}
              <button className="text-neutral-600 hover:text-signal-500" onClick={() => void remove(d)}>✕</button>
            </div>
          </div>
        ))}
        <form className="flex items-end gap-2" onSubmit={submit}>
          <label className="flex flex-1 flex-col gap-0.5">
            <span className={labelCls}>域名</span>
            <input className={inputCls} type="text" name="hostname" placeholder="app.example.com" required />
          </label>
          <label className="flex w-24 flex-col gap-0.5">
            <span className={labelCls}>端口</span>
            <input className={inputCls} type="number" name="targetPort" required />
          </label>
          <button type="submit" className="rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 hover:bg-brass-600">绑定</button>
        </form>
        <div className="text-xs text-neutral-500">域名 A 记录指向服务器 IP 后，证书会自动签发。</div>
      </div>
    </Modal>
  );
}

// ── 变量抽屉（已有 app 改 .env + 数据库依赖）──

interface EnvData { target: DeployTarget; envText: string; dbRefs: DbRef[]; selectedDeps: number[] }

export function EnvDrawer({ targetId }: { targetId: number }) {
  const ui = useUi();
  const [data, setData] = useState<EnvData | null>(null);
  const [envText, setEnvText] = useState("");
  const [depIds, setDepIds] = useState<number[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getJSON<EnvData>(api.targetsByIdEnv(targetId)).then((d) => {
      setData(d);
      setEnvText(d.envText);
      setDepIds(d.selectedDeps);
    }).catch((e) => setError((e as Error).message));
  }, [targetId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await postJSON(api.targetsByIdEnv(targetId), { envText, depIds });
      emitRefresh();
      ui.close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={`变量 — ${data?.target.name ?? "…"}`} sub="保存后重新部署生效" onClose={ui.close}>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        {data && data.dbRefs.length > 0 ? (
          <Section title="依赖数据库" hint="画布连线 + 注入连接串">
            <DbRefPicker refs={data.dbRefs} selected={depIds} onToggle={(r, on) => {
              setDepIds((cur) => (on ? [...cur, r.id] : cur.filter((id) => id !== r.id)));
              const line = `${r.envKey}=${r.url}`;
              setEnvText((cur) => {
                const lines = cur.split("\n").filter((l) => l.trim() && l !== line);
                if (on) lines.push(line);
                return lines.join("\n");
              });
            }} />
          </Section>
        ) : null}
        <Section title="变量" hint="compose 插值用 · 加密保存">
          <textarea
            className={`${inputCls} mono h-56 px-3 py-2 text-xs leading-relaxed`}
            placeholder="KEY=value" value={envText} onChange={(e) => setEnvText(e.target.value)}
          />
        </Section>
        <SubmitBtn label="保存变量" busyLabel="保存中…" busy={busy} />
      </form>
    </Drawer>
  );
}

// ── 部署日志（1s 轮询直到终态）──

interface LogData { target: DeployTarget; dep: Deployment | null }

export function DeployLogModal({ targetId, dep }: { targetId: number; dep?: number }) {
  const ui = useUi();
  const [data, setData] = useState<LogData | null>(null);
  const [logText, setLogText] = useState("尚未部署");
  const activeRef = useRef(true);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    activeRef.current = true;
    getJSON<LogData>(`${api.targetsByIdLog(targetId)}${dep ? `?dep=${dep}` : ""}`)
      .then((d) => {
        setData(d);
        setLogText(d.dep?.logText ?? "尚未部署");
        const active = !d.dep || (d.dep.status !== "success" && d.dep.status !== "failed");
        if (active) {
          timer = setInterval(async () => {
            try {
              const res = await fetch(`${api.targetsByIdLogBody(targetId)}${dep ? `?dep=${dep}` : ""}`);
              const text = await res.text();
              setLogText(text || "尚未部署");
              // 终态停轮询：再拉一次头信息确认
              const head = await getJSON<LogData>(`${api.targetsByIdLog(targetId)}${dep ? `?dep=${dep}` : ""}`);
              if (head.dep && (head.dep.status === "success" || head.dep.status === "failed")) {
                setData(head);
                if (timer) clearInterval(timer);
              }
            } catch { /* 网络抖动下轮再说 */ }
          }, 1000);
        }
      })
      .catch(() => setLogText("加载失败"));
    return () => {
      activeRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [targetId, dep]);

  const depStatus = data?.dep?.status;
  return (
    <Modal title={`部署日志 — ${data?.target.name ?? "…"}`} wide onClose={ui.close}>
      {depStatus ? (
        <div className="mb-2">
          <Chip tone={depStatus === "success" ? "ok" : depStatus === "failed" ? "warn" : "muted"}>{depStatus}</Chip>
        </div>
      ) : null}
      <pre className="mono max-h-96 overflow-auto rounded bg-harbor-950 p-3 text-xs whitespace-pre-wrap text-neutral-300">
        {logText}
      </pre>
    </Modal>
  );
}

// ── 服务抽屉（Railway Service View）──

type ServiceTab = "deployments" | "source" | "hardware" | "network" | "env" | "monitor" | "console" | "backups";

interface Metrics { state: string; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number }

interface ServiceDrawerData {
  target: DeployTarget;
  svc?: string;
  tab: ServiceTab;
  deployments?: Deployment[];
  envText?: string;
  dbRefs?: DbRef[];
  sharedEnv?: { resourceId: number; name: string; dbType: string; envKey: string; url: string }[];
  selectedDeps?: number[];
  domains?: Domain[];
  resources?: { cpuCores?: number; memoryMb?: number };
  backups?: { file: string; size: number; at: string }[];
  metrics?: Metrics | null;
}

const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

const fmtAgo = (d: Date | string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return new Date(d).toLocaleDateString("zh-CN");
};

/** 一次性资源快照（4s 轮询） */
const MetricsPanel = ({ targetId, svc }: { targetId: number; svc?: string }) => {
  const [stats, setStats] = useState<Metrics | null | undefined>(undefined);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const m = await getJSON<Metrics | null>(`${api.targetsByIdServiceMetrics(targetId)}${svc ? `?svc=${encodeURIComponent(svc)}` : ""}`);
        if (!stop) setStats(m);
      } catch {
        if (!stop) setStats(null);
      }
    };
    void tick();
    const timer = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [targetId, svc]);

  if (stats === undefined) return <div className="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">加载中…</div>;
  if (!stats) return <div className="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">指标不可用（容器未运行或服务器离线）</div>;
  if (stats.state !== "running") return <div className="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">容器状态:{stats.state}</div>;
  return (
    <div className="flex flex-col gap-3">
      {([
        { label: "CPU", pct: Math.min(100, stats.cpuPercent), text: `${stats.cpuPercent}%` },
        { label: "内存", pct: stats.memLimit ? Math.min(100, (stats.memUsage / stats.memLimit) * 100) : 0, text: `${fmtBytes(stats.memUsage)} / ${fmtBytes(stats.memLimit)}` },
      ]).map((m) => (
        <div key={m.label} className="flex flex-col gap-1">
          <div className="flex justify-between text-xs text-neutral-400"><span>{m.label}</span><span className="mono">{m.text}</span></div>
          <div className="h-1.5 overflow-hidden rounded bg-harbor-800">
            <div className={`h-full rounded ${m.pct > 85 ? "bg-signal-500" : "bg-tide-400"}`} style={{ width: `${m.pct.toFixed(1)}%` }} />
          </div>
        </div>
      ))}
      <div className="flex justify-between text-xs text-neutral-400">
        <span>网络</span>
        <span className="mono">↓ {fmtBytes(stats.netRx)} · ↑ {fmtBytes(stats.netTx)}</span>
      </div>
    </div>
  );
};

/** 服务日志（2s 轮询） */
const ServiceLogs = ({ targetId, svc }: { targetId: number; svc?: string }) => {
  const [text, setText] = useState("加载中…");
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${api.targetsByIdServiceLogs(targetId)}${svc ? `?svc=${encodeURIComponent(svc)}` : ""}`);
        if (!stop) setText(await res.text());
      } catch { /* 下轮再说 */ }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [targetId, svc]);
  return (
    <pre className="mono max-h-[40vh] overflow-auto rounded bg-harbor-950 p-3 text-xs leading-relaxed whitespace-pre-wrap text-neutral-300">
      {text}
    </pre>
  );
};

export function ServiceDrawer({ targetId, svc, initialTab }: { targetId: number; svc?: string; initialTab?: string }) {
  const ui = useUi();
  const [tab, setTab] = useState<ServiceTab>(
    (["deployments", "source", "hardware", "network", "env", "monitor", "console", "backups"].includes(initialTab ?? "")
      ? initialTab
      : "deployments") as ServiceTab,
  );
  const [data, setData] = useState<ServiceDrawerData | null>(null);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const d = await getJSON<ServiceDrawerData>(
        `${api.targetsByIdService(targetId)}?tab=${tab}${svc ? `&svc=${encodeURIComponent(svc)}` : ""}`,
      );
      setData(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [targetId, svc, tab]);
  useEffect(() => {
    setNotice(undefined);
    setError(undefined);
    void load();
  }, [load]);

  /** 写操作统一出口：成功后提示 + 按需刷新画布/抽屉数据 */
  const mutate = async (fn: () => Promise<{ notice?: string }>, opts: { refreshBoard?: boolean; reload?: boolean } = {}) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const r = await fn();
      if (r.notice) setNotice(r.notice);
      if (opts.refreshBoard) emitRefresh();
      if (opts.reload !== false) await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const target = data?.target;
  const isDbInstance = target?.kind === "db" && !target.instanceOf;
  const tabs: { key: ServiceTab; label: string }[] = [
    { key: "source", label: "Source" },
    ...(svc ? [{ key: "hardware" as const, label: "Hardware" }] : []),
    { key: "network", label: "Network" },
    ...(svc ? [{ key: "env" as const, label: "Env" }] : []),
    { key: "monitor", label: "Monitor" },
    { key: "console", label: "Console" },
    { key: "deployments", label: "Deployments" },
    ...(isDbInstance ? [{ key: "backups" as const, label: "Backups" }] : []),
  ];

  return (
    <Drawer wide title={svc ? `${target?.name ?? "…"} / ${svc}` : target?.name ?? "…"} sub={svc ? "服务" : target?.kind === "db" ? "数据库" : "应用"} onClose={ui.close}>
      <div className="flex flex-col gap-4">
        <div className="flex gap-1 border-b border-harbor-800 pb-2">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${tab === tb.key ? "bg-brass-500/15 font-medium text-brass-500" : "text-neutral-400 hover:bg-harbor-800 hover:text-neutral-200"}`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {notice ? <Notice>{notice}</Notice> : null}
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        {!data ? <div className="text-xs text-neutral-500">加载中…</div> : null}

        {data && tab === "deployments" ? <DeploymentsTab data={data} svc={svc} mutate={mutate} /> : null}
        {data && tab === "monitor" ? (
          <>
            <MetricsPanel targetId={targetId} svc={svc} />
            <Section title="日志" hint="2s 轮询">
              <ServiceLogs targetId={targetId} svc={svc} />
            </Section>
          </>
        ) : null}
        {data && tab === "console" ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-neutral-500">进入{svc ? `服务 ${svc}` : "容器"}的交互式终端（docker exec）。关闭抽屉即断开。</p>
            <div className="h-[55vh] overflow-hidden rounded border border-harbor-800 bg-[#0b0f14] p-1">
              <ConsoleView targetId={targetId} service={svc} />
            </div>
          </div>
        ) : null}
        {data && tab === "env" && svc ? <ServiceEnvTab data={data} svc={svc} mutate={mutate} /> : null}
        {data && tab === "hardware" && svc ? <HardwareTab data={data} svc={svc} mutate={mutate} /> : null}
        {data && tab === "source" ? <SourceTab data={data} svc={svc} mutate={mutate} /> : null}
        {data && tab === "network" ? <NetworkTab data={data} svc={svc} mutate={mutate} /> : null}
        {data && tab === "backups" && isDbInstance ? <BackupsTab data={data} mutate={mutate} /> : null}
      </div>
    </Drawer>
  );
}

type Mutate = (fn: () => Promise<{ notice?: string }>, opts?: { refreshBoard?: boolean; reload?: boolean }) => Promise<void>;

function DeploymentsTab({ data, svc, mutate }: { data: ServiceDrawerData; svc?: string; mutate: Mutate }) {
  const ui = useUi();
  const t = data.target;
  return (
    <>
      <div className="flex gap-2">
        <button
          className="rounded bg-brass-500 px-3 py-1.5 text-xs font-semibold text-harbor-950 hover:bg-brass-600"
          onClick={async () => {
            await postJSON(api.targetsByIdDeploy(t.id));
            ui.open({ kind: "log", targetId: t.id });
          }}
        >
          重新部署
        </button>
        <button
          className="rounded border border-harbor-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-harbor-800"
          onClick={() => void mutate(() => postJSON(api.targetsByIdServiceRestart(t.id), { svc }), { reload: false })}
        >
          重启{svc ? "服务" : "容器"}
        </button>
      </div>
      <div className="flex flex-col">
        {(data.deployments ?? []).length === 0 ? <div className="py-4 text-center text-xs text-neutral-600">还没有部署记录</div> : null}
        {(data.deployments ?? []).map((d) => (
          <div key={d.id} className="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
            <Chip tone={d.status === "success" ? "ok" : d.status === "failed" ? "warn" : "muted"}>{d.status}</Chip>
            <span className="text-neutral-500">#{d.id}</span>
            <span className="text-neutral-400">{fmtAgo(d.startedAt)}</span>
            {d.finishedAt ? <span className="mono text-neutral-600">{Math.round((new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) / 1000)}s</span> : null}
            <button
              className="ml-auto text-tide-400 hover:text-tide-300"
              onClick={() => ui.open({ kind: "log", targetId: t.id, dep: d.id })}
            >
              日志
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function ServiceEnvTab({ data, svc, mutate }: { data: ServiceDrawerData; svc: string; mutate: Mutate }) {
  const [envText, setEnvText] = useState(data.envText ?? "");
  const [depIds, setDepIds] = useState<number[]>(data.selectedDeps ?? []);
  const t = data.target;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void mutate(() => postJSON(api.targetsByIdServiceEnv(t.id), { svc, envText, depIds }), { refreshBoard: true, reload: false });
      }}
    >
      <p className="text-xs text-neutral-500">
        随 override compose 注入该服务容器（enc1: 加密保存在控制面本地，不入 git），重新部署后生效。
      </p>
      {(data.sharedEnv ?? []).length > 0 ? (
        <Section title="服务器共享变量" hint="选择即追加连接串到下方变量">
          <select
            className={`${inputCls} px-2 py-1.5`} value=""
            onChange={(e) => {
              if (e.target.value) setEnvText((cur) => (cur.trim() ? `${cur.trim()}\n` : "") + e.target.value);
            }}
          >
            <option value="">选择共享变量…</option>
            {data.sharedEnv!.map((s) => (
              <option key={s.resourceId} value={`${s.envKey}=${s.url}`}>{s.name}（{s.dbType}）→ {s.envKey}</option>
            ))}
          </select>
        </Section>
      ) : null}
      {(data.dbRefs ?? []).length > 0 ? (
        <Section title="引用数据库" hint="勾选 = 画布连线 + 连接串追加进变量">
          <DbRefPicker refs={data.dbRefs!} selected={depIds} onToggle={(r, on) => {
            setDepIds((cur) => (on ? [...cur, r.id] : cur.filter((id) => id !== r.id)));
            const line = `${r.envKey}=${r.url}`;
            setEnvText((cur) => {
              const lines = cur.split("\n").filter((l) => l.trim() && l !== line);
              if (on) lines.push(line);
              return lines.join("\n");
            });
          }} />
        </Section>
      ) : null}
      <textarea
        className={`${inputCls} mono h-56 px-3 py-2 text-xs leading-relaxed`}
        placeholder="KEY=value" value={envText} onChange={(e) => setEnvText(e.target.value)}
      />
      <SubmitBtn label="保存变量" busyLabel="保存中…" busy={false} />
    </form>
  );
}

function HardwareTab({ data, svc, mutate }: { data: ServiceDrawerData; svc: string; mutate: Mutate }) {
  const t = data.target;
  return (
    <Section title="资源限制" hint="override compose · 重新部署生效">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void mutate(
            () => postJSON(api.targetsByIdServiceResources(t.id), {
              svc,
              cpuCores: numOrUndef(String(fd.get("cpuCores") ?? "")),
              memoryMb: numOrUndef(String(fd.get("memoryMb") ?? "")),
            }),
            { reload: false },
          );
        }}
      >
        <label className="flex flex-1 flex-col gap-0.5">
          <span className={labelCls}>CPU 上限（核）</span>
          <input className={inputCls} type="number" step="0.1" min="0" name="cpuCores" defaultValue={data.resources?.cpuCores ?? ""} placeholder="不限" />
        </label>
        <label className="flex flex-1 flex-col gap-0.5">
          <span className={labelCls}>内存上限（MB）</span>
          <input className={inputCls} type="number" min="0" name="memoryMb" defaultValue={data.resources?.memoryMb ?? ""} placeholder="不限" />
        </label>
        <SubmitBtn label="保存" busyLabel="…" busy={false} />
      </form>
    </Section>
  );
}

function SourceTab({ data, svc, mutate }: { data: ServiceDrawerData; svc?: string; mutate: Mutate }) {
  const t = data.target;
  return (
    <>
      {t.kind === "db" ? (
        <Section title="源">
          <div className="rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5 text-xs text-neutral-400">
            类型 {t.dbType}{t.instanceOf ? "（逻辑库）" : "（实例）"} · <span className="mono text-neutral-600">{t.remoteDir}</span>
          </div>
        </Section>
      ) : (
        <Section title="来源配置" hint="下次部署生效">
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              void mutate(
                () => postJSON(api.targetsByIdSource(t.id), {
                  repoUrl: String(fd.get("repoUrl") ?? "") || undefined,
                  branch: String(fd.get("branch") ?? "") || undefined,
                  composePath: String(fd.get("composePath") ?? "") || undefined,
                  remoteDir: String(fd.get("remoteDir") ?? "") || undefined,
                }),
                { reload: false },
              );
            }}
          >
            <label className="flex flex-col gap-0.5">
              <span className={labelCls}>GitHub 仓库（本地文件夹导入可留空）</span>
              <input className={inputCls} type="text" name="repoUrl" defaultValue={t.repoUrl ?? ""} placeholder="owner/repo" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5">
                <span className={labelCls}>分支</span>
                <input className={inputCls} type="text" name="branch" defaultValue={t.branch ?? "main"} />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className={labelCls}>compose 路径</span>
                <input className={inputCls} type="text" name="composePath" defaultValue={t.composePath ?? "docker-compose.yml"} />
              </label>
            </div>
            <label className="flex flex-col gap-0.5">
              <span className={labelCls}>远端目录</span>
              <input className={inputCls} type="text" name="remoteDir" defaultValue={t.remoteDir ?? ""} placeholder="~/dockyard/my-app" />
            </label>
            <div><SubmitBtn label="保存" busyLabel="…" busy={false} /></div>
          </form>
        </Section>
      )}
      {svc ? (
        <Section title="服务">
          <div className="mono rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5 text-xs text-neutral-400">
            compose 服务 {svc} · {t.composePath}
          </div>
        </Section>
      ) : null}
    </>
  );
}

function NetworkTab({ data, svc, mutate }: { data: ServiceDrawerData; svc?: string; mutate: Mutate }) {
  const t = data.target;
  return (
    <Section title="域名" hint="edge 反代 + 自动证书">
      <div className="flex flex-col gap-1.5">
        {(data.domains ?? []).filter((d) => (svc ? d.serviceName === svc : true)).map((d) => (
          <div key={d.id} className="flex items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs">
            <span className="mono text-neutral-200">{d.hostname}</span>
            <span className="text-neutral-600">:{d.targetPort}</span>
            {dnsChip(d)}{sslChip(d)}
            <button
              className="ml-auto text-neutral-600 hover:text-signal-500"
              onClick={() => {
                if (!confirm(`解绑 ${d.hostname}？`)) return;
                void mutate(
                  () => delJSON(`${api.targetsByIdServiceDomainsByDomainId(t.id, d.id)}${svc ? `?svc=${encodeURIComponent(svc)}` : ""}`),
                  { refreshBoard: true },
                );
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            void mutate(
              () => postJSON(api.targetsByIdServiceDomains(t.id), {
                svc,
                hostname: String(fd.get("hostname") ?? ""),
                targetPort: Number(fd.get("targetPort")),
              }),
              { refreshBoard: true },
            );
            e.currentTarget.reset();
          }}
        >
          <label className="flex flex-1 flex-col gap-0.5">
            <span className={labelCls}>域名</span>
            <input className={inputCls} type="text" name="hostname" placeholder="api.example.com" required />
          </label>
          <label className="flex w-20 flex-col gap-0.5">
            <span className={labelCls}>端口</span>
            <input className={inputCls} type="number" name="targetPort" required />
          </label>
          <SubmitBtn label="绑定" busyLabel="…" busy={false} />
        </form>
      </div>
    </Section>
  );
}

function BackupsTab({ data, mutate }: { data: ServiceDrawerData; mutate: Mutate }) {
  const t = data.target;
  return (
    <>
      <div>
        <button
          className="rounded bg-brass-500 px-3 py-1.5 text-xs font-semibold text-harbor-950 hover:bg-brass-600"
          onClick={() => void mutate(() => postJSON(api.targetsByIdBackup(t.id)))}
        >
          立即备份
        </button>
      </div>
      <div className="flex flex-col">
        {(data.backups ?? []).length === 0 ? <div className="py-4 text-center text-xs text-neutral-600">还没有备份</div> : null}
        {(data.backups ?? []).map((b) => (
          <div key={b.file} className="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
            <span className="mono text-neutral-300">{b.file}</span>
            <span className="text-neutral-600">{fmtBytes(b.size)}</span>
            <span className="text-neutral-500">{fmtAgo(b.at)}</span>
            <a className="ml-auto text-tide-400 hover:text-tide-300" href={api.backupsByIdByFile(t.id, b.file)} download={b.file}>
              下载
            </a>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-neutral-600">备份保存在控制面本地（~/.local/share/dockyard/backups/）。恢复请下载后在服务器上手动执行，避免误覆盖。</p>
    </>
  );
}
