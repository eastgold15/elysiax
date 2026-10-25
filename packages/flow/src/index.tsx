/** @jsxImportSource solid-js */
/**
 * @elysiax/flow：Solid 迷你流程画布基座——替代 @xyflow/react 的节点编辑器内核，
 * 纯 DOM + SVG 实现，无 VDOM 无 d3，指针事件全透明。
 *
 * 能力子集：平移缩放视口、父子相对定位节点（DOM 嵌套直接表达）、指针拖拽、
 * Resizer 拉伸、Handle 拖线连接、bezier 边 + 箭头、Delete/Backspace 删边。
 * 状态主权全在调用方：nodes/edges 是 props 数组，所有变化经回调上报——
 * 产物（DOM）与状态（信号）之间没有隐藏中间层。
 *
 * 主题约定：颜色一律走 CSS 变量（带 fallback），消费方在全局 CSS 覆盖即可：
 *   --flow-dot          背景点阵颜色（默认 #2a3444）
 *   --flow-handle-bg    Handle 圆点填充（默认 #d9a441）
 *   --flow-handle-border Handle 圆点描边（默认 #0f172a）
 *   --flow-resizer-bg   Resizer 填充（默认 #0f172a）
 *   --flow-resizer-border Resizer 描边（默认 #d9a441）
 *   --flow-conn         拖线中的临时连线颜色（默认 #d9a441）
 * 结构类名（.flow-node / [data-nodrag] / [data-flow-menu]）是行为钩子，勿改：
 *   - data-nodrag：元素不触发节点拖拽 / 视口平移
 *   - data-flow-menu：浮层菜单（右键菜单等），点击不触发 pane 的取消选中
 */
