/// <reference path="./types.d.ts" />
/**
 * @elysiax/solid：elysiax 框架自造的 Solid 构建插件。
 *
 * 职责：把 client 原子的 .tsx（Solid JSX）编译成纯 JS（template 克隆 + insert 响应式绑定），
 * 交给 Bun.build 打包成落盘产物 .elysiax/shells/<slug>.client.js。
 * 编译分两步：babel 剥 TS 类型（保留 JSX）→ @solidjs/compiler 编 JSX。
 *
 * 设计约定（见 docs/lowering.md 逐级降级哲学）：
 * - 编译器是本包的内部实现细节，应用侧零配置、无感知；
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
import { transform } from "@solidjs/compiler";

/**
 * 浏览器条件解析：Bun.resolveSync 在 CLI 进程里走 node 条件，会命中
 * solid-js exports 的 node 分支（dist/server.js）——浏览器里跑 server build
 * 正是 onMount/ref 错乱的那类怪错。这里按 exports 手工挑 browser 分支。
 *
 * Solid 2 把渲染器拆成了独立包（solid-js 只剩渲染器无关的核心原语，
 * DOM 运行时在 @solidjs/web），所以「包名」不再固定。
 */
function solidBrowserEntry(
  pkgName: string,
  spec: string,
  pkgDir: string,
  exportsMap: Record<string, unknown>,
  dev: boolean,
): string {
  const sub = spec === pkgName ? "." : `.${spec.slice(pkgName.length)}`;
  let node: unknown = exportsMap[sub];
  // 条件对象逐层收窄：browser → (dev ? development) → import
  for (const key of ["browser", ...(dev ? ["development"] : []), "import", "default"]) {
    if (node && typeof node === "object" && key in node) node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== "string") throw new Error(`${pkgName} 出口 ${sub} 无 browser 分支可用`);
  return join(pkgDir, node);
}

/**
 * 需要做 peer 去重的包。
 *
 * Solid 1.x：只有 solid-js（含 /web /store 子路径）。
 * Solid 2.x：核心在 solid-js，DOM 运行时在 @solidjs/web（另开一个包）。
 * 两者都要钉到应用根的同一份，否则产物里混进两个 Solid 实例。
 */
const SOLID_PKGS = ["solid-js", "@solidjs/web"] as const;

export function solidPlugin(options?: { filter?: RegExp; resolveFrom?: string; dev?: boolean }): Bun.BunPlugin {
  return {
    name: "elysiax-solid",
    setup(build) {
      // peer 去重：link: 引入的包（如 @elysiax/flow）若自己 node_modules 里有 solid-js
      // 副本（bun 默认自动安装 peerDependencies），bun 的向上解析会命中它——
      // 产物里混进两个 Solid 实例，ref/onMount 跨实例调度直接错乱。
      // peer 语义本就是「宿主提供」：把 solid-js 及其子路径一律重定向到应用根的实体。
      if (options?.resolveFrom) {
        const dev = options.dev ?? true;
        for (const pkgName of SOLID_PKGS) {
          // 应用可能只装了其中一个（纯 SSR 项目不需要 @solidjs/web）——装了就钉，没装跳过
          let pkgPath: string;
          try {
            pkgPath = Bun.resolveSync(`${pkgName}/package.json`, options.resolveFrom);
          } catch {
            continue;
          }
          const pkgDir = dirname(pkgPath);
          const exportsMap = (JSON.parse(readFileSync(pkgPath, "utf8")) as { exports: Record<string, unknown> }).exports;
          // 星号键（./dist/* 等直通出口）的匹配表：键前缀 → 目标模板
          const starKeys = Object.keys(exportsMap).filter((k) => k.includes("*"));
          const escaped = pkgName.replace(/[/@]/g, (c) => `\\${c}`);
          build.onResolve({ filter: new RegExp(`^${escaped}(\\/.*)?$`) }, (args) => {
            const sub = args.path === pkgName ? "." : `.${args.path.slice(pkgName.length)}`;
            // package.json 不是运行时出口：包的 exports 表里未必登记（Solid 2 的
            // @solidjs/web 就没登记），但 Bun 解析包时要读它来拿 exports 表——
            // 走到下面的 exports 分支会抛「出口无法解析」，把整个包解析带崩。
            // 直接落盘放行。
            if (sub === "./package.json") return { path: join(pkgDir, "package.json") };
            const direct = exportsMap[sub];
            // 精确命中且是无条件字符串映射：直接落路径
            if (typeof direct === "string") return { path: join(pkgDir, direct) };
            // 精确命中条件对象：走 browser 分支
            if (direct) return { path: solidBrowserEntry(pkgName, args.path, pkgDir, exportsMap, dev) };
            // 星号键：星号 = 子路径去掉键前缀后的剩余段，回填进目标模板
            const star = starKeys.find((k) => sub.startsWith(k.slice(0, k.indexOf("*"))));
            if (star) {
              const rest = sub.slice(star.indexOf("*"));
              const target = exportsMap[star];
              if (typeof target === "string") return { path: join(pkgDir, target.replaceAll("*", rest)) };
            }
            throw new Error(`${pkgName} 出口 ${sub} 无法解析`);
          });
        }
      }
      build.onLoad({ filter: options?.filter ?? /\.tsx$/ }, async (args) => {
        const code = await Bun.file(args.path).text();
        // 两步：
        // 1) babel 只剥 TS 类型，**保留 JSX**（preset-typescript + syntax-jsx）；
        // 2) @solidjs/compiler 把 JSX 编成 DOM 产物（template 克隆 + insert 绑定）。
        //
        // 为什么不用 babel-preset-solid：它的 2.x 停在 2.0.0-rc.2，产出的事件属性前缀是
        // "$$pointerdown"，而 @solidjs/web 的 stable（2.0.x）运行时查的是 "_$$pointerdown"
        //（EVENT_KEY = "_$$"）——对不上，**所有委托事件静默失效**（不抛错，最难查）。
        // Solid 2 的官方编译器已是 Rust 版 @solidjs/compiler（@solidjs/vite-plugin 用它），
        // 它与 @solidjs/web@2.0.x 配套。
        const stripped = await transformAsync(code, {
          filename: args.path,
          presets: [[tsPreset as never, {}]],
          plugins: [syntaxJsx as never],
        });
        const jsx = stripped?.code ?? "";
        const out = transform(jsx, {
          filename: args.path,
          generate: "dom",
          dev: options?.dev ?? true,
        });
        return { contents: out.code, loader: "js" };
      });
    },
  };
}
