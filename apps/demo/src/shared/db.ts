import { Database } from "bun:sqlite";

/**
 * 单例连接。表不再在这里建：每个原子的 migrations.ts 自含 DDL
 * （契约 §5「不碰共享文件」——共享文件只留连接，表锚点在 schema.ts）。
 *
 * 为什么 migrations.ts 直接 import 本单例、而不注入 DI 的 db：
 * demo 刻意展示最小形态——迁移在「模块加载即建表」的时机跑，此时 DI 容器还没建；
 * 真要接 DI，迁移就得改成由启动方统一调度（生产项目即如此）。DI 里的 db 就是本
 * 单例的值注入（infra.di.ts），不是第二条连接，所以两种写法落到库上完全等价。
 */
export const db = new Database("app.db");
