import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { canvasNodes, type CanvasNode } from "../../shared/schema";

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
}
