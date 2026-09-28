/** @jsxImportSource react */
/**
 * 画布三源之一：实时状态（部署 status / running、容器 state）。
 * 唯一来源是 SSE /api/canvas/ui/:id/events；只进 LiveContext，不进 node.data——
 * 这样一条 SSE 消息只让订阅的徽章/状态点重渲染，nodes 数组不变，React Flow 不整体重渲染。
 */
import { createContext, useContext } from "react";
import type { ServiceState } from "../canvas.model";

export type DeployStatus = "queued" | "building" | "transferring" | "deploying" | "success" | "failed";

export interface LiveState {
  targets: Record<number, { status: DeployStatus | null; running: boolean }>;
  services: Record<string, ServiceState>; // key = `${targetId}:${svcName}`
}

export const emptyLive: LiveState = { targets: {}, services: {} };

export const LiveContext = createContext<LiveState>(emptyLive);

export const useTargetLive = (targetId: number) =>
  useContext(LiveContext).targets[targetId] ?? { status: null, running: false };

export const useServiceState = (targetId: number, svcName: string): ServiceState =>
  useContext(LiveContext).services[`${targetId}:${svcName}`] ?? "unknown";

/** SSE 消息 → LiveState 增量 */
export function applyLiveEvent(prev: LiveState, msg: Record<string, unknown>): LiveState {
  if (msg.type === "status") {
    const t = prev.targets[msg.targetId as number] ?? { status: null, running: false };
    return {
      ...prev,
      targets: { ...prev.targets, [msg.targetId as number]: { ...t, status: msg.status as DeployStatus } },
    };
  }
  if (msg.type === "running") {
    const t = prev.targets[msg.targetId as number] ?? { status: null, running: false };
    return {
      ...prev,
      targets: { ...prev.targets, [msg.targetId as number]: { ...t, running: Boolean(msg.running) } },
    };
  }
  if (msg.type === "state") {
    return {
      ...prev,
      services: { ...prev.services, [`${msg.targetId}:${msg.service}`]: msg.state as ServiceState },
    };
  }
  return prev;
}
