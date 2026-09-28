/** @jsxImportSource react */
import { routes } from "../../../../.elysiax/routes.gen";
/**
 * 嵌套卡片（React Flow subflow）：服务器卡 → app 卡（compose 项目）→ 服务卡；db 卡直属服务器卡。
 * 父子关系只表达归属与布局，边连在叶子上：db 卡 source handle，服务卡/app 卡 target handle。
 * 卡内全部交互元素带 nodrag，避免触发节点拖拽。
 */
import { memo } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CardModel, DomainBadge, ServiceRow, TargetModel } from "../canvas.model";
import { deployTarget, openModal, persistServerSize, persistTargetSize, removeTarget } from "./actions";
import { useServiceState, useTargetLive } from "./live";

export type ServerFlowNode = Node<{ server: CardModel["server"] }, "server">;
export type AppFlowNode = Node<{ t: TargetModel }, "app">;
export type ServiceFlowNode = Node<{ t: TargetModel; s: ServiceRow }, "service">;
export type DbFlowNode = Node<{ t: TargetModel }, "db">;
export type CanvasFlowNode = ServerFlowNode | AppFlowNode | ServiceFlowNode | DbFlowNode;

const STATUS_LABEL: Record<string, string> = {
  queued: "排队", building: "构建中", transferring: "传输中",
  deploying: "部署中", success: "运行中", failed: "失败",
};

export function Badge({ tone, children }: { tone: "ok" | "warn" | "err" | "muted"; children: React.ReactNode }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${
      tone === "ok" ? "bg-tide-400/10 text-tide-400"
      : tone === "warn" ? "bg-brass-500/15 text-brass-500"
      : tone === "err" ? "bg-signal-500/15 text-signal-500"
      : "bg-harbor-800 text-neutral-500"
    }`}>{children}</span>
  );
}

/** 部署状态徽章：订阅 LiveContext（SSE），status 变化只重渲染徽章，不重建 nodes */
const StatusBadge = ({ targetId }: { targetId: number }) => {
  const { status } = useTargetLive(targetId);
  if (!status) return <Badge tone="muted">未部署</Badge>;
  const tone = status === "success" ? "ok" : status === "failed" ? "err" : status === "queued" ? "muted" : "warn";
  return <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>;
};

const btn = "nodrag rounded px-2 py-0.5 text-xs transition-colors";

const DomainLink = ({ d }: { d: DomainBadge }) => (
  <a
    className={`nodrag block truncate text-[11px] mono transition-colors ${
      d.sslStatus === "active" ? "text-tide-400 hover:text-tide-300"
      : d.dnsStatus === "mismatch" ? "text-signal-500 hover:text-signal-400"
      : "text-brass-500 hover:text-brass-400"
    }`}
    href={`https://${d.hostname}`}
    target="_blank"
    rel="noreferrer"
  >
    {d.sslStatus === "active" ? "🔒" : "⏳"} {d.hostname}
  </a>
);

