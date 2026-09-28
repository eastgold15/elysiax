import type { Component } from "@workspace/htmx";
import type { Project } from "../../shared/schema";
import { PageHeader } from "../ui-kit/ui-kit.ui";

/**
 * 画布 = 服务端渲染 + morph 更新，不再是 JSON 驱动的客户端孤岛：
 * - 卡片/目标行全在这里渲染（徽章、按钮的 hx-* 属性声明式完成）
 * - #canvas-root 每 5s hx-get 卡片片段，hx-swap="morph:innerHTML"（idiomorph）按 id 合并，
 *   拖拽中的卡片由 <dy-card> 置 data-dragging 阻止本次 swap（见 pages/canvas.ts）
 * - 拖拽/resize/右键菜单这些无法声明式的交互，封装在 <dy-card> Web Component 里
 */

// ── 视图模型（controller 的 canvasData 组装，跨 deploy/edge/server 上下文）──
export interface DomainBadge {
  hostname: string;
  sslStatus: "none" | "pending" | "active" | "error";
  dnsStatus: "unknown" | "ok" | "mismatch";
}
export interface TargetModel {
  id: number;
  kind: "app" | "db";
  name: string;
  logical: boolean;
  url?: string; // 逻辑库连接串（复制按钮）
  domains: DomainBadge[];
  dependsOn: number[]; // 依赖的 db target id（跨卡 → 箭头，同卡 → 行内徽章）
  depNames: string[];
  updateAvailable: boolean;
  status: "queued" | "building" | "transferring" | "deploying" | "success" | "failed" | null;
  running: boolean;
}
export interface CardModel {
  node: { id: number; x: number; y: number; w: number; h: number };
  server: {
    id: number; name: string; user: string; host: string; port: number;
    dockerStatus: "unknown" | "ok" | "missing"; dockerVersion: string | null;
  };
  targets: TargetModel[];
}

const STATUS_LABEL: Record<string, string> = {
  queued: "排队", building: "构建中", transferring: "传输中",
  deploying: "部署中", success: "运行中", failed: "失败",
};

const Badge: Component<{ tone: "ok" | "warn" | "err" | "muted" }> = ({ tone, children }) => (
  <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${
    tone === "ok" ? "bg-tide-400/10 text-tide-400"
    : tone === "warn" ? "bg-brass-500/15 text-brass-500"
    : tone === "err" ? "bg-signal-500/15 text-signal-500"
    : "bg-harbor-800 text-neutral-500"
  }`}>{children}</span>
);

const statusBadge = (status: TargetModel["status"]) => {
  if (!status) return <Badge tone="muted">未部署</Badge>;
  const tone = status === "success" ? "ok" : status === "failed" ? "err" : status === "queued" ? "muted" : "warn";
  return <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>;
};

const modalAttrs = (url: string) => ({
  "hx-get": url, "hx-target": "#modal-root", "hx-swap": "innerHTML",
});

const TargetRow: Component<{ t: TargetModel }> = ({ t }) => (
  <div id={`target-${t.id}`} class="rounded border border-harbor-800 bg-harbor-950/70 px-2 py-1.5">
    <div class="flex items-center justify-between gap-2">
      <span class="truncate text-xs font-medium text-neutral-200">
        {t.kind === "db" ? (t.logical ? "⛁" : "🗄") : "📦"} {t.name}
      </span>
      <div class="flex shrink-0 items-center gap-1">
        {t.depNames.map((n) => <Badge tone="warn">⇠ {n}</Badge>)}
        {t.updateAvailable ? <Badge tone="warn">有更新</Badge> : null}
        {statusBadge(t.status)}
      </div>
    </div>
    {t.domains.map((d) => (
      <a
        class={`mt-0.5 block truncate text-[11px] mono transition-colors ${
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
    ))}
    <div class="mt-1 flex items-center gap-1">
      <button
        class="rounded px-2 py-0.5 text-xs transition-colors bg-harbor-800 text-neutral-300 hover:bg-harbor-700"
        hx-post={`/api/deploy/targets/${t.id}/deploy`}
        hx-swap="none"
        // Railway 式体验：点部署即打开日志面板盯进度（modal 内 1s 轮询到终态）
        {...{ "hx-on::after-request": `htmx.ajax('GET','/api/deploy/ui/targets/${t.id}/log',{target:'#modal-root',swap:'innerHTML'})` }}
      >
        {t.running ? "部署中…" : t.updateAvailable ? "更新部署" : "重新部署"}
      </button>
      {t.url ? (
        <button
          class="rounded px-2 py-0.5 text-xs text-tide-400 transition-colors hover:text-tide-300"
          data-url={t.url}
          onclick="navigator.clipboard.writeText(this.dataset.url)"
        >连接串</button>
      ) : null}
      {t.kind === "app" ? (
        <>
          <button
            class="rounded px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:text-neutral-200"
            {...modalAttrs(`/api/deploy/ui/targets/${t.id}/env`)}
          >变量</button>
          <button
            class="rounded px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:text-neutral-200"
            {...modalAttrs(`/api/deploy/ui/targets/${t.id}/domains`)}
          >域名</button>
        </>
      ) : null}
      <button
        class="rounded px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:text-neutral-200"
        {...modalAttrs(`/api/deploy/ui/targets/${t.id}/log`)}
      >日志</button>
      <button
        class="rounded px-2 py-0.5 text-xs text-neutral-600 transition-colors hover:text-signal-500"
        hx-delete={`/api/deploy/targets/${t.id}`}
        hx-swap="none"
        hx-confirm={t.logical
          ? `移除逻辑库「${t.name}」的记录？（远端数据库保留，不会 DROP）`
          : `移除部署目标「${t.name}」？（远端容器不动）`}
        // 例如：实例下还有逻辑库，被阻止（409 + 错误文本）
        {...{ "hx-on::response-error": "alert(event.detail.xhr.responseText)" }}
      >✕</button>
    </div>
  </div>
);

