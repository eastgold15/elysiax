// order 原子的表锚点（裸 SQL 原子：DDL 字符串即表声明，理由见 user/schema.ts）。
/** 表名锚点 */
export const ordersTable = "orders";

/** 建表 DDL：外键指向 users 是插头（跨原子 REFERENCES 允许） */
export const ordersDDL = `
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`;
