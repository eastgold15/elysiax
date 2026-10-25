// canvas 原子的插座：表锚点（canvas_nodes/service_groups）+ 画布服务。
export { canvasNodes, serviceGroups } from "./schema";
export type { CanvasNode, ServiceGroup } from "./schema";
export { CanvasService } from "./canvas.service";

// Eden Treaty 的 API 类型出口（同原子 client 引用）
import type canvasApi from "./canvas.actions";
export type CanvasApi = typeof canvasApi;
