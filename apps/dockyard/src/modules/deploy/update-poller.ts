import { db } from "../../shared/db";
import { GithubService } from "../github/github.service";
import { parseOwnerRepo } from "./deploy.service";
import { deployTargets } from "../../shared/schema";
import { eq } from "drizzle-orm";

const INTERVAL_MS = 60_000;

/**
 * 后台更新轮询（替代 webhook）：对每个 app 目标查分支最新 sha，
 * 与 lastKnownSha 不同则置 updateAvailable —— 只提示，不自动部署。
 * 独立于 DI 容器启动（index.ts 调用），DI 服务走请求作用域，轮询是进程级。
 */
export function startUpdatePoller(intervalMs = INTERVAL_MS) {
  const github = new GithubService();
  const tick = async () => {
    const apps = await db.select().from(deployTargets).where(eq(deployTargets.kind, "app"));
    for (const target of apps) {
      if (!target.repoUrl) continue;
      try {
        let ownerRepo: string;
        try {
          ownerRepo = parseOwnerRepo(target.repoUrl);
        } catch {
          continue;
        }
        const result = await github.latestSha(ownerRepo, target.branch ?? "main", target.etag ?? undefined);
        if (!result) continue; // 304 无变化
        await db.update(deployTargets).set({
          etag: result.etag ?? target.etag,
          updateAvailable: target.lastKnownSha !== null && result.sha.slice(0, 8) !== target.lastKnownSha,
        }).where(eq(deployTargets.id, target.id));
      } catch (error) {
        console.warn(`[poller] target ${target.id}: ${(error as Error).message}`);
      }
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
