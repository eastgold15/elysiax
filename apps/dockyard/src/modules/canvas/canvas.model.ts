/**
 * 画布视图模型：controller 的 canvasData 组装（跨 deploy/edge/server 上下文）。
 * 只含结构 + 布局——实时状态（部署 status / 容器 state / running）不走这里，
 * 由 SSE /ui/:projectId/events 推送（岛端 LiveState 消费）。
 * 单独成文件是因为消费方有两端——服务端 shell（canvas.ui.tsx）与 React 岛（island/），
 * 岛通过 /api/canvas/ui/:id/board 拿到同构 JSON。
 */
export interface DomainBadge {
  hostname: string;
  sslStatus: "none" | "pending" | "active" | "error";
  dnsStatus: "unknown" | "ok" | "mismatch";
  serviceName?: string | null; // 归属的 compose 服务（下沉到服务行用）
  targetPort?: number;
}

/** app 小卡片里的 compose 服务行 */
export type ServiceState = "running" | "exited" | "unknown"; // 实时状态类型（SSE 推送用，不进本模型）
export interface ServiceRow {
  name: string;
  port?: number;
  image?: string;
  domains: DomainBadge[]; // 绑到该服务的域名（按 serviceName 下沉）
  x?: number; y?: number; // 服务卡在 app 卡内的位置（serviceLayout；空 → 岛端自动摆）
}

/** 服务级依赖边：service=null 表示 app 整体依赖（连到 app 卡而非服务卡） */
export interface DepEdgeModel {
  service: string | null;
  db: number;     // db target id
  dbName: string;
}

export interface TargetModel {
  id: number;
  kind: "app" | "db";
  name: string;
  logical: boolean;
  url?: string; // 逻辑库连接串（复制按钮）
  domains: DomainBadge[]; // 无 serviceName 归属的域名（有归属的下沉到 services 行）
  services: ServiceRow[]; // kind=app 有效；空数组 → 前端按行式渲染降级
  edges: DepEdgeModel[];  // 服务级依赖边（岛端派生 React Flow 边）
  groupId: number | null; // 所属服务分组（null = 直接挂服务器卡）
  x: number | null; y: number | null; // 卡在父容器（服务器卡/分组）内的位置（null → 岛端自动摆）
  w: number | null; h: number | null; // 手动拉伸的卡尺寸（null → 按子卡 bounds 收敛；有值作下限）
  updateAvailable: boolean;
}

/** 服务分组：服务器卡内的命名容器（Railway Service Group） */
export interface GroupModel {
  id: number;
  name: string;
  x: number; y: number; w: number; h: number;
}

export interface CardModel {
  node: { id: number; x: number; y: number; w: number; h: number };
  server: {
    id: number; name: string; user: string; host: string; port: number;
    dockerStatus: "unknown" | "ok" | "missing"; dockerVersion: string | null;
  };
  targets: TargetModel[];
  groups: GroupModel[]; // 服务器卡内的服务分组容器
}

/** /board 载荷：结构 + 布局（无实时）——实时状态见 /events（SSE） */
export interface BoardModel {
  servers: { id: number; name: string }[];
  cards: CardModel[];
  // 依赖边由岛端从 TargetModel.edges（服务级）派生，不再单独下发卡片级 links
}
