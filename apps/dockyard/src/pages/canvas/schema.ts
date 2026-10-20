import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";
// 插头：外键经插座引用（di 已声明依赖 servers/projects）
import { servers } from "../servers/servers.socket";
import { projects } from "../projects/projects.socket";

// ── 画布节点：项目画布上的一张服务器卡片 ──
export const canvasNodes = sqliteTable("canvas_nodes", {
  id: integer().primaryKey({ autoIncrement: true }),
  projectId: integer().notNull().references(() => projects.id, { onDelete: "cascade" }),
  serverId: integer().notNull().references(() => servers.id, { onDelete: "cascade" }),
  x: integer().notNull().default(40),
  y: integer().notNull().default(40),
  w: integer().notNull().default(320),
  h: integer().notNull().default(240),
});

// ── 服务分组：画布上的命名分组容器，归属某张服务器卡 ──
export const serviceGroups = sqliteTable("service_groups", {
  id: integer().primaryKey({ autoIncrement: true }),
  nodeId: integer().notNull().references(() => canvasNodes.id, { onDelete: "cascade" }),
  name: text().notNull(),
  x: integer().notNull().default(24),
  y: integer().notNull().default(24),
  w: integer().notNull().default(360),
  h: integer().notNull().default(280),
}, (t) => [
  unique().on(t.nodeId, t.name),
]);

export type CanvasNode = typeof canvasNodes.$inferSelect;
export type ServiceGroup = typeof serviceGroups.$inferSelect;
