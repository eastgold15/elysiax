// todo 原子的表锚点。
// 说明：契约 §1.2 默认 drizzle，但 demo 的 db 是 bun:sqlite 裸 SQL（见 src/shared/db.ts），
// 按契约「若 demo 的 db 是内存/其他实现则跟随现状」条款，本文件用 DDL 字符串做表锚点。

/** 表名锚点 */
export const todosTable = "todos";

/** 建表 DDL（迁移与任何需要重建的场景共用这一份定义） */
export const todosDDL = `
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`;

/** 行类型（done 以 0/1 存储，读出后在 service 层归一为 boolean） */
export interface TodoRow {
  id: number;
  title: string;
  done: number;
  created_at: string;
}

/** 对外暴露的领域类型 */
export interface Todo {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
}

/** 新增输入 */
export interface CreateTodoInput {
  title: string;
}
