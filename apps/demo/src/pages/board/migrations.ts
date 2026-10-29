import { db } from "../../shared/db";
import { boardCardsDDL } from "./schema";

// board 原子自含迁移：模块加载即保证表存在（幂等）。
db.run(boardCardsDDL);
