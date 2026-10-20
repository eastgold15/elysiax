import { defineRealtime } from "@elysiax/core";

/**
 * 画布实时状态的事件总线（SSE 上游）。
 * 频道约定：`project:<projectId>`——部署状态迁移（deploy.service）与容器状态轮询（container-poller）
 * 往里推，SSE 端点（canvas.controller /ui/:projectId/events）订阅后推给浏览器。
 */
export type CanvasEvent =
  | { type: "status"; targetId: number; status: string }
  | { type: "running"; targetId: number; running: boolean }
  | { type: "state"; targetId: number; service: string; state: "running" | "exited" | "unknown" };

export const events = defineRealtime<CanvasEvent>();
