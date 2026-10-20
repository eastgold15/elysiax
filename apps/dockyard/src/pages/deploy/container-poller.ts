import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { canvasNodes } from "../canvas/canvas.socket";
import type { ServerService } from "../servers/servers.socket";
import { deployTargets, type TargetServicesDoc } from "./schema";
import { events, type CanvasEvent } from "./events";

const INTERVAL_MS = 10_000;

type SvcState = "running" | "exited" | "unknown";

/**
 * 后台容器状态轮询：每台服务器一次 docker ls（SSH 中继），对账到 compose 服务级状态，
 * 与上轮快照 diff，只把变化推上事件总线（SSE 下游）。SSH 频率与前端用户数无关；
 * 无任何 SSE 订阅者的 project 直接跳过，不建连接。
 * DI 装配（deploy.di.ts provide），index.ts 从根容器取出后 start()。
 */
export class ContainerPoller {
  /** key = `${targetId}:${service}`；not-found 也记 unknown，容器消失时能推出变化 */
  private readonly snapshot = new Map<string, SvcState>();
  /** targetId → projectId（每轮重建，本地 sqlite 查询成本可忽略） */
  private readonly targetProject = new Map<number, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly serverService: ServerService,
    private readonly db: Db,
  ) {}

  /** SSE 端点订阅时的首帧：把该 project 已知的容器状态重发一遍 */
  containerStatesOf(projectId: number): CanvasEvent[] {
    const out: CanvasEvent[] = [];
    for (const [key, state] of this.snapshot) {
      const sep = key.indexOf(":");
      const targetId = Number(key.slice(0, sep));
      if (this.targetProject.get(targetId) !== projectId) continue;
      out.push({ type: "state", targetId, service: key.slice(sep + 1), state });
    }
    return out;
  }

  start(intervalMs = INTERVAL_MS) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    return this.timer;
  }

  private async tick() {
    const rows = await this.db
      .select({
        targetId: deployTargets.id,
        serverId: canvasNodes.serverId,
        projectId: canvasNodes.projectId,
        servicesJson: deployTargets.servicesJson,
      })
      .from(deployTargets)
      .innerJoin(canvasNodes, eq(deployTargets.nodeId, canvasNodes.id))
      .where(eq(deployTargets.kind, "app"));

    this.targetProject.clear();
    for (const r of rows) this.targetProject.set(r.targetId, r.projectId);

    const byServer = new Map<number, typeof rows>();
    for (const r of rows) {
      const arr = byServer.get(r.serverId) ?? [];
      arr.push(r);
      byServer.set(r.serverId, arr);
    }

    // target/服务被删 → 清掉快照里的孤儿 key（不推事件，前端结构 refresh 会带走卡片）；
    // 以 DB 行（而非本轮可达的服务器）为准，跳过/离线的服务器不会误清
    const known = new Set<string>();
    for (const r of rows)
      for (const s of r.servicesJson?.services ?? []) known.add(`${r.targetId}:${s.name}`);
    for (const key of this.snapshot.keys()) if (!known.has(key)) this.snapshot.delete(key);

    for (const [serverId, targets] of byServer) {
      const apps = targets.filter((t) => t.servicesJson?.services?.length);
      if (!apps.length) continue;
      if (!apps.some((t) => events.hasSubs(`project:${t.projectId}`))) continue; // 无观众不 SSH
      let containers: { Labels?: Record<string, string>; State?: string }[];
      try {
        const docker = await this.serverService.docker(serverId);
        containers = await docker.listContainers({ all: true }) as typeof containers;
      } catch {
        continue; // 服务器离线/SSH 失败 → 保持上轮快照，不推
      }
      for (const t of apps) {
        const doc = t.servicesJson as TargetServicesDoc;
        const project = doc.project ?? `dockyard-${t.targetId}`; // 与 deploy.service servicesOfTarget 同源
        for (const s of doc.services) {
          const match = (c: { Labels?: Record<string, string> }) =>
            c.Labels?.["com.docker.compose.project"] === project &&
            c.Labels?.["com.docker.compose.service"] === s.name;
          const hit = containers.find((c) => match(c) && c.State === "running") ?? containers.find(match);
          const state: SvcState = hit ? (hit.State === "running" ? "running" : "exited") : "unknown";
          const key = `${t.targetId}:${s.name}`;
          if (this.snapshot.get(key) === state) continue;
          this.snapshot.set(key, state);
          events.publish(`project:${t.projectId}`, { type: "state", targetId: t.targetId, service: s.name, state });
        }
      }
    }
  }
}
