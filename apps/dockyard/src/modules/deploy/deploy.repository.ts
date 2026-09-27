import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { deployments, deployTargets, type Deployment, type DeployTarget } from "../../shared/schema";

export type NewTarget = Omit<typeof deployTargets.$inferInsert, "id" | "createdAt">;

export class DeployRepository {
  constructor(private readonly db: Db) {}

  targetsOfNode(nodeId: number): Promise<DeployTarget[]> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.nodeId, nodeId));
  }

  targetById(id: number): Promise<DeployTarget | undefined> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.id, id)).limit(1).then((r) => r[0]);
  }

  appTargets(): Promise<DeployTarget[]> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.kind, "app"));
  }

  async createTarget(input: NewTarget): Promise<DeployTarget> {
    const [row] = await this.db.insert(deployTargets).values(input).returning();
    return row!;
  }

  updateTarget(id: number, patch: Partial<DeployTarget>) {
    return this.db.update(deployTargets).set(patch).where(eq(deployTargets.id, id));
  }

  childrenOf(instanceId: number): Promise<DeployTarget[]> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.instanceOf, instanceId));
  }

  removeTarget(id: number) {
    return this.db.delete(deployTargets).where(eq(deployTargets.id, id));
  }

  async createDeployment(targetId: number): Promise<Deployment> {
    const [row] = await this.db.insert(deployments).values({ targetId }).returning();
    return row!;
  }

  /** 上次成功部署（逻辑库幂等判断用；不含本次 in-flight 行） */
  lastSuccessfulDeployment(targetId: number): Promise<Deployment | undefined> {
    return this.db
      .select().from(deployments)
      .where(and(eq(deployments.targetId, targetId), eq(deployments.status, "success")))
      .orderBy(desc(deployments.id)).limit(1)
      .then((r) => r[0]);
  }

  latestDeployment(targetId: number): Promise<Deployment | undefined> {
    return this.db
      .select().from(deployments)
      .where(eq(deployments.targetId, targetId))
      .orderBy(desc(deployments.id)).limit(1)
      .then((r) => r[0]);
  }

  updateDeployment(id: number, patch: Partial<Deployment>) {
    return this.db.update(deployments).set(patch).where(eq(deployments.id, id));
  }

  async appendLog(id: number, line: string) {
    const row = await this.db.select({ logText: deployments.logText }).from(deployments)
      .where(eq(deployments.id, id)).limit(1).then((r) => r[0]);
    await this.updateDeployment(id, { logText: `${row?.logText ?? ""}${line}\n` });
  }
}
