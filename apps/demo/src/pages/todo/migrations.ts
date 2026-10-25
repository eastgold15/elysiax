import { db } from "../../shared/db";
import { todosDDL } from "./schema";

// todo 原子自含迁移：模块加载即保证表存在。
// 幂等（CREATE IF NOT EXISTS），跟随 shared/db.ts 的现有风格。
db.run(todosDDL);
