/**
 * 画布孤岛：canvas.ts 全权负责画布的渲染与交互，服务端只出 JSON。
 * - 数据：GET /api/canvas/data/:projectId（5s 轮询 + htmx HX-Trigger "refresh" 即时刷新）
 * - 渲染：DOM 直出（卡片/徽章/按钮），拖拽中的卡片不被轮询覆盖
 * - 交互：右键菜单、拖拽、resize 全在本地完成，结束时 PATCH 持久化
 * 模态框（部署表单/日志）仍用 htmx 服务端片段——表单是 htmx 的甜区。
 */
declare const htmx: {
  ajax(verb: string, url: string, opts: { target: string; swap: string }): void;
};

interface DomainData {
  hostname: string;
  sslStatus: "none" | "pending" | "active" | "error";
  dnsStatus: "unknown" | "ok" | "mismatch";
}
interface TargetData {
  id: number;
  kind: "app" | "db";
  name: string;
  dbType: string | null;
  logical?: boolean; // 逻辑库：不起容器，连接串可复制
  url?: string;
  domains?: DomainData[];
  updateAvailable: boolean;
  status: "queued" | "building" | "transferring" | "deploying" | "success" | "failed" | null;
  running: boolean;
}
interface CardData {
  node: { id: number; x: number; y: number; w: number; h: number };
  server: {
    id: number; name: string; user: string; host: string; port: number;
    dockerStatus: "unknown" | "ok" | "missing"; dockerVersion: string | null;
  };
  targets: TargetData[];
}
interface CanvasData {
  servers: { id: number; name: string }[];
  cards: CardData[];
}

const STATUS_LABEL: Record<string, string> = {
  queued: "排队", building: "构建中", transferring: "传输中",
  deploying: "部署中", success: "运行中", failed: "失败",
};
const BADGE_CLS = {
  ok: "bg-tide-400/10 text-tide-400",
  warn: "bg-brass-500/15 text-brass-500",
  err: "bg-signal-500/15 text-signal-500",
  muted: "bg-harbor-800 text-neutral-500",
} as const;

function badge(label: string, tone: keyof typeof BADGE_CLS) {
  const el = document.createElement("span");
  el.className = `rounded px-1.5 py-0.5 text-[11px] font-medium mono ${BADGE_CLS[tone]}`;
  el.textContent = label;
  return el;
}

function statusBadge(status: TargetData["status"]) {
  if (!status) return badge("未部署", "muted");
  const tone = status === "success" ? "ok" : status === "failed" ? "err" : status === "queued" ? "muted" : "warn";
  return badge(STATUS_LABEL[status] ?? status, tone);
}

function btn(label: string, cls: string, onClick: () => void) {
  const el = document.createElement("button");
  el.className = `rounded px-2 py-0.5 text-xs transition-colors ${cls}`;
  el.textContent = label;
  el.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return el;
}

