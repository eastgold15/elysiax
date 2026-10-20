import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { parseOwnerRepo, type GithubService } from "../github/github.socket";
import { deployTargets } from "./schema";

const INTERVAL_MS = 60_000;

/**
 * 后台更新轮询（替代 webhook）：对每个 app 目标查分支最新 sha，
 * 与 lastKnownSha 不同则置 updateAvailable —— 只提示，不自动部署。
 * DI 装配（deploy.di.ts provide），index.ts 从根容器取出后 start()。
 */
export class UpdatePoller {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly github: GithubService,
    private readonly db: Db,
  ) {}

  start(intervalMs = INTERVAL_MS) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    return this.timer;
  }

  private async tick() {
    const apps = await this.db.select().from(deployTargets).where(eq(deployTargets.kind, "app"));
    for (const target of apps) {
      if (!target.repoUrl) continue;
      try {
        let ownerRepo: string;
        try {
          ownerRepo = parseOwnerRepo(target.repoUrl);
        } catch {
          continue;
        }
        const result = await this.github.latestSha(ownerRepo, target.branch ?? "main", target.etag ?? undefined);
        if (!result) continue; // 304 无变化
        await this.db.update(deployTargets).set({
          etag: result.etag ?? target.etag,
          updateAvailable: target.lastKnownSha !== null && result.sha.slice(0, 8) !== target.lastKnownSha,
        }).where(eq(deployTargets.id, target.id));
      } catch (error) {
        console.warn(`[poller] target ${target.id}: ${(error as Error).message}`);
      }
    }
  }
}