import {
  createContext, createEffect, createMemo, createSignal, For, onCleanup, onMount,
  useContext, type JSX,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

// ── 公共类型 ──────────────────────────────────────────────

export interface FlowNodeBase {
  id: string;
  type: string;
  /** 相对父节点的坐标（无父 = 相对画布原点） */
  position: { x: number; y: number };
  parentId?: string;
  width?: number;
  height?: number;
  selected?: boolean;
  dragging?: boolean;
  data: unknown;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  selected?: boolean;
  /** 笔画样式（SVG 属性值） */
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDasharray?: string;
  /** 末端箭头颜色（缺省无箭头） */
  arrowColor?: string;
}

export type NodeViewProps<D> = { id: string; data: D; selected: boolean; width?: number; height?: number };

export interface ConnectResult {
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
}

interface FlowCtx {
  /** 缩放系数（拖拽位移除以它换算成画布坐标） */
  zoom(): number;
  onResize(id: string, w: number, h: number, resizing: boolean): void;
  onResizeEnd(id: string, w: number, h: number): void;
}
const FlowContext = createContext<FlowCtx>();

// ── Handle：连接点（source 在右 / target 在左）──────────────

export function HandleView(props: {
  type: "source" | "target";
  id: string;
  title?: string;
}) {
  const side = () => (props.type === "source" ? "right" : "left");
  return (
    <div
      data-handle-id={props.id}
      data-handle-type={props.type}
      data-nodrag
      title={props.title}
      class={`absolute top-1/2 z-10 h-2.5 w-2.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 ${
        side() === "right" ? "-right-[5px]" : "-left-[5px]"
      }`}
      style={{
        "border-color": "var(--flow-handle-border, #0f172a)",
        background: "var(--flow-handle-bg, #d9a441)",
      }}
    />
  );
}

// ── Resizer：右下角拉伸柄（选中可见）────────────────────────

export function Resizer(props: {
  nodeId: string;
  visible: boolean;
  minW: number;
  minH: number;
  width: number;
  height: number;
  onEnd(w: number, h: number): void;
}) {
  const ctx = useContext(FlowContext)!;
  let start: { px: number; py: number; w: number; h: number } | null = null;

  const onDown = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start = { px: e.clientX, py: e.clientY, w: props.width, h: props.height };
  };
  const onMove = (e: PointerEvent) => {
    if (!start) return;
    const k = ctx.zoom();
    const w = Math.max(props.minW, start.w + (e.clientX - start.px) / k);
    const h = Math.max(props.minH, start.h + (e.clientY - start.py) / k);
    ctx.onResize(props.nodeId, w, h, true);
  };
  const onUp = (e: PointerEvent) => {
    if (!start) return;
    const k = ctx.zoom();
    const w = Math.max(props.minW, start.w + (e.clientX - start.px) / k);
    const h = Math.max(props.minH, start.h + (e.clientY - start.py) / k);
    start = null;
    ctx.onResize(props.nodeId, w, h, false);
    ctx.onResizeEnd(props.nodeId, w, h);
    props.onEnd(w, h);
  };

  return (
    <div
      data-nodrag
      class={`absolute right-0 bottom-0 z-10 h-3 w-3 cursor-nwse-resize rounded-sm border ${
        props.visible ? "" : "hidden"
      }`}
      style={{
        "border-color": "var(--flow-resizer-border, #d9a441)",
        background: "var(--flow-resizer-bg, #0f172a)",
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    />
  );
}

// ── FlowView ──────────────────────────────────────────────

export interface FlowViewProps<N extends FlowNodeBase> {
  nodes: N[];
  edges: FlowEdge[];
  /** type → 节点视图组件 */
  nodeViews: Record<string, (p: NodeViewProps<never>) => JSX.Element>;
  onNodeMove(id: string, pos: { x: number; y: number }): void;
  onNodeDragStart?(node: N): void;
  onNodeDragStop?(node: N): void;
  onNodeClick?(e: MouseEvent, node: N): void;
  onNodeContextMenu?(e: MouseEvent, node: N): void;
  onNodeSelect?(id: string | null): void;
  onPaneClick?(): void;
  onPaneContextMenu?(e: MouseEvent): void;
  onMoveStart?(): void;
  onNodeResize?(id: string, w: number, h: number, resizing: boolean): void;
  onNodeResizeEnd?(id: string, w: number, h: number): void;
  onConnect?(c: ConnectResult): void;
  onEdgeSelect?(id: string | null): void;
  onEdgesRemove?(ids: string[]): void;
  minZoom?: number;
  /** 首帧数据到达时自动适配视野 */
  fitView?: boolean;
  /** 视口背景层：渲染在 transform 层内、边与节点之下（随 pan/zoom，须自带 pointer-events-none） */
  background?: JSX.Element;
  /** 暴露 screenToFlowPosition 给父组件（右键菜单建卡用） */
  ref?(api: { screenToFlowPosition(p: { x: number; y: number }): { x: number; y: number } }): void;
}

export function FlowView<N extends FlowNodeBase>(props: FlowViewProps<N>) {
  let pane!: HTMLDivElement;
  /** 视口变换：平移 + 缩放 */
  const [t, setT] = createSignal({ x: 0, y: 0, k: 1 });
  const minZoom = () => props.minZoom ?? 0.2;

  const screenToFlowPosition = (p: { x: number; y: number }) => {
    const rect = pane.getBoundingClientRect();
    const cur = t();
    return { x: (p.x - rect.left - cur.x) / cur.k, y: (p.y - rect.top - cur.y) / cur.k };
  };
  props.ref?.({ screenToFlowPosition });

  // fitView：首批节点到达时跑一次，把根节点纳入视野
  let fitted = false;
  createEffect(() => {
    if (!props.fitView || fitted || !props.nodes.length) return;
    fitted = true;
    const roots = props.nodes.filter((n) => !n.parentId);
    if (!roots.length) return;
    const x0 = Math.min(...roots.map((n) => n.position.x));
    const y0 = Math.min(...roots.map((n) => n.position.y));
    const x1 = Math.max(...roots.map((n) => n.position.x + (n.width ?? 0)));
    const y1 = Math.max(...roots.map((n) => n.position.y + (n.height ?? 0)));
    const rect = pane.getBoundingClientRect();
    const k = Math.min(rect.width / (x1 - x0 + 80), rect.height / (y1 - y0 + 80), 1);
    const kk = Math.max(minZoom(), k);
    setT({
      k: kk,
      x: rect.width / 2 - ((x0 + x1) / 2) * kk,
      y: rect.height / 2 - ((y0 + y1) / 2) * kk,
    });
  });

  // 节点按 id 入 store 再渲染：props.nodes 每次拖拽都换新对象引用，直接 <For> 会把
  // 被拖节点的 DOM 整个重建 → 指针捕获丢失、拖拽断掉（实测卡成“每次只动一点”）。
  // reconcile 按 id 原地合并字段，代理引用稳定 → DOM 不重建，样式细粒度更新。
  const [nodeStore, setNodeStore] = createStore<Record<string, N>>(
    Object.fromEntries(props.nodes.map((n) => [n.id, n])),
  );
  createEffect(() => {
    setNodeStore(reconcile(Object.fromEntries(props.nodes.map((n) => [n.id, n]))));
  });

  // 边的端点需要绝对坐标：沿父链累加
  const absPos = createMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const byId = new Map(props.nodes.map((n) => [n.id, n]));
    const walk = (n: N): { x: number; y: number } => {
      const hit = map.get(n.id);
      if (hit) return hit;
      let { x, y } = n.position;
      if (n.parentId) {
        const p = byId.get(n.parentId);
        if (p) {
          const pp = walk(p);
          x += pp.x;
          y += pp.y;
        }
      }
      map.set(n.id, { x, y });
      return { x, y };
    };
    for (const n of props.nodes) walk(n);
    return map;
  });

  // ── 视口平移/缩放 ──
  let panStart: { px: number; py: number; tx: number; ty: number } | null = null;
  const onPanePointerDown = (e: PointerEvent) => {
    // 事件委托接 Handle 拖线起点（HandleView 带 data-nodrag，下面的 nodrag 早退会拦掉它，
    // 必须先判）：点到 source handle = 开始拖线
    const handle = (e.target as HTMLElement).closest("[data-handle-type='source']");
    if (handle) {
      const nodeId = handle.closest("[data-node-id]")?.getAttribute("data-node-id");
      const handleId = handle.getAttribute("data-handle-id");
      if (nodeId && handleId) {
        onHandlePointerDown(e, nodeId, handleId);
        return;
      }
    }
    // 点在节点/手柄/浮层菜单上不 pan
    if ((e.target as HTMLElement).closest("[data-nodrag], .flow-node, [data-flow-menu]")) return;
    props.onMoveStart?.();
    panStart = { px: e.clientX, py: e.clientY, tx: t().x, ty: t().y };
    pane.setPointerCapture(e.pointerId);
  };
  const onPanePointerMove = (e: PointerEvent) => {
    if (panStart) {
      setT((c) => ({ ...c, x: panStart!.tx + e.clientX - panStart!.px, y: panStart!.ty + e.clientY - panStart!.py }));
    }
    updateConn(e);
  };
  const onPanePointerUp = (e: PointerEvent) => {
    panStart = null;
    finishConn(e);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const cur = t();
    const k = Math.min(2, Math.max(minZoom(), cur.k * (e.deltaY > 0 ? 0.9 : 1.1)));
    // 以光标为中心缩放
    const rect = pane.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    setT({
      k,
      x: cx - ((cx - cur.x) / cur.k) * k,
      y: cy - ((cy - cur.y) / cur.k) * k,
    });
  };

  // ── 拖线连接（Handle source → target）──
  const [conn, setConn] = createSignal<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  let connSource: { nodeId: string; handleId: string } | null = null;
  const onHandlePointerDown = (e: PointerEvent, nodeId: string, handleId: string) => {
    e.stopPropagation();
    e.preventDefault();
    connSource = { nodeId, handleId };
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setConn({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    pane.setPointerCapture(e.pointerId);
  };
  const updateConn = (e: PointerEvent) => {
    if (!connSource) return;
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setConn((c) => (c ? { ...c, x2: p.x, y2: p.y } : c));
  };
  const finishConn = (e: PointerEvent) => {
    if (!connSource) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-handle-type='target']");
    const src = connSource;
    connSource = null;
    setConn(null);
    if (!el) return;
    const targetNode = el.closest("[data-node-id]")?.getAttribute("data-node-id");
    if (!targetNode || targetNode === src.nodeId) return;
    props.onConnect?.({
      source: src.nodeId,
      sourceHandle: src.handleId,
      target: targetNode,
      targetHandle: el.getAttribute("data-handle-id") ?? undefined,
    });
  };

  // ── 键盘删边 ──
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const ids = props.edges.filter((ed) => ed.selected).map((ed) => ed.id);
    if (ids.length) props.onEdgesRemove?.(ids);
  };

  // ── 节点外壳：定位 + 拖拽 + 点击/右键 ──
  function NodeShell(props2: { node: N; children: JSX.Element }) {
    const n = () => props2.node;
    let dragStart: { px: number; py: number; nx: number; ny: number } | null = null;
    let moved = false;

    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-nodrag], a, button, input, select, textarea")) return;
      e.stopPropagation();
      moved = false;
      dragStart = { px: e.clientX, py: e.clientY, nx: n().position.x, ny: n().position.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      props.onNodeDragStart?.(n());
    };
    const onMove = (e: PointerEvent) => {
      if (!dragStart) return;
      const k = t().k;
      const dx = (e.clientX - dragStart.px) / k, dy = (e.clientY - dragStart.py) / k;
      if (Math.abs(e.clientX - dragStart.px) + Math.abs(e.clientY - dragStart.py) > 4) moved = true;
      props.onNodeMove(n().id, { x: dragStart.nx + dx, y: dragStart.ny + dy });
    };
    const onUp = (e: PointerEvent) => {
      if (!dragStart) return;
      dragStart = null;
      props.onNodeDragStop?.(n());
      // click 在 pointerup 之后触发，用 moved 抑制拖拽后的误点击
      if (!moved) {
        props.onNodeSelect?.(n().id);
        props.onNodeClick?.(e, n());
      }
    };

    return (
      <div
        data-node-id={n().id}
        class="flow-node absolute"
        style={{
          left: `${n().position.x}px`,
          top: `${n().position.y}px`,
          width: n().width ? `${n().width}px` : undefined,
          height: n().height ? `${n().height}px` : undefined,
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onContextMenu={(e) => {
          e.stopPropagation();
          props.onNodeContextMenu?.(e, n());
        }}
      >
        {props2.children}
      </div>
    );
  }

  /** 递归渲染：子节点 DOM 嵌在父节点里，position 父相对值直接用；条目取 store 代理保持引用稳定 */
  function NodeTree(props2: { parentId?: string }) {
    const kids = createMemo(() =>
      props.nodes.flatMap((n) => {
        if (n.parentId !== props2.parentId) return [];
        const s = nodeStore[n.id]; // 同步窗口期可能未入 store，过滤掉
        return s ? [s] : [];
      }),
    );
    return (
      <For each={kids()}>
        {(n) => (
          <NodeShell node={n}>
            {(() => {
              const View = props.nodeViews[n.type];
              if (!View) return null;
              return (
                <View
                  id={n.id}
                  data={n.data as never}
                  selected={n.selected ?? false}
                  width={n.width}
                  height={n.height}
                />
              );
            })()}
            <NodeTree parentId={n.id} />
          </NodeShell>
        )}
      </For>
    );
  }

  // ── 边渲染 ──
  const edgePaths = createMemo(() =>
    props.edges.flatMap((e) => {
      const s = absPos().get(e.source);
      const tg = absPos().get(e.target);
      if (!s || !tg) return [];
      const sn = props.nodes.find((n) => n.id === e.source);
      const tn = props.nodes.find((n) => n.id === e.target);
      const sx = s.x + (sn?.width ?? 0), sy = s.y + (sn?.height ?? 0) / 2;
      const tx = tg.x, ty = tg.y + (tn?.height ?? 0) / 2;
      const d = Math.max(40, Math.abs(tx - sx) / 2);
      return [{
        e,
        path: `M ${sx} ${sy} C ${sx + d} ${sy} ${tx - d} ${ty} ${tx} ${ty}`,
      }];
    }),
  );

  const arrowColors = createMemo(() =>
    [...new Set(edgePaths().map((p) => p.e.arrowColor).filter((c): c is string => Boolean(c)))],
  );

  onMount(() => pane.addEventListener("wheel", onWheel, { passive: false }));
  onCleanup(() => pane.removeEventListener("wheel", onWheel));

  return (
    <FlowContext.Provider
      value={{
        zoom: () => t().k,
        onResize: (id, w, h, resizing) => props.onNodeResize?.(id, w, h, resizing),
        onResizeEnd: (id, w, h) => props.onNodeResizeEnd?.(id, w, h),
      }}
    >
      <div
        ref={pane}
        tabIndex={0}
        class="relative h-full w-full overflow-hidden outline-none"
        style={{
          // 背景点阵随视口平移缩放
          "background-image": "radial-gradient(circle, var(--flow-dot, #2a3444) 1px, transparent 1px)",
          "background-size": `${24 * t().k}px ${24 * t().k}px`,
          "background-position": `${t().x}px ${t().y}px`,
        }}
        onPointerDown={onPanePointerDown}
        onPointerMove={onPanePointerMove}
        onPointerUp={onPanePointerUp}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest(".flow-node, [data-flow-menu]")) {
            props.onNodeSelect?.(null);
            props.onEdgeSelect?.(null);
            props.onPaneClick?.();
          }
        }}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".flow-node")) return; // 节点右键由 NodeShell 处理
          e.preventDefault();
          props.onPaneContextMenu?.(e);
        }}
        onKeyDown={onKeyDown}
      >
        <div
          class="absolute inset-0"
          style={{
            transform: `translate(${t().x}px, ${t().y}px) scale(${t().k})`,
            "transform-origin": "0 0",
          }}
        >
          {props.background}
          <svg class="absolute overflow-visible" style={{ width: "1px", height: "1px" }}>
            <defs>
              <For each={arrowColors()}>
                {(color) => (
                  <marker
                    id={`arrow-${color.replace("#", "")}`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="8"
                    markerHeight="8"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
                  </marker>
                )}
              </For>
            </defs>
            <For each={edgePaths()}>
              {({ e, path }) => (
                <g>
                  {/* 加宽的隐形命中层，便于点击选中 */}
                  <path
                    d={path}
                    fill="none"
                    stroke="transparent"
                    stroke-width="12"
                    class="cursor-pointer"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      props.onEdgeSelect?.(e.id);
                    }}
                  />
                  <path
                    d={path}
                    fill="none"
                    stroke={e.stroke ?? "#64748b"}
                    stroke-opacity={e.strokeOpacity ?? 1}
                    stroke-width={e.selected ? (e.strokeWidth ?? 1.5) + 1 : (e.strokeWidth ?? 1.5)}
                    stroke-dasharray={e.strokeDasharray}
                    marker-end={e.arrowColor ? `url(#arrow-${e.arrowColor.replace("#", "")})` : undefined}
                  />
                </g>
              )}
            </For>
            {conn() ? (
              <path
                d={`M ${conn()!.x1} ${conn()!.y1} L ${conn()!.x2} ${conn()!.y2}`}
                fill="none"
                stroke-width="1.5"
                stroke-dasharray="5 3"
                style={{ stroke: "var(--flow-conn, #d9a441)" }}
              />
            ) : null}
          </svg>
          <NodeTree />
        </div>
      </div>
    </FlowContext.Provider>
  );
}
