import { Database } from "bun:sqlite";

export const db = new Database("app.db");

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// 种子数据（仅首次）
if ((db.query("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c === 0) {
  db.run("INSERT INTO users (name) VALUES ('Alice'), ('Bob')");
  db.run("INSERT INTO orders (user_id, amount) VALUES (1, 99.5), (1, 12.0), (2, 42.0)");
}
