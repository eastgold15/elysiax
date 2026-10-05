import { eq } from "drizzle-orm";
import { db } from "../../shared/db";
import { deployTargets, canvasNodes, type TargetServicesDoc } from "../../shared/schema";
import { events, type CanvasEvent } from "../../shared/events";
import { ServerRepository } from "../servers/servers.repository";
import { SshPool } from "../servers/ssh-pool";
import { DockerRelay } from "../servers/docker-relay";
import { ServerService } from "../servers/servers.service";

const INTERVAL_MS = 10_000;

type SvcState = "running" | "exited" | "unknown";
  
/** key = `${targetId}:${service}`；not-found 也记 unknown，容器消失时能推出变化 */
const snapshot = new Map<string, SvcState>();
/** targetId → projectId（每轮重建，本地 sqlite 查询成本可忽略） */
const targetProject = new Map<number, number>();

/** SSE 端点订阅时的首帧：把该 project 已知的容器状态重发一遍 */
export function containerStatesOf(projectId: number): CanvasEvent[] {
  const out: CanvasEvent[] = [];
  for (const [key, state] of snapshot) {
    const sep = key.indexOf(":");
    const targetId = Number(key.slice(0, sep));
    if (targetProject.get(targetId) !== projectId) continue;
    out.push({ type: "state", targetId, service: key.slice(sep + 1), state });
  }
  return out;
}

/**
 * 后台容器状态轮询：每台服务器一次 docker ls（SSH 中继），对账到 compose 服务级状态，
 * 与上轮快照 diff，只把变化推上事件总线（SSE 下游）。SSH 频率与前端用户数无关；
 * 无任何 SSE 订阅者的 project 直接跳过，不建连接。
 * 独立于 DI 容器启动（index.ts 调用），与 update-poller 同模式。
 */
export function startContainerPoller(intervalMs = INTERVAL_MS) {
  const serverService = new ServerService(new ServerRepository(db), new SshPool(), new DockerRelay());
  const tick = async () => {
    const rows = await db
      .select({
        targetId: deployTargets.id,
        serverId: canvasNodes.serverId,
        projectId: canvasNodes.projectId,
        servicesJson: deployTargets.servicesJson,
      })
      .from(deployTargets)
      .innerJoin(canvasNodes, eq(deployTargets.nodeId, canvasNodes.id))
      .where(eq(deployTargets.kind, "app"));

    targetProject.clear();
    for (const r of rows) targetProject.set(r.targetId, r.projectId);

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
    for (const key of snapshot.keys()) if (!known.has(key)) snapshot.delete(key);

    for (const [serverId, targets] of byServer) {
      const apps = targets.filter((t) => t.servicesJson?.services?.length);
      if (!apps.length) continue;
      if (!apps.some((t) => events.hasSubs(`project:${t.projectId}`))) continue; // 无观众不 SSH
      let containers: { Labels?: Record<string, string>; State?: string }[];
      try {
        const docker = await serverService.docker(serverId);
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
          if (snapshot.get(key) === state) continue;
          snapshot.set(key, state);
          events.publish(`project:${t.projectId}`, { type: "state", targetId: t.targetId, service: s.name, state });
        }
      }
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