const DyCard: Component<{ card: CardModel }> = ({ card }) => {
  const { node, server } = card;
  return (
    <dy-card
      id={`card-${node.id}`}
      data-node-id={String(node.id)}
      class="absolute flex flex-col rounded border border-harbor-700 bg-harbor-900 shadow-xl"
      style={`left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px`}
    >
      <div
        data-drag-handle
        class="flex cursor-move items-center justify-between rounded-t border-b border-harbor-800 bg-harbor-800/70 px-3 py-1.5 select-none"
      >
        <span class="text-sm font-medium text-neutral-100">{server.name}</span>
        {server.dockerStatus === "ok"
          ? <Badge tone="ok">docker {server.dockerVersion ?? ""}</Badge>
          : server.dockerStatus === "missing"
            ? <Badge tone="err">无 docker</Badge>
            : <Badge tone="muted">未检测</Badge>}
      </div>
      <div class="flex flex-1 flex-col gap-1.5 overflow-auto px-2.5 py-2">
        <div class="mono text-[11px] text-neutral-600">
          {server.user}@{server.host}:{server.port}
        </div>
        {card.targets.length === 0 ? (
          <div class="mt-1 text-xs text-neutral-600">右键卡片：部署 app / 数据库</div>
        ) : null}
        {card.targets.map((t) => <TargetRow t={t} />)}
      </div>
      <div data-resize-handle class="absolute right-0 bottom-0 h-3 w-3 cursor-nwse-resize rounded-br bg-harbor-600/70" />
    </dy-card>
  );
};

export interface DepLink {
  from: number; // db 所在卡片 nodeId
  to: number;   // app 所在卡片 nodeId
}

/** 依赖连线：db 卡 → app 卡的三次贝塞尔（取两卡最近的水平边，纯服务端几何）。
 *  拖拽中 morph 被 <dy-card> 拦住，松手 PATCH 后立即 refresh 补一次，箭头随卡走 */
const DepArrows: Component<{ cards: CardModel[]; links: DepLink[] }> = ({ cards, links }) => {
  if (links.length === 0) return <></>;
  const byNode = new Map(cards.map((c) => [c.node.id, c.node]));
  const W = Math.max(...cards.map((c) => c.node.x + c.node.w), 0) + 200;
  const H = Math.max(...cards.map((c) => c.node.y + c.node.h), 0) + 200;
  return (
    <svg class="pointer-events-none absolute inset-0" width={W} height={H}>
      <defs>
        <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#d9a441" />
        </marker>
      </defs>
      {links.map((l) => {
        const a = byNode.get(l.from);
        const b = byNode.get(l.to);
        if (!a || !b) return null;
        const ay = a.y + a.h / 2;
        const by = b.y + b.h / 2;
        const ltr = a.x + a.w / 2 <= b.x + b.w / 2;
        const fromX = ltr ? a.x + a.w : a.x;
        const toX = ltr ? b.x : b.x + b.w;
        const c = Math.max(40, Math.abs(toX - fromX) / 2) * (ltr ? 1 : -1);
        return (
          <path
            id={`dep-${l.from}-${l.to}`}
            d={`M ${fromX} ${ay} C ${fromX + c} ${ay}, ${toX - c} ${by}, ${toX} ${by}`}
            fill="none"
            stroke="#d9a441"
            stroke-opacity="0.5"
            stroke-width="1.5"
            stroke-dasharray="5 3"
            marker-end="url(#dep-arrow)"
          />
        );
      })}
    </svg>
  );
};

/** 卡片片段：#canvas-root 的轮询目标。servers JSON 供空白处右键「添加服务器」菜单用 */
export const CanvasCards: Component<{
  cards: CardModel[];
  servers: { id: number; name: string }[];
  links: DepLink[];
}> = ({ cards, servers, links }) => (
  <>
    <DepArrows cards={cards} links={links} />
    {cards.map((c) => <DyCard card={c} />)}
    <script id="canvas-servers" type="application/json">
      {JSON.stringify(servers).replace(/</g, "\\u003c")}
    </script>
  </>
);

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
    <div
      id="canvas-root"
      data-project-id={String(project.id)}
      class="dock-grid relative flex-1 overflow-auto"
      hx-ext="morph"
      hx-get={`/api/canvas/ui/${project.id}/cards`}
      hx-trigger="load, every 5s, refresh from:body"
      hx-swap="morph:innerHTML"
    />
  </div>
);

export default CanvasShell;
