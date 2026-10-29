import type { Database } from "bun:sqlite";
// 副作用 import：保证首次访问数据前本原子的迁移已执行（表锚点在 order/schema.ts）
import "./migrations";
import type { Order } from "./order.model";

export class OrderRepository {
  constructor(private db: Database) {}

  findByUser(userId: number): Order[] {
    return this.db
      .query(
        "SELECT id, user_id as userId, amount FROM orders WHERE user_id = ?",
      )
      .all(userId) as Order[];
  }
}
