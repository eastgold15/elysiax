import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { canvasNodes, serviceGroups, type CanvasNode, type ServiceGroup } from "../../shared/schema";

export class CanvasRepository {
  constructor(private readonly db: Db) {}

  nodesOf(projectId: number): Promise<CanvasNode[]> {
    return this.db.select().from(canvasNodes).where(eq(canvasNodes.projectId, projectId));
  }

  byId(id: number): Promise<CanvasNode | undefined> {
    return this.db.select().from(canvasNodes).where(eq(canvasNodes.id, id)).limit(1).then((r) => r[0]);
  }

  async add(projectId: number, serverId: number, x: number, y: number): Promise<CanvasNode> {
    const [row] = await this.db.insert(canvasNodes).values({ projectId, serverId, x, y }).returning();
    return row!;
  }

  /** 位置/尺寸持久化（拖拽、resize 结束调用） */
  move(id: number, patch: Partial<Pick<CanvasNode, "x" | "y" | "w" | "h">>) {
    return this.db.update(canvasNodes).set(patch).where(eq(canvasNodes.id, id));
  }

  remove(id: number) {
    return this.db.delete(canvasNodes).where(eq(canvasNodes.id, id));
  }

  // ── 服务分组（服务器卡内的命名容器）──
  groupsOf(nodeId: number): Promise<ServiceGroup[]> {
    return this.db.select().from(serviceGroups).where(eq(serviceGroups.nodeId, nodeId)).orderBy(serviceGroups.id);
  }

  async addGroup(nodeId: number, name: string): Promise<ServiceGroup> {
    const [row] = await this.db.insert(serviceGroups).values({ nodeId, name }).returning();
    return row!;
  }

  updateGroup(id: number, patch: Partial<Pick<ServiceGroup, "name" | "x" | "y" | "w" | "h">>) {
    return this.db.update(serviceGroups).set(patch).where(eq(serviceGroups.id, id));
  }

  removeGroup(id: number) {
    return this.db.delete(serviceGroups).where(eq(serviceGroups.id, id));
  }
}
