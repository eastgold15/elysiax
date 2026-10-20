// deploy 原子的插座：部署目标/部署历史表 + 部署服务 + 事件总线 + 轮询器 + 自动识别。
// client（浏览器包）只允许 import type（值会打进浏览器包）。
export { deployTargets, deployments } from "./schema";
export type { DeployTarget, Deployment, TargetService, TargetServicesDoc, DepEdge } from "./schema";
export { DeployService } from "./deploy.service";
export type { DbRef } from "./deploy.service";
export { events } from "./events";
export type { CanvasEvent } from "./events";
export { ContainerPoller } from "./container-poller";
export { UpdatePoller } from "./update-poller";
export { detectRepo, detectLocal, detectToEnvText, detectToOverrideCompose, guessDbType } from "./detect";
export type { DetectResult, DetectedService } from "./detect";
