/** @jsxImportSource react */
import { routes } from "../../../../.elysiax/routes.gen";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, applyEdgeChanges, applyNodeChanges,
  MarkerType, useReactFlow,
  type Connection, type Edge, type EdgeChange, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { BoardModel, CardModel, TargetModel } from "../canvas.model";
import {
  AppNodeView, DbNodeView, ServerNodeView, ServiceNodeView,
  type CanvasFlowNode,
} from "./nodes";
import { openModal } from "./actions";
import { applyLiveEvent, emptyLive, LiveContext, type LiveState } from "./live";

const nodeTypes = { server: ServerNodeView, app: AppNodeView, service: ServiceNodeView, db: DbNodeView };

const DEP_EDGE = {
  style: { stroke: "#d9a441", strokeOpacity: 0.6, strokeWidth: 1.5, strokeDasharray: "5 3" },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#d9a441", width: 16, height: 16 },
} as const;

// ── 布局常量（父卡显式尺寸由子卡 bounds 算，估算值与 nodes.tsx 的 Tailwind 类对应）──
const CHILD_W = 320;      // app/db 卡宽
const SVC_H = 34, SVC_GAP = 8, SVC_TOP = 58; // 服务卡在 app 卡内：x=14，y 从 SVC_TOP 起按实际高度累加
const SVC_DOMAIN_H = 16;  // 服务卡里每行域名的高度
const APP_MIN_H = 96;     // 无服务清单的 app 卡高
const APP_TAIL_H = 46;    // 服务块之后的按钮区
const DB_H = 84;
const PAD = 14, HEADER_H = 56, GAP = 12; // 服务器卡：内边距/标题/子卡间距
const SVC_W = CHILD_W - 28;

const srvId = (nodeId: number) => `srv-${nodeId}`;
const appId = (targetId: number) => `app-${targetId}`;
const svcId = (targetId: number, name: string) => `svc-${targetId}-${name}`;
const dbId = (targetId: number) => `db-${targetId}`;

/** 服务卡高 = 名称行 + 域名行数 */
const svcHeight = (s: TargetModel["services"][number]) => SVC_H + s.domains.length * SVC_DOMAIN_H;

/** app 卡内容高 = 服务卡实际高度累加 + 按钮区 */
const appContentBottom = (t: TargetModel) =>
  t.services.reduce((y, s) => y + svcHeight(s) + SVC_GAP, SVC_TOP);

/**
 * 拖拽时父卡随子卡撑大（grow-only，只长不缩避免抖动；结构 refetch 时由 deriveNodes 精确收敛）。
 * 替代 expandParent——它和显式 width/height 冲突会触发 ResizeObserver loop。
 * resizingIds：NodeResizer 拖拽中的节点必须跳过 clamp 和 grow——否则 grow-only 把用户缩小的尺寸
 * 立刻 max 回去，与 NodeResizer 互相覆盖又是一次 ResizeObserver loop。
 */
