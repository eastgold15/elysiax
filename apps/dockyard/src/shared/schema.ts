import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// ── 服务器：SSH 连接信息 + docker 状态 ──
export const servers = sqliteTable("servers", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  host: text().notNull(),
  port: integer().notNull().default(22),
  user: text().notNull(),
  // key = 私钥文件 | password | agent
  authType: text({ enum: ["key", "password", "agent"] }).notNull().default("key"),
  keyPath: text(), // authType=key 时的私钥路径
  password: text(), // authType=password 时（enc1: 加密）
  // unknown | ok | missing
  dockerStatus: text({ enum: ["unknown", "ok", "missing"] }).notNull().default("unknown"),
  dockerVersion: text(),
  // TOFU：首次连接确认后存储的主机密钥指纹
  hostKeyFingerprint: text(),
  // 机器指纹：防止同一台物理机被添加两次 / IP 漂移误部署
  machineId: text(), // /etc/machine-id
  dockerId: text(), // docker info 的 Server ID
  lastCheckedAt: integer({ mode: "timestamp" }),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ── 项目空间 ──
export const projects = sqliteTable("projects", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  slug: text().notNull().unique(),
  // 项目 = 仓库：绑定的 GitHub 仓库（可空——允许纯数据库编排的项目空间）
  repoUrl: text(),
  // 本地仓库路径（扫描发现/点击落库）；与 repoUrl 可并存——本地目录的 origin 就是那个仓库
  localPath: text(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

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

// ── 部署目标：一张卡片上部署的 app 或数据库 ──
export const deployTargets = sqliteTable("deploy_targets", {
  id: integer().primaryKey({ autoIncrement: true }),
  nodeId: integer().notNull().references(() => canvasNodes.id, { onDelete: "cascade" }),
  kind: text({ enum: ["app", "db"] }).notNull(),
  name: text().notNull(),
  // db 两层模型：null = 独立实例（或 app）；非 null = 逻辑库，指向宿主实例 target
  instanceOf: integer().references((): AnySQLiteColumn => deployTargets.id),
  // 远端容器名（部署时定死 dockyard-<id>-<name>，对账用）
  containerName: text(),
  // app：GitHub 仓库
  repoUrl: text(),
  branch: text().default("main"),
  composePath: text().default("docker-compose.yml"),
  serviceName: text(),
  // db：官方镜像模板
  dbType: text({ enum: ["postgres", "mysql", "redis", "mongo"] }),
  // 远端部署目录
  remoteDir: text(),
  // 资源限制 override compose（识别出的 cpus/mem_limit，部署时 -f 叠加；无秘密故明文）
  overrideCompose: text(),
  // 环境变量（敏感值 enc1: 加密）
  envJson: text(),
  // app 依赖的 db target id 列表（画布连线 + 连接串引用的血缘；不做外键，删 db 仅断线）
  dependsOn: text({ mode: "json" }).$type<number[]>(),
  // compose 服务清单（创建时从 DetectedService 落库，存量惰性补全；无秘密值，明文 JSON）
  servicesJson: text({ mode: "json" }).$type<TargetServicesDoc>(),
  // 画布布局：本卡在服务器卡内的位置（null → 岛端自动错位摆放）
  x: integer(),
  y: integer(),
  // 手动拉伸的卡尺寸（null → 按子卡 bounds 自动收敛；有值时作下限，不会被自动收敛压小）
  w: integer(),
  h: integer(),
  // 服务卡位置（key = compose 服务名）
  serviceLayout: text({ mode: "json" }).$type<Record<string, { x: number; y: number }>>(),
  // 服务级依赖边（画布真相；dependsOn 是其派生的血缘，双写保持一致）
  depEdges: text({ mode: "json" }).$type<DepEdge[]>(),
  // 更新轮询状态
  lastKnownSha: text(),
  etag: text(),
  updateAvailable: integer({ mode: "boolean" }).notNull().default(false),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  // 防误操作：同一卡片上同类型同名目标唯一（重复建库在表单层就拦住）
  unique().on(t.nodeId, t.kind, t.name),
]);

// ── 部署历史 ──
export const deployments = sqliteTable("deployments", {
  id: integer().primaryKey({ autoIncrement: true }),
  targetId: integer().notNull().references(() => deployTargets.id, { onDelete: "cascade" }),
  status: text({
    enum: ["queued", "building", "transferring", "deploying", "success", "failed"],
  }).notNull().default("queued"),
  commitSha: text(),
  logText: text().notNull().default(""),
  startedAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  finishedAt: integer({ mode: "timestamp" }),
});

// ── 域名绑定：app target 的自定义域名（edge 反代 + 自动证书的状态机）──
export const domains = sqliteTable("domains", {
  id: integer().primaryKey({ autoIncrement: true }),
  targetId: integer().notNull().references(() => deployTargets.id, { onDelete: "cascade" }),
  hostname: text().notNull(),
  // 反代目标：compose 服务名 + 端口（多服务 app 靠它区分 api/admin/www）
  serviceName: text(),
  targetPort: integer().notNull(),
  // DNS 解析状态：unknown | ok（指向本机） | mismatch（解析到别处）
  dnsStatus: text({ enum: ["unknown", "ok", "mismatch"] }).notNull().default("unknown"),
  // 证书状态：none | pending（签发中） | active | error
  sslStatus: text({ enum: ["none", "pending", "active", "error"] }).notNull().default("none"),
  sslError: text(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  // 同一 target 下域名唯一；跨 target 重复在 service 层拦（抢别人的域名是大事故）
  unique().on(t.targetId, t.hostname),
]);

/** compose 单个服务（画布小卡片行）。env/秘密值不进这里——走 envJson/overrideCompose 加密通道 */
export interface TargetService {
  name: string;
  port?: number;  // 对外发布端口（compose config 的 ports[0].published）
  image?: string; // 惰性补全从 compose config 取；创建路径没有则缺省
}
/** servicesJson 列的文档结构：project = compose 项目名（容器标签对账用，规则同部署端 cfg.name ?? dockyard-<id>） */
export interface TargetServicesDoc {
  project?: string;
  services: TargetService[];
}
/** 服务级依赖边：service=null 表示 app 整体依赖（旧 dependsOn 数据的等价形态） */
export interface DepEdge {
  service: string | null;
  db: number; // db target id
}

export type Server = typeof servers.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type CanvasNode = typeof canvasNodes.$inferSelect;
export type DeployTarget = typeof deployTargets.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Domain = typeof domains.$inferSelect;
