// user 原子的表锚点。
// demo 的 db 是 bun:sqlite 裸 SQL（见 src/shared/db.ts），按契约「跟随现状」条款，
// 本文件用 DDL 字符串做表锚点——裸 SQL 表也必须在这里声明，否则 doctor 的 schema 漂移检查
// 会把真实业务表当成「旧表名残留」。
/** 表名锚点 */
export const usersTable = "users";

/** 建表 DDL（迁移与任何需要重建的场景共用这一份定义） */
export const usersDDL = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );
`;
