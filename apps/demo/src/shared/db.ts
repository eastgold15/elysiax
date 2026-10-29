import { Database } from "bun:sqlite";

/**
 * 单例连接。表不再在这里建：每个原子的 migrations.ts 自含 DDL
 * （契约 §5「不碰共享文件」——共享文件只留连接，表锚点在 schema.ts）。
 */
export const db = new Database("app.db");
