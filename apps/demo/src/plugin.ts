import { plugin } from "bun";

try {
  const { moduleAggregator } = await import("@elysiax/core/plugin");
  plugin(moduleAggregator());
} catch {
  // bun build --compile 的单文件二进制：模块已在构建期内联，无需运行时聚合
}
