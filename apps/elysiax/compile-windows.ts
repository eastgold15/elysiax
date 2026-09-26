import { codegen } from "@elysiax/core";
await codegen();
import tailwind from "bun-plugin-tailwind";

// Windows 交叉编译：WebView2 (Edge 内核) 在 Win10/11 预装，无需额外依赖
const result = await Bun.build({
  entrypoints: ["src/desktop.ts"],
  target: "bun",
  plugins: [tailwind],
  compile: {
    target: "bun-windows-x64",
    outfile: "dist/elysiax-app.exe",
    // @ts-expect-error Bun 1.4 未导出该类型，但 CLI 等价物 --windows-icon 存在
    windowsIcon: "packaging/icon.ico",
    windowsHideConsole: true,
  },
});
for (const o of result.outputs)
  console.log(o.path, (o.size / 1024 / 1024).toFixed(1), "MB");
