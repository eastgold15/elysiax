import { db } from "../../shared/db";
import { ordersDDL } from "./schema";

// order 原子自含迁移：模块加载即保证表存在（幂等）。
db.run(ordersDDL);

// 种子（仅首次）：订单的 user_id 指向 user 原子的种子行。
// 前提是 users 从空表起步（AUTOINCREMENT 让 Alice/Bob 拿到 1/2）；这是 demo 种子
// 的固有约定，不是跨原子契约——旧库若已有 users 且 id 不是 1/2，这些订单会静默
// 指向别的用户（bun:sqlite 默认 foreign_keys=0，不会报错），demo 不为此兜底。
if ((db.query("SELECT COUNT(*) AS c FROM orders").get() as { c: number }).c === 0) {
  db.run("INSERT INTO orders (user_id, amount) VALUES (1, 99.5), (1, 12.0), (2, 42.0)");
}