function fitParents(ns: CanvasFlowNode[], resizingIds?: ReadonlySet<string>): CanvasFlowNode[] {
  // 钳制子卡不越出父卡内容区（左/上）——无 extent 约束，服务卡/app 卡不能拖到标题栏或负坐标
  const clamped = ns.map((n) => {
    if (resizingIds?.has(n.id)) return n;
    if (n.type === "service") {
      const x = Math.max(PAD, n.position.x), y = Math.max(SVC_TOP, n.position.y);
      return x === n.position.x && y === n.position.y ? n : { ...n, position: { x, y } };
    }
    if ((n.type === "app" || n.type === "db") && n.parentId) {
      const x = Math.max(PAD, n.position.x), y = Math.max(HEADER_H, n.position.y);
      return x === n.position.x && y === n.position.y ? n : { ...n, position: { x, y } };
    }
    return n;
  });
  ns = clamped;
  const kidsOf = new Map<string, CanvasFlowNode[]>();
  for (const n of ns) {
    if (!n.parentId) continue;
    const arr = kidsOf.get(n.parentId) ?? [];
    arr.push(n);
    kidsOf.set(n.parentId, arr);
  }
  // 注意必须换对象（不能原地改 width/height）：RF 按节点对象 identity 判断重渲染
  const grow = (n: CanvasFlowNode, minW: number, minH: number, padX: number, padBottom: number): CanvasFlowNode => {
    if (resizingIds?.has(n.id)) return n; // NodeResizer 拖拽中：尊重其精确尺寸
    const kids = kidsOf.get(n.id);
    if (!kids?.length) return n;
    const w = Math.max(n.width ?? 0, minW, ...kids.map((k) => k.position.x + (k.width ?? 0) + padX));
    const h = Math.max(n.height ?? 0, minH, ...kids.map((k) => k.position.y + (k.height ?? 0) + padBottom));
    return w === n.width && h === n.height ? n : { ...n, width: w, height: h };
  };
  return ns.map((n) =>
    n.type === "app" ? grow(n, CHILD_W, APP_MIN_H, PAD, APP_TAIL_H)
    : n.type === "server" ? grow(n, PAD + CHILD_W + PAD, HEADER_H + APP_MIN_H + PAD, PAD, PAD)
    : n
  );
}

/**
 * structure JSON → 嵌套节点（纯几何：实时状态在 LiveContext，不进 node.data）。
 * 无持久化位置的子卡在父内容区单列自动摆（确定性，refetch 稳定）；
 * 父卡尺寸 = 子卡 bounds + 内边距。父节点必须先于子节点入数组。
 */
function deriveNodes(cards: CardModel[], local: Map<string, CanvasFlowNode>): CanvasFlowNode[] {
  const nodes: CanvasFlowNode[] = [];
  for (const card of cards) {
    const sid = srvId(card.node.id);
    const serverLocal = local.get(sid);
    // 先摆子卡，得到服务器卡的尺寸
    const children: CanvasFlowNode[] = [];
    let cursor = HEADER_H;
    let contentRight = PAD + CHILD_W;
    let contentBottom = HEADER_H;
    for (const t of card.targets) {
      const id = t.kind === "app" ? appId(t.id) : dbId(t.id);
      const auto = { x: PAD, y: cursor };
      const pos = t.x !== null && t.y !== null ? { x: t.x, y: t.y } : auto;
      const localNode = local.get(id);
      const position = localNode?.dragging ? localNode.position : pos;
      // app 卡尺寸 = 手动拉伸值（下限）∪ 服务卡 bounds 收敛
      let w = Math.max(CHILD_W, t.w ?? 0);
      let h = t.kind === "app"
        ? Math.max(APP_MIN_H, appContentBottom(t) + APP_TAIL_H, t.h ?? 0)
        : Math.max(DB_H, t.h ?? 0);
      const svcNodes: CanvasFlowNode[] = [];
      if (t.kind === "app") {
        let svcCursor = SVC_TOP;
        for (const s of t.services) {
          const id2 = svcId(t.id, s.name);
          const localSvc = local.get(id2);
          const sh = svcHeight(s);
          const auto2 = { x: 14, y: svcCursor };
          const pos2 = s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : auto2;
          const position2 = localSvc?.dragging ? localSvc.position : pos2;
          svcNodes.push({
            id: id2,
            type: "service",
            parentId: id,
            position: position2,
            width: SVC_W,
            height: sh,
            selected: localSvc?.selected ?? false,
            dragging: localSvc?.dragging,
            data: { t, s },
          });
          w = Math.max(w, position2.x + SVC_W + PAD);
          h = Math.max(h, position2.y + sh + APP_TAIL_H);
          svcCursor += sh + SVC_GAP;
        }
      }
      children.push({
        id,
        type: t.kind,
        parentId: sid,
        position,
        width: w,
        height: h,
        selected: localNode?.selected ?? false,
        dragging: localNode?.dragging,
        data: { t },
      } as CanvasFlowNode);
      children.push(...svcNodes);
      contentRight = Math.max(contentRight, position.x + w);
      contentBottom = Math.max(contentBottom, position.y + h);
      cursor += h + GAP;
    }
    nodes.push({
      id: sid,
      type: "server",
      position: serverLocal?.dragging ? serverLocal.position : { x: card.node.x, y: card.node.y },
      width: Math.max(PAD + CHILD_W + PAD, contentRight + PAD, card.node.w ?? 0),
      height: Math.max(HEADER_H + APP_MIN_H + PAD, contentBottom + PAD, card.node.h ?? 0),
      selected: serverLocal?.selected ?? false,
      dragging: serverLocal?.dragging,
      data: { server: card.server },
    });
    nodes.push(...children);
  }
  return nodes;
}

