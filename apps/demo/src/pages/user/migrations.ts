import { db } from "../../shared/db";
import { usersDDL } from "./schema";

// user 原子自含迁移：模块加载即保证表存在（幂等，跟随 shared/db.ts 的现有风格）。
db.run(usersDDL);

// 种子（仅首次）：demo 的用户页需要几行示例数据
if ((db.query("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c === 0) {
  db.run("INSERT INTO users (name) VALUES ('Alice'), ('Bob')");
}
