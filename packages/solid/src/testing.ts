/**
 * client 原子测试约定：bun test + happy-dom + Solid JSX 预编译。
 *
 * 为什么不能直接跑：Solid JSX 不是 React JSX——自动运行时（jsxImportSource）
 * 会去找 solid-js/jsx-runtime 的 jsx() 导出，而它不存在（Solid 的 JSX 必须经
 * babel-preset-solid 编译成 template 克隆 + insert 绑定）。所以测试进程也要
 * 挂同一个 babel 转换（就是构建用的 solidPlugin）。另外 solid-js/web 默认
 * 解析到 server build（抛 Client-only API），测试命令须带 --conditions=browser：
 * `"test": "bun test --conditions=browser"`。
 *
 * 约定用法（bunfig.toml）：
 *
 * ```toml
 * [test]
 * preload = ["./test/preload.ts"]
 * ```
 *
 * ```ts
 * // test/preload.ts
 * import { setupClientTest } from "@elysiax/solid/testing";
 * setupClientTest();
 * ```
 *
 * 之后测试文件正常写（无需 pragma——JSX 由插件编译，不走 Bun 的 jsx 设置）：
 *
 * ```ts
 * import { render } from "solid-js/web";
 * import { test, expect } from "bun:test";
 *
 * test("徽章渲染文本", () => {
 *   const el = document.createElement("div");
 *   render(() => <Badge tone="ok">运行中</Badge>, el);
 *   expect(el.textContent).toContain("运行中");
 * });
 * ```
 *
 * happy-dom 是消费方（应用）的 devDependency——框架不替应用决定版本；
 * 应用 `bun add -d @happy-dom/global-registrator` 后即可用本助手。
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { solidPlugin } from "./index";

/**
 * 一行装配 client 测试环境：
 * 1. happy-dom 注册全局 DOM（document/window/PointerEvent…）；
 * 2. Bun.plugin 挂 Solid JSX 预编译。
 *
 * filter 陷阱：插件按路径拦截 .tsx——monorepo 里还有 @kitajs/html 语义的 .tsx
 * （如 @elysiax/htmx 的 toast.tsx），一旦被 Solid 编译会注入 solid-js/web 依赖
 * 而解析失败。默认放行全部 .tsx 只适合纯 Solid 应用；混用 htmx 的应用必须传
 * filter 收窄到「应用 client/ 目录 + @elysiax/flow 包」，例如：
 * `setupClientTest({ filter: /(apps\/myapp\/.*\/client|packages\/flow\/src).*\.tsx$/ })`
 */
export function setupClientTest(opts?: { filter?: RegExp }): void {
  // happy-dom 是应用的 devDependency：必须从应用根（cwd）解析，
  // 从本包位置 require 在 isolated node_modules 布局下找不到它
  const appRequire = createRequire(resolve(process.cwd(), "package.json"));
  // 结构化类型：registrator 是应用的 devDependency，本包不 import 它的类型
  const { GlobalRegistrator } = appRequire("@happy-dom/global-registrator") as {
    GlobalRegistrator: { register(): Promise<void> | void };
  };
  GlobalRegistrator.register();
  // 测试进程里命中的 .tsx 都按 Solid 编译：client 测试只引浏览器侧代码
  // （doctor 岛边界本来就禁 client 引服务端），框架包（@elysiax/flow 的 .tsx 源）
  // 也要过同一个转换，不能只放行应用 client/ 目录而漏掉 flow。
  Bun.plugin(solidPlugin(opts?.filter ? { filter: opts.filter } : undefined));
}
