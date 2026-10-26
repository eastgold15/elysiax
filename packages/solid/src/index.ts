/// <reference path="./types.d.ts" />
/**
 * @elysiax/solid：elysiax 框架自造的 Solid 构建插件。
 *
 * 职责：把 client 原子的 .tsx（Solid JSX）经 babel-preset-solid 编译成
 * 纯 JS（template 克隆 + insert 响应式绑定），交给 Bun.build 打包成
 * 落盘产物 .elysiax/shells/<slug>.client.js。
 *
 * 设计约定（见 docs/lowering.md 逐级降级哲学）：
 * - babel 三件套是本包的内部实现细节，应用侧零配置、无感知；
 * - 将来换内核（手写 transform / Bun 原生支持 Solid）只动本包，应用零改动；
 * - core 只按包名探测本包存在与否，不认识 Solid 的任何细节。
 *
 * Babel 8 注意：preset-typescript 已删除 isTSX/allExtensions，
 * JSX 解析必须显式挂 @babel/plugin-syntax-jsx。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import syntaxJsx from "@babel/plugin-syntax-jsx";
import solidPreset from "babel-preset-solid";

/**
 * 浏览器条件解析：Bun.resolveSync 在 CLI 进程里走 node 条件，会命中
 * solid-js exports 的 node 分支（dist/server.js）——浏览器里跑 server build
 * 正是 onMount/ref 错乱的那类怪错。这里按 exports 手工挑 browser 分支。
 */
function solidBrowserEntry(spec: string, pkgDir: string, exportsMap: Record<string, unknown>, dev: boolean): string {
  const sub = spec === "solid-js" ? "." : `.${spec.slice("solid-js".length)}`;
  let node: unknown = exportsMap[sub];
  // 条件对象逐层收窄：browser → (dev ? development) → import
  for (const key of ["browser", ...(dev ? ["development"] : []), "import", "default"]) {
    if (node && typeof node === "object" && key in node) node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== "string") throw new Error(`solid-js 出口 ${sub} 无 browser 分支可用`);
  return join(pkgDir, node);
}

export function solidPlugin(options?: { filter?: RegExp; resolveFrom?: string; dev?: boolean }): Bun.BunPlugin {
  return {
    name: "elysiax-solid",
    setup(build) {
      // peer 去重：link: 引入的包（如 @elysiax/flow）若自己 node_modules 里有 solid-js
      // 副本（bun 默认自动安装 peerDependencies），bun 的向上解析会命中它——
      // 产物里混进两个 Solid 实例，ref/onMount 跨实例调度直接错乱。
      // peer 语义本就是「宿主提供」：把 solid-js 及其子路径一律重定向到应用根的实体。
      if (options?.resolveFrom) {
        const pkgPath = Bun.resolveSync("solid-js/package.json", options.resolveFrom);
        const pkgDir = dirname(pkgPath);
        const exportsMap = (JSON.parse(readFileSync(pkgPath, "utf8")) as { exports: Record<string, unknown> }).exports;
        const dev = options.dev ?? true;
        // 星号键（./dist/* 等直通出口）的匹配表：键前缀 → 目标模板
        const starKeys = Object.keys(exportsMap).filter((k) => k.includes("*"));
        build.onResolve({ filter: /^solid-js(\/.*)?$/ }, (args) => {
          const sub = args.path === "solid-js" ? "." : `.${args.path.slice("solid-js".length)}`;
          const direct = exportsMap[sub];
          // 精确命中且是无条件字符串映射：直接落路径
          if (typeof direct === "string") return { path: join(pkgDir, direct) };
          // 精确命中条件对象：走 browser 分支
          if (direct) return { path: solidBrowserEntry(args.path, pkgDir, exportsMap, dev) };
          // 星号键：星号 = 子路径去掉键前缀后的剩余段，回填进目标模板
          const star = starKeys.find((k) => sub.startsWith(k.slice(0, k.indexOf("*"))));
          if (star) {
            const rest = sub.slice(star.indexOf("*"));
            const target = exportsMap[star];
            if (typeof target === "string") return { path: join(pkgDir, target.replaceAll("*", rest)) };
          }
          throw new Error(`solid-js 出口 ${sub} 无法解析`);
        });
      }
      build.onLoad({ filter: options?.filter ?? /\.tsx$/ }, async (args) => {
        const code = await Bun.file(args.path).text();
        const out = await transformAsync(code, {
          filename: args.path,
          presets: [
            [solidPreset as never, { generate: "dom" }],
            [tsPreset as never, {}],
          ],
          plugins: [syntaxJsx as never],
        });
        return { contents: out?.code ?? "", loader: "js" };
      });
    },
  };
}
