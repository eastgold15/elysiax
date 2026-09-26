import tailwind from "bun-plugin-tailwind";
import { moduleAggregator } from "@elysiax/core";

// 桌面应用：入口 desktop.ts（spawn 自身 --server 起服务 + webview 窗口）
const result = await Bun.build({
  entrypoints: ["src/desktop.ts"],
  target: "bun",
  plugins: [tailwind, moduleAggregator()],
  compile: { outfile: "dist/elysiax-app" },
});
for (const o of result.outputs)
  console.log(o.path, (o.size / 1024 / 1024).toFixed(1), "MB");