// ── 右键菜单 ──
let menuEl: HTMLDivElement | null = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
function openMenu(x: number, y: number, items: { label: string; danger?: boolean; onClick: () => void }[]) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "fixed z-50 min-w-40 rounded border border-harbor-700 bg-harbor-900 py-1 shadow-2xl";
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  for (const item of items) {
    const b = document.createElement("button");
    b.className = `block w-full px-3 py-1.5 text-left text-sm hover:bg-harbor-800 ${
      item.danger ? "text-signal-500" : "text-neutral-200"
    }`;
    b.textContent = item.label;
    b.onclick = () => {
      closeMenu();
      item.onClick();
    };
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
}
document.addEventListener("click", (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

// ── 孤岛本体 ──
let root: HTMLElement | null = null;
let projectId = 0;
let lastJson = "";
let interacting = false; // 拖拽/resize 中不覆盖渲染
let pollTimer: number | undefined;

async function api(path: string, method = "GET", body?: unknown) {
  await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function load(force = false) {
  if (!root || interacting) return;
  const res = await fetch(`/api/canvas/data/${projectId}`);
  if (!res.ok) return;
  const json = await res.text();
  if (!force && json === lastJson) return;
  lastJson = json;
  render(JSON.parse(json) as CanvasData);
}

function render(data: CanvasData) {
  if (!root) return;
  root.textContent = "";
  for (const card of data.cards) root.appendChild(renderCard(card));
}

function renderCard(card: CardData) {
  const el = document.createElement("div");
  el.className =
    "canvas-card absolute flex flex-col rounded border border-harbor-700 bg-harbor-900 shadow-xl";
  el.style.left = `${card.node.x}px`;
  el.style.top = `${card.node.y}px`;
  el.style.width = `${card.node.w}px`;
  el.style.height = `${card.node.h}px`;
  el.dataset.nodeId = String(card.node.id);

  const header = document.createElement("div");
  header.className =
    "canvas-card-header flex cursor-move items-center justify-between rounded-t border-b border-harbor-800 bg-harbor-800/70 px-3 py-1.5 select-none";
  const name = document.createElement("span");
  name.className = "text-sm font-medium text-neutral-100";
  name.textContent = card.server.name;
  header.appendChild(name);
  header.appendChild(
    card.server.dockerStatus === "ok"
      ? badge(`docker ${card.server.dockerVersion ?? ""}`, "ok")
      : card.server.dockerStatus === "missing"
        ? badge("无 docker", "err")
        : badge("未检测", "muted"),
  );
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "flex flex-1 flex-col gap-1.5 overflow-auto px-2.5 py-2";
  const addr = document.createElement("div");
  addr.className = "mono text-[11px] text-neutral-600";
  addr.textContent = `${card.server.user}@${card.server.host}:${card.server.port}`;
  body.appendChild(addr);
  if (card.targets.length === 0) {
    const hint = document.createElement("div");
    hint.className = "mt-1 text-xs text-neutral-600";
    hint.textContent = "右键卡片：部署 app / 数据库";
    body.appendChild(hint);
  }
  for (const target of card.targets) body.appendChild(renderTarget(target));
  el.appendChild(body);

  const resize = document.createElement("div");
  resize.className = "canvas-resize-handle absolute right-0 bottom-0 h-3 w-3 cursor-nwse-resize rounded-br bg-harbor-600/70";
  el.appendChild(resize);
  return el;
}

function renderTarget(target: TargetData) {
  const row = document.createElement("div");
  row.className = "rounded border border-harbor-800 bg-harbor-950/70 px-2 py-1.5";

  const top = document.createElement("div");
  top.className = "flex items-center justify-between gap-2";
  const label = document.createElement("span");
  label.className = "truncate text-xs font-medium text-neutral-200";
  label.textContent = `${target.kind === "db" ? (target.logical ? "⛁" : "🗄") : "📦"} ${target.name}`;
  top.appendChild(label);
  const badges = document.createElement("div");
  badges.className = "flex shrink-0 items-center gap-1";
  if (target.updateAvailable) badges.appendChild(badge("有更新", "warn"));
  badges.appendChild(statusBadge(target.status));
  top.appendChild(badges);
  row.appendChild(top);

  // 域名徽章：ssl 状态着色，点击直达
  for (const d of target.domains ?? []) {
    const link = document.createElement("a");
    const cls =
      d.sslStatus === "active" ? "text-tide-400 hover:text-tide-300"
      : d.dnsStatus === "mismatch" ? "text-signal-500 hover:text-signal-400"
      : "text-brass-500 hover:text-brass-400";
    link.className = `mt-0.5 block truncate text-[11px] mono transition-colors ${cls}`;
    link.href = `https://${d.hostname}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${d.sslStatus === "active" ? "🔒" : "⏳"} ${d.hostname}`;
    row.appendChild(link);
  }

  const actions = document.createElement("div");
  actions.className = "mt-1 flex items-center gap-1";
  actions.appendChild(
    btn(
      target.running ? "部署中…" : target.updateAvailable ? "更新部署" : "重新部署",
      "bg-harbor-800 text-neutral-300 hover:bg-harbor-700",
      async () => {
        await api(`/deploy/targets/${target.id}/deploy`, "POST");
        // Railway 式体验：点部署即打开日志面板盯着进度（modal 内 1s 轮询到终态）
        htmx.ajax("GET", `/api/deploy/ui/targets/${target.id}/log`, { target: "#modal-root", swap: "innerHTML" });
        await load(true);
      },
    ),
  );
  if (target.url) {
    actions.appendChild(
      btn("连接串", "text-tide-400 hover:text-tide-300", async () => {
        await navigator.clipboard.writeText(target.url!);
      }),
    );
  }
  if (target.kind === "app") {
    actions.appendChild(
      btn("域名", "text-neutral-500 hover:text-neutral-200", () =>
        htmx.ajax("GET", `/api/deploy/ui/targets/${target.id}/domains`, { target: "#modal-root", swap: "innerHTML" }),
      ),
    );
  }
  actions.appendChild(
    btn("日志", "text-neutral-500 hover:text-neutral-200", () =>
      htmx.ajax("GET", `/api/deploy/ui/targets/${target.id}/log`, { target: "#modal-root", swap: "innerHTML" }),
    ),
  );
  actions.appendChild(
    btn("✕", "text-neutral-600 hover:text-signal-500", async () => {
      const hint = target.logical
        ? `移除逻辑库「${target.name}」的记录？（远端数据库保留，不会 DROP）`
        : `移除部署目标「${target.name}」？（远端容器不动）`;
      if (!confirm(hint)) return;
      const res = await fetch(`/api/deploy/targets/${target.id}`, { method: "DELETE" });
      if (!res.ok) {
        alert(await res.text()); // 例如：实例下还有逻辑库，被阻止
        return;
      }
      await load(true);
    }),
  );
  row.appendChild(actions);
  return row;
}

// ── 右键菜单 ──
document.addEventListener("contextmenu", (e) => {
  if (!root) return;
  const card = (e.target as HTMLElement).closest<HTMLElement>(".canvas-card");
  if (!root.contains(e.target as Node)) return;
  e.preventDefault();

  if (card) {
    const nodeId = Number(card.dataset.nodeId);
    openMenu(e.clientX, e.clientY, [
      {
        label: "部署 app",
        onClick: () => htmx.ajax("GET", `/api/deploy/ui/new-app/${nodeId}`, { target: "#modal-root", swap: "innerHTML" }),
      },
      {
        label: "部署数据库",
        onClick: () => htmx.ajax("GET", `/api/deploy/ui/new-db/${nodeId}`, { target: "#modal-root", swap: "innerHTML" }),
      },
      {
        label: "移除卡片",
        danger: true,
        onClick: async () => {
          await api(`/canvas/nodes/${nodeId}`, "DELETE");
          await load(true);
        },
      },
    ]);
    return;
  }

  // 空白处：添加服务器卡片
  const data = lastJson ? (JSON.parse(lastJson) as CanvasData) : null;
  if (!data?.servers.length) return;
  const rect = root.getBoundingClientRect();
  const x = Math.round(e.clientX - rect.left + root.scrollLeft);
  const y = Math.round(e.clientY - rect.top + root.scrollTop);
  openMenu(
    e.clientX,
    e.clientY,
    data.servers.map((s) => ({
      label: `＋ ${s.name}`,
      onClick: async () => {
        await api(`/canvas/projects/${projectId}/nodes`, "POST", { serverId: s.id, x, y });
        await load(true);
      },
    })),
  );
});

// ── 拖拽 / resize ──
document.addEventListener("pointerdown", (e) => {
  if (!root) return;
  const handle = (e.target as HTMLElement).closest<HTMLElement>(".canvas-resize-handle");
  const header = (e.target as HTMLElement).closest<HTMLElement>(".canvas-card-header");
  const card = (e.target as HTMLElement).closest<HTMLElement>(".canvas-card");
  if (!card || (!handle && !header)) return;
  if ((e.target as HTMLElement).closest("button, a")) return;

  e.preventDefault();
  interacting = true;
  const nodeId = Number(card.dataset.nodeId);
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = {
    left: parseFloat(card.style.left),
    top: parseFloat(card.style.top),
    w: card.offsetWidth,
    h: card.offsetHeight,
  };
  const mode = handle ? "resize" : "drag";

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (mode === "drag") {
      card.style.left = `${orig.left + dx}px`;
      card.style.top = `${orig.top + dy}px`;
    } else {
      card.style.width = `${Math.max(220, orig.w + dx)}px`;
      card.style.height = `${Math.max(150, orig.h + dy)}px`;
    }
  };
  const onUp = async (ev: PointerEvent) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    interacting = false;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (dx === 0 && dy === 0) return;
    const patch =
      mode === "drag"
        ? { x: Math.round(orig.left + dx), y: Math.round(orig.top + dy) }
        : { w: card.offsetWidth, h: card.offsetHeight };
    // 本地数据同步更新，避免轮询回弹
    const data = lastJson ? (JSON.parse(lastJson) as CanvasData) : null;
    const found = data?.cards.find((c) => c.node.id === nodeId);
    if (found) Object.assign(found.node, patch);
    if (data) lastJson = JSON.stringify(data);
    await api(`/canvas/nodes/${nodeId}`, "PATCH", patch);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
});

// ── 挂载：#canvas-root 随 htmx 换页出现/消失 ──
function mount() {
  const next = document.getElementById("canvas-root");
  if (next === root) return;
  root = next;
  lastJson = "";
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  if (root) {
    projectId = Number(root.dataset.projectId);
    void load(true);
    pollTimer = window.setInterval(() => void load(), 5000);
  }
}

// modal 表单 POST 后服务端发 HX-Trigger: refresh → 立即刷新画布
document.body.addEventListener("refresh", () => void load(true));
document.addEventListener("htmx:afterSwap", () => mount());
document.addEventListener("htmx:load", () => mount());
mount();
