import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MigrationsJournal } from "drizzle-orm/migrator";
import { appPaths, ensureDirs } from "./paths";
// 各原子自带迁移片段——复制原子文件夹即带走建表 SQL。
// 显式 import 聚合（原子就这几个，一行一个，比扫描透明）；
// 顺序即同 timestamp 时的执行次序：被引用方（servers/projects）在前，引用方（canvas/deploy/edge）在后。
import { migrations as serversMigrations } from "../pages/servers/migrations";
import { migrations as projectsMigrations } from "../pages/projects/migrations";
import { migrations as canvasMigrations } from "../pages/canvas/migrations";
import { migrations as resourcesMigrations } from "../pages/resources/migrations";
import { migrations as deployMigrations } from "../pages/deploy/migrations";
import { migrations as edgeMigrations } from "../pages/edge/migrations";

ensureDirs();

const sqlite = new Database(appPaths.dbFile);
sqlite.run("PRAGMA journal_mode = WAL;");
sqlite.run("PRAGMA foreign_keys = ON;");

// 迁移日志以纯 TS 内嵌（bun --compile 后没有文件系统里的 migrationsFolder）。
// 各片段的 timestamp 是全局历史序；聚合后重排为连续序号，保证同 timestamp 条目按上方 import 次序执行。
// 变更表结构后跑 `bunx drizzle-kit generate`（读 schema.all.ts），把 SQL 追加到对应原子的 migrations.ts。
const migrationsJournal: MigrationsJournal = [
  ...serversMigrations,
  ...projectsMigrations,
  ...canvasMigrations,
  ...resourcesMigrations,
  ...deployMigrations,
  ...edgeMigrations,
]
  .sort((a, b) => a.timestamp - b.timestamp)
  .map((m, i) => ({ ...m, timestamp: i + 1 }));

export const db = drizzle({ client: sqlite });

// 启动即迁移（同步，桌面工具免交互）
migrate(db, migrationsJournal);

export type Db = typeof db;
