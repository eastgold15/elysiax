import { defineConfig } from "drizzle-kit";

// 开发辅助：drizzle-kit generate 输出 SQL 到 drizzle/，用于与
// src/shared/migrations.ts 的内嵌日志做 diff（运行时以 TS 内嵌为准）
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/shared/schema.ts",
  out: "./drizzle",
});