/** 容器实时状态点（订阅 LiveContext 的 SSE 状态）：running 绿 / exited 红 / unknown 灰 */
const StateDot = ({ targetId, svcName }: { targetId: number; svcName: string }) => {
  const state = useServiceState(targetId, svcName);
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${
        state === "running" ? "bg-tide-400" : state === "exited" ? "bg-signal-500" : "bg-neutral-600"
      }`}
      title={state === "running" ? "运行中" : state === "exited" ? "已停止" : "状态未知"}
    />
  );
};

// ── 服务器卡（父）：只有标题；内容由子卡（app/db）撑大，尺寸在 board 同步时按子卡 bounds 算 ──
export const ServerNodeView = memo(({ data, selected }: NodeProps<ServerFlowNode>) => {
  const { server } = data;
  return (
    <div className="flex h-full w-full flex-col rounded-lg border border-harbor-600 bg-harbor-900/80 shadow-xl">
      <NodeResizer
        isVisible={selected}
        minWidth={320}
        minHeight={160}
        lineClassName="!border-brass-500/60"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-brass-500 !bg-harbor-950"
        onResizeEnd={(_e, p) => persistServerSize(server.id, p.width, p.height)}
      />
      <div className="flex cursor-move items-center justify-between rounded-t-lg border-b border-harbor-700 bg-harbor-800/80 px-3 py-1.5 select-none">
        <span className="text-sm font-medium text-neutral-100">🖥 {server.name}</span>
        {server.dockerStatus === "ok"
          ? <Badge tone="ok">docker {server.dockerVersion ?? ""}</Badge>
          : server.dockerStatus === "missing"
            ? <Badge tone="err">无 docker</Badge>
            : <Badge tone="muted">未检测</Badge>}
      </div>
      <div className="mono px-3 py-1 text-[11px] text-neutral-600">
        {server.user}@{server.host}:{server.port}
      </div>
    </div>
  );
});

// ── app 卡（父，compose 项目）：头部 + 操作按钮；服务卡是它的子节点 ──
export const AppNodeView = memo(({ data, selected }: NodeProps<AppFlowNode>) => {
  const { t } = data;
  const { running } = useTargetLive(t.id);
  return (
    <div className="flex h-full w-full flex-col rounded-md border border-harbor-700 bg-harbor-950 shadow-lg">
      <NodeResizer
        isVisible={selected}
        minWidth={320}
        minHeight={96}
        lineClassName="!border-brass-500/60"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-brass-500 !bg-harbor-950"
        onResizeEnd={(_e, p) => persistTargetSize(t.id, p.width, p.height)}
      />
      <Handle
        type="target"
        id={`tgt-${t.id}`}
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-harbor-950 !bg-brass-500"
        title="从数据库卡拖线到这里 = app 整体依赖"
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pt-1.5">
        <span className="truncate text-xs font-medium text-neutral-100">📦 {t.name}</span>
        <div className="flex shrink-0 items-center gap-1">
          {t.edges.map((e) => <Badge key={`${e.db}-${e.service}`} tone="warn">⇠ {e.dbName}</Badge>)}
          {t.updateAvailable ? <Badge tone="warn">有更新</Badge> : null}
          <StatusBadge targetId={t.id} />
        </div>
      </div>
      <div className="px-2.5">
        {t.domains.map((d) => <DomainLink key={d.hostname} d={d} />)}
      </div>
      <div className="mt-auto flex items-center gap-1 px-2.5 pt-1 pb-1.5" onClick={(e) => e.stopPropagation()}>
        <button className={`${btn} bg-harbor-800 text-neutral-300 hover:bg-harbor-700`}
          onClick={() => deployTarget(t.id)}>
          {running ? "部署中…" : t.updateAvailable ? "更新部署" : "重新部署"}
        </button>
        <button className={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => openModal(routes.deploy.uiTargetsByIdEnv(t.id))}>变量</button>
        <button className={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => openModal(routes.deploy.uiTargetsByIdDomains(t.id))}>域名</button>
        <button className={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => openModal(routes.deploy.uiTargetsByIdLog(t.id))}>日志</button>
        <button className={`${btn} text-neutral-600 hover:text-signal-500`}
          onClick={() => removeTarget(t)}>✕</button>
      </div>
    </div>
  );
});

// ── 服务卡（compose 声明式识别的叶子单元）：状态点 + 名称 + 端口 + 域名 ──
export const ServiceNodeView = memo(({ data }: NodeProps<ServiceFlowNode>) => {
  const { t, s } = data;
  return (
    <div
      className="flex h-full w-full cursor-pointer flex-col justify-center rounded border border-harbor-800 bg-harbor-900 px-2 py-1 transition-colors hover:border-harbor-600"
      title="点击查看服务详情"
    >
      <Handle
        type="target"
        id={`tgt-${t.id}-${s.name}`}
        position={Position.Left}
        className="!h-2 !w-2 !border-2 !border-harbor-950 !bg-brass-500"
        title="从数据库卡拖线到这里 = 该服务依赖"
      />
      <div className="flex items-center gap-1.5">
        <StateDot targetId={t.id} svcName={s.name} />
        <span className="mono truncate text-[11px] text-neutral-200">{s.name}</span>
        {s.port ? <span className="mono shrink-0 text-[11px] text-neutral-600">:{s.port}</span> : null}
      </div>
      {s.domains.map((d) => <DomainLink key={d.hostname} d={d} />)}
    </div>
  );
});

// ── 数据库卡（托管实例/逻辑库，直属服务器卡）──
export const DbNodeView = memo(({ data, selected }: NodeProps<DbFlowNode>) => {
  const { t } = data;
  const { running } = useTargetLive(t.id);
  return (
    <div className="flex h-full w-full flex-col rounded-md border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 shadow-lg">
      <NodeResizer
        isVisible={selected}
        minWidth={320}
        minHeight={84}
        lineClassName="!border-brass-500/60"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-brass-500 !bg-harbor-950"
        onResizeEnd={(_e, p) => persistTargetSize(t.id, p.width, p.height)}
      />
      <Handle
        type="source"
        id={`src-${t.id}`}
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-harbor-950 !bg-brass-500"
        title="从此圆点拖线到服务卡/app 卡建依赖"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-neutral-100">
          {t.logical ? "⛁" : "🗄"} {t.name}
        </span>
        <StatusBadge targetId={t.id} />
      </div>
      <div className="mt-auto flex items-center gap-1 pt-1" onClick={(e) => e.stopPropagation()}>
        <button className={`${btn} bg-harbor-800 text-neutral-300 hover:bg-harbor-700`}
          onClick={() => deployTarget(t.id)}>
          {running ? "部署中…" : "重新部署"}
        </button>
        {t.url ? (
          <button className={`${btn} text-tide-400 hover:text-tide-300`}
            onClick={() => navigator.clipboard.writeText(t.url!)}>连接串</button>
        ) : null}
        <button className={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => openModal(routes.deploy.uiTargetsByIdLog(t.id))}>日志</button>
        <button className={`${btn} text-neutral-600 hover:text-signal-500`}
          onClick={() => removeTarget(t)}>✕</button>
      </div>
    </div>
  );
});
