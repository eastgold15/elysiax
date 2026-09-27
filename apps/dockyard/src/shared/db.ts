import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { appPaths, ensureDirs } from "./paths";
import { migrationsJournal } from "./migrations";

ensureDirs();

const sqlite = new Database(appPaths.dbFile);
sqlite.run("PRAGMA journal_mode = WAL;");
sqlite.run("PRAGMA foreign_keys = ON;");

// 注意：drizzle rc 的 sqlite config 不再接受 schema（无 db.query），
// 统一用 db.select()/insert()/update()/delete() 核心 API
export const db = drizzle({ client: sqlite });

// 启动即迁移（同步，桌面工具免交互）
migrate(db, migrationsJournal);

export type Db = typeof db;
