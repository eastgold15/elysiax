// canvas 原子的插座：表锚点（canvas_nodes/service_groups）+ 画布服务。
export { canvasNodes, serviceGroups } from "./schema";
export type { CanvasNode, ServiceGroup } from "./schema";
export { CanvasService } from "./canvas.service";

/** 本机服务器判定（部署通道分界线）：回环地址派生，不落库；canvas/deploy 两侧共用 */
export const isLocalHost = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";

// Eden Treaty 的 API 类型出口（同原子 client 引用）
import type canvasApi from "./canvas.actions";
export type CanvasApi = typeof canvasApi;
