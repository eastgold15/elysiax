// board 原子的表锚点（裸 SQL 原子：DDL 字符串即表声明，理由见 user/schema.ts）。
/** 表名锚点 */
export const boardCardsTable = "board_cards";

/** 建表 DDL */
export const boardCardsDDL = `
  CREATE TABLE IF NOT EXISTS board_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    column TEXT NOT NULL DEFAULT 'todo'
  );
`;
