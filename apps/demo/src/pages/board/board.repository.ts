import type { Database } from "bun:sqlite";

/** 看板三列（固定集合，client 与服务端共用此类型） */
export type Column = "todo" | "doing" | "done";

/** 卡片行（board_cards 表的形状） */
export interface Card {
  id: number;
  title: string;
  column: Column;
}

export class BoardRepository {
  constructor(private db: Database) {
    // 表锚点自含：原子自己的表自己建，不动 shared/db.ts（契约 §5 不碰共享文件）
    this.db.run(`
      CREATE TABLE IF NOT EXISTS board_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        column TEXT NOT NULL DEFAULT 'todo'
      );
    `);
    // 种子数据（仅首次），跟随 shared/db.ts 的写法
    const { c } = this.db.query("SELECT COUNT(*) AS c FROM board_cards").get() as { c: number };
    if (c === 0) {
      this.db.run(
        "INSERT INTO board_cards (title, column) VALUES ('接需求', 'todo'), ('写代码', 'doing'), ('已上线', 'done')",
      );
    }
  }

  findAll(): Card[] {
    return this.db.query("SELECT id, title, column FROM board_cards ORDER BY id").all() as Card[];
  }

  create(title: string): Card {
    return this.db
      .query("INSERT INTO board_cards (title, column) VALUES (?, 'todo') RETURNING id, title, column")
      .get(title) as Card;
  }

  /** 移动到新列；不存在返回 null（由上层决定 404） */
  move(id: number, column: Column): Card | null {
    return this.db
      .query("UPDATE board_cards SET column = ? WHERE id = ? RETURNING id, title, column")
      .get(column, id) as Card | null;
  }

  /** 删除；返回是否有行受影响 */
  remove(id: number): boolean {
    return this.db.query("DELETE FROM board_cards WHERE id = ? RETURNING id").get(id) !== null;
  }
}
