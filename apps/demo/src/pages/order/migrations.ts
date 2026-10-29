import { db } from "../../shared/db";
import { ordersDDL } from "./schema";

// order 原子自含迁移：模块加载即保证表存在（幂等）。
db.run(ordersDDL);

// 种子（仅首次）：订单的 user_id 指向 user 原子的种子行。
// bun:sqlite 默认 foreign_keys=0，与 user 种子的加载顺序无关。
if ((db.query("SELECT COUNT(*) AS c FROM orders").get() as { c: number }).c === 0) {
  db.run("INSERT INTO orders (user_id, amount) VALUES (1, 99.5), (1, 12.0), (2, 42.0)");
}
