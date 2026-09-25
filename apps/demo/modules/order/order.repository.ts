import type { Database } from "bun:sqlite";
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
