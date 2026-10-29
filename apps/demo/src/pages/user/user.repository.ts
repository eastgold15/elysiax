import type { Database } from "bun:sqlite";
// 副作用 import：保证首次访问数据前本原子的迁移已执行（表锚点在 user/schema.ts）
import "./migrations";
import type { User, CreateUserInput } from "./user.model";

export class UserRepository {
  constructor(private db: Database) {}

  findAll(): User[] {
    return this.db.query("SELECT id, name FROM users").all() as User[];
  }

  create(input: CreateUserInput): User {
    return this.db
      .query("INSERT INTO users (name) VALUES (?) RETURNING id, name")
      .get(input.name) as User;
  }
}