/** 服务级依赖边：db 卡 → 服务卡（service 有值）或 app 卡（整体依赖）。边 id 编码三者供删边解析 */
function deriveEdges(cards: CardModel[], keepSelected: Set<string>): Edge[] {
  const edges: Edge[] = [];
  for (const c of cards)
    for (const t of c.targets)
      for (const e of t.edges) {
        const id = `dep-${e.db}-${t.id}-${e.service ?? "_"}`;
        edges.push({
          id,
          source: dbId(e.db), sourceHandle: `src-${e.db}`,
          target: e.service ? svcId(t.id, e.service) : appId(t.id),
          targetHandle: e.service ? `tgt-${t.id}-${e.service}` : `tgt-${t.id}`,
          selected: keepSelected.has(id),
          ...DEP_EDGE,
        });
      }
  return edges;
}

interface Menu {
  x: number; y: number;
  kind: "pane" | "server";
  nodeId?: number;
  flowX: number; flowY: number;
}

function Flow({ projectId }: { projectId: number }) {
  // 三源：structure（/board，refresh 驱动，存 ref）、nodes（布局，本地权威）、live（SSE）
  const [servers, setServers] = useState<BoardModel["servers"]>([]);
  const [live, setLive] = useState<LiveState>(emptyLive);
  const [nodes, setNodes] = useState<CanvasFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const structureRef = useRef<CardModel[]>([]);
  const { screenToFlowPosition } = useReactFlow();

  /** 结构拉取：只在挂载和 HX-Trigger: refresh（结构变更）时调用，不轮询 */
  const fetchBoard = useCallback(async () => {
    const res = await fetch(routes.canvas.uiByProjectId(projectId));
    if (!res.ok) return;
    const board = (await res.json()) as BoardModel;
    structureRef.current = board.cards;
    setServers(board.servers);
    setNodes((cur) => deriveNodes(board.cards, new Map(cur.map((n) => [n.id, n]))));
    setEdges((cur) => deriveEdges(board.cards, new Set(cur.filter((e) => e.selected).map((e) => e.id))));
  }, [projectId]);

  // 交互门闩：拖拽/连线进行中 refresh 排队，结束后补拉——用户交互期间不被自动刷新打断
  const interactingRef = useRef(false);
  const pendingRefetchRef = useRef(false);
  const refetch = useCallback(async () => {
    if (interactingRef.current) {
      pendingRefetchRef.current = true;
      return;
    }
    await fetchBoard();
    pendingRefetchRef.current = false;
  }, [fetchBoard]);
  const flushPendingRefetch = useCallback(() => {
    if (pendingRefetchRef.current && !interactingRef.current) {
      pendingRefetchRef.current = false;
      void fetchBoard();
    }
  }, [fetchBoard]);

  // 结构：挂载拉一次 + 服务端片段请求的 HX-Trigger: refresh（建/删卡、建/删边、域名）
  useEffect(() => {
    void fetchBoard();
    const onRefresh = () => void refetch();
    document.body.addEventListener("refresh", onRefresh);
    return () => document.body.removeEventListener("refresh", onRefresh);
  }, [fetchBoard, refetch]);

  // 实时：SSE——部署 status/running、容器 state，只进 live（不进 nodes）
  useEffect(() => {
    const es = new EventSource(routes.canvas.uiByProjectId(projectId));
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as Record<string, unknown>;
        setLive((prev) => applyLiveEvent(prev, msg));
      } catch { /* 忽略坏帧 */ }
    };
    return () => es.close();
  }, [projectId]);

  // NodeResizer 拖拽中的节点 id（dimension change 带 resizing 标志），fitParents 对它们跳过 clamp/grow
  const resizingRef = useRef<Set<string>>(new Set());
  // dimensions 类 change 攒批：NodeResizer 每 mousemove 一条，rAF 合帧降到每帧最多一次渲染
  const dimBufferRef = useRef<NodeChange<CanvasFlowNode>[]>([]);
  const rafRef = useRef<number | null>(null);
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      // 节点删除只走卡片 ✕ / 右键菜单（REST + refresh），键盘 Delete 只用于删边
      const safe = changes.filter((c) => c.type !== "remove");
      const immediate: NodeChange<CanvasFlowNode>[] = [];
      for (const c of safe) {
        if (c.type === "dimensions") {
          if (c.resizing) resizingRef.current.add(c.id);
          else resizingRef.current.delete(c.id);
          dimBufferRef.current.push(c);
        } else {
          immediate.push(c);
        }
      }
      if (immediate.length) {
        setNodes((ns) => fitParents(applyNodeChanges(immediate, ns), resizingRef.current));
      }
      if (dimBufferRef.current.length && rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const batch = dimBufferRef.current;
          dimBufferRef.current = [];
          setNodes((ns) => fitParents(applyNodeChanges(batch, ns), resizingRef.current));
        });
      }
    },
    [],
  );
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  const findTarget = (id: number) =>
    structureRef.current.flatMap((c) => c.targets).find((t) => t.id === id);

  const putEdges = async (appTargetId: number, entries: { service: string | null; db: number }[]) => {
    await fetch(routes.deploy.targetsByIdDeps(appTargetId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edges: entries }),
    });
    // 边属结构（服务端有派生逻辑），写回后重拉
    await refetch();
  };

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removes = changes.filter((c) => c.type === "remove");
    setEdges((es) => applyEdgeChanges(changes, es));
    // 删边：id 形如 dep-<db>-<appTargetId>-<service|_>，整组覆盖写回
    for (const c of removes) {
      const m = /^dep-(\d+)-(\d+)-(.+)$/.exec(c.id);
      if (!m) continue;
      const [, db, app, svc] = m;
      const t = findTarget(Number(app));
      if (!t) continue;
      void putEdges(t.id, t.edges
        .filter((e) => !(e.db === Number(db) && (e.service ?? "_") === svc))
        .map((e) => ({ service: e.service, db: e.db })));
    }
  }, []);

  // 拖线建依赖：db 卡 source（src-<db>）→ 服务卡（tgt-<app>-<svc>）或 app 卡（tgt-<app>）
  const onConnect = useCallback((conn: Connection) => {
    const db = Number(/^src-(\d+)$/.exec(conn.sourceHandle ?? "")?.[1]);
    const whole = /^tgt-(\d+)$/.exec(conn.targetHandle ?? "");
    const perSvc = /^tgt-(\d+)-(.+)$/.exec(conn.targetHandle ?? "");
    if (!db || (!whole && !perSvc)) return;
    const appTargetId = Number((perSvc ?? whole)![1]);
    const service = perSvc ? perSvc[2]! : null;
    const t = findTarget(appTargetId);
    if (!t || t.edges.some((e) => e.db === db && e.service === service)) return;
    void putEdges(t.id, [...t.edges.map((e) => ({ service: e.service, db: e.db })), { service, db }]);
  }, []);

  // 布局：本地已是权威，PATCH 只持久化，不 refetch
  const patchLayout = (targetId: number, body: Record<string, unknown>) =>
    fetch(routes.deploy.targetsByIdLayout(targetId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const onNodeDragStart = useCallback(() => {
    draggedRef.current = true;
    interactingRef.current = true;
  }, []);

  const onNodeDragStop = useCallback((_e: unknown, node: CanvasFlowNode) => {
    setTimeout(() => { draggedRef.current = false; }, 0);
    interactingRef.current = false;
    const x = Math.round(node.position.x), y = Math.round(node.position.y);
    if (node.type === "server") {
      const nodeId = Number(node.id.replace("srv-", ""));
      void fetch(routes.canvas.nodesById(nodeId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
    } else if (node.type === "app" || node.type === "db") {
      void patchLayout(Number(node.id.replace(/^(app|db)-/, "")), { x, y });
    } else if (node.type === "service") {
      const data = node.data as { t: TargetModel; s: { name: string } };
      // serviceLayout 全量覆盖：已知服务位置合并本次移动
      const merged = Object.fromEntries(
        data.t.services.filter((s) => s.x !== undefined && s.y !== undefined)
          .map((s) => [s.name, { x: s.x!, y: s.y! }]),
      );
      merged[data.s.name] = { x, y };
      void patchLayout(data.t.id, { serviceLayout: merged });
    }
    flushPendingRefetch();
  }, [flushPendingRefetch]);

  const closeMenu = () => setMenu(null);

  // 点服务卡/db 卡 → Railway 式服务抽屉；拖完松手也会触发 click，用 ref 守卫
  const draggedRef = useRef(false);
  const onNodeClick = useCallback((_e: unknown, node: CanvasFlowNode) => {
    if (draggedRef.current) return;
    closeMenu();
    if (node.type === "service") {
      const { t, s } = node.data as { t: TargetModel; s: { name: string } };
      openModal(`${routes.deploy.uiTargetsByIdService(t.id)}?svc=${encodeURIComponent(s.name)}`);
    } else if (node.type === "db") {
      const { t } = node.data as { t: TargetModel };
      openModal(routes.deploy.uiTargetsByIdService(t.id));
    }
  }, []);

  return (
    <LiveContext.Provider value={live}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        colorMode="dark"
        fitView
        minZoom={0.2}
        deleteKeyCode={["Backspace", "Delete"]}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          if (servers.length === 0) return;
          const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          setMenu({ x: e.clientX, y: e.clientY, kind: "pane", flowX: Math.round(p.x), flowY: Math.round(p.y) });
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          if (node.type !== "server") return; // app/db 卡的操作在卡片按钮上
          setMenu({ x: e.clientX, y: e.clientY, kind: "server", nodeId: Number(node.id.replace("srv-", "")), flowX: 0, flowY: 0 });
        }}
        onPaneClick={closeMenu}
        onMoveStart={closeMenu}
      >
        <Background gap={24} size={1} color="#2a3444" />
      </ReactFlow>

      {menu ? (
        <div
          className="dy-menu fixed z-50 min-w-40 rounded border border-harbor-700 bg-harbor-900 py-1 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={closeMenu}
        >
          {menu.kind === "server" && menu.nodeId != null ? (
            <>
              <MenuItem label="部署本仓库" onClick={() => openModal(routes.deploy.uiNewAppByNodeId(menu.nodeId!))} />
              <MenuItem label="添加数据库" onClick={() => openModal(routes.deploy.uiNewDbByNodeId(menu.nodeId!))} />
              <MenuItem
                label="移除卡片"
                danger
                onClick={async () => {
                  if (!confirm("移除这张卡片？（服务器与部署目标不动）")) return;
                  await fetch(routes.canvas.nodesById(menu.nodeId!), { method: "DELETE" });
                  // 岛自己的 fetch 不经 htmx，HX-Trigger 不会变成事件——手动重拉
                  await refetch();
                }}
              />
            </>
          ) : (
            servers.map((s) => (
              <MenuItem
                key={s.id}
                label={`＋ ${s.name}`}
                onClick={async () => {
                  await fetch(routes.canvas.projectsByProjectIdNodes(projectId), {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ serverId: s.id, x: menu.flowX, y: menu.flowY }),
                  });
                  await refetch();
                }}
              />
            ))
          )}
        </div>
      ) : null}
    </LiveContext.Provider>
  );
}

function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-harbor-800 ${danger ? "text-signal-500" : "text-neutral-200"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function Board({ projectId }: { projectId: number }) {
  return (
    <ReactFlowProvider>
      <Flow projectId={projectId} />
    </ReactFlowProvider>
  );
}
