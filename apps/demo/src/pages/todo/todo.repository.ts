import type { Database } from "bun:sqlite";
// 副作用 import：保证首次访问数据前本原子的迁移已执行
import "./migrations";
import type { CreateTodoInput, Todo, TodoRow } from "./schema";

/** 行 → 领域对象（done 0/1 归一为 boolean） */
function toTodo(row: TodoRow): Todo {
  return { id: row.id, title: row.title, done: row.done === 1, createdAt: row.created_at };
}

export class TodoRepository {
  constructor(private db: Database) {}

  findAll(): Todo[] {
    const rows = this.db
      .query("SELECT id, title, done, created_at FROM todos ORDER BY id DESC")
      .all() as TodoRow[];
    return rows.map(toTodo);
  }

  findById(id: number): Todo | null {
    const row = this.db
      .query("SELECT id, title, done, created_at FROM todos WHERE id = ?")
      .get(id) as TodoRow | null;
    return row ? toTodo(row) : null;
  }

  create(input: CreateTodoInput): Todo {
    const row = this.db
      .query(
        "INSERT INTO todos (title, done, created_at) VALUES (?, 0, ?) RETURNING id, title, done, created_at",
      )
      .get(input.title, new Date().toISOString()) as TodoRow;
    return toTodo(row);
  }

  toggle(id: number): Todo | null {
    const row = this.db
      .query(
        "UPDATE todos SET done = 1 - done WHERE id = ? RETURNING id, title, done, created_at",
      )
      .get(id) as TodoRow | null;
    return row ? toTodo(row) : null;
  }

  remove(id: number): boolean {
    return this.db.query("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
  }
}
