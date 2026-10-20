import type { Database } from "bun:sqlite";
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
