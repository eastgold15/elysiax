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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 *
 * peer 去重：link: 引入的框架包（@elysiax/flow 等）若自己有 node_modules/solid-js
 * 副本，测试进程会混进两个 Solid 实例——`onMount` 与 ref 的调度器分属不同实例，
 * 表现为「render 时 pane 还是 undefined」这类跨实例错乱。默认以 cwd（应用根）为
 * 解析基准，把三份 solid-js 钉到应用根的那一份——目标是「测试进程内单实例」，
 * 不是和浏览器构建产物逐字节一致（require 命中的是 CJS，浏览器构建走 ESM）。
 */
export function setupClientTest(opts?: { filter?: RegExp; resolveFrom?: string }): void {
  // 应用根的解析基准：构建插件与测试去重必须用同一个（显式 resolveFrom 优先）
  const base = opts?.resolveFrom ?? process.cwd();
  // happy-dom 是应用的 devDependency：必须从应用根解析，
  // 从本包位置 require 在 isolated node_modules 布局下找不到它
  const appRequire = createRequire(resolve(base, "package.json"));
  // 结构化类型：registrator 是应用的 devDependency，本包不 import 它的类型
  const { GlobalRegistrator } = appRequire("@happy-dom/global-registrator") as {
    GlobalRegistrator: { register(): Promise<void> | void };
  };
  GlobalRegistrator.register();
  // 测试进程里命中的 .tsx 都按 Solid 编译：client 测试只引浏览器侧代码
  // （doctor 岛边界本来就禁 client 引服务端），框架包（@elysiax/flow 的 .tsx 源）
  // 也要过同一个转换，不能只放行应用 client/ 目录而漏掉 flow。
  //
  // runtime peer 去重（比 Bun.build 侧更关键）：Bun.plugin 的 onResolve 在
  // `bun test` 运行时不生效（实测不触发），link: 引入的 @elysiax/flow 会从自己的
  // node_modules 拿到另一份 solid-js——两份实例的响应式图互不相通，表现为
  // 「外部 props 变化后 flow 内部 DOM 纹丝不动」，比报错更隐蔽。
  //
  // 用 bun:test 的 mock.module 把 babel-preset-solid 实际会产出的三个说明符
  // （solid-js / web / store）钉到应用根副本。注意 require 命中的是 solid-js 的
  // CJS 产物而非构建插件选的 ESM 入口——目标是「进程内单实例」，不是同一构建产物。
  //
  // 失败要吵：只有「不是 bun test 环境」才静默跳过；应用没直接声明 solid-js
  // （只有传递依赖）时解析会抛——那正说明去重没法生效，必须让人看见，否则又回到
  // 「测试静默通过、DOM 其实不更新」的坑里。
  const bunTest = tryRequire<{ mock: { module(spec: string, factory: () => unknown): void } }>(appRequire, "bun:test");
  if (bunTest) {
    // 先全部解析成功再统一注册：避免解析中途失败留下「半去重」状态
    //
    // **两个包都要 mock**（整包，不 mock 子路径）：
    //
    // 1) 去重：link: 引入的框架包（如 @elysiax/flow）会从**自己的** node_modules
    //    解析 solid-js / @solidjs/web（bun 自动安装 peerDependencies），于是进程里
    //    有两份 Solid 运行时。被导入的那份调用 delegateEvents 写进它自己的实例，
    //    而测试的 render 来自另一份 → 委托集合不共享 → **所有委托事件静默失效**
    //    （元素上 handler 属性在，监听器没挂，表现是「渲染出来了但点不动」）。
    //    solidPlugin 的 onResolve 能解决这件事，但**在 bun test 里不生效**（实测），
    //    所以测试进程只能靠 mock 把两个 specifier 都钉到应用根的同一份。
    //
    // 2) browser 分支：Solid 2 没有 CJS 产物，require 的条件解析会落到
    //    node 分支 = dist/server.js（SSR 构建）——那里的 template() 等会抛
    //    "Client-only API called on the server side"。测试跑的是浏览器语义，
    //    所以按 exports 表手工挑 browser 条目（同 solidPlugin 的 solidBrowserEntry）。
    //
    // 只 mock **整包**（"solid-js" / "@solidjs/web"）；mock 子路径（如
    // "@solidjs/web/jsx-runtime"）会让 Bun 把整个包判为 mocked，编译产物要的
    // template/insert 等导出全部消失。
    const specs = ["solid-js", "@solidjs/web"];
    for (const spec of specs) {
      const mod = browserRequire(spec, base, appRequire);
      if (mod) bunTest.mock.module(spec, () => mod);
    }

    // **测试入口文件不能写 JSX**（Solid 2 的硬约束）：
    // Bun 的 onLoad 插件对测试入口不生效（实测），入口里的 JSX 会走 Bun 内置的
    // 自动 runtime → 解析 @solidjs/web/jsx-runtime——而 Solid 2 的该导出只带类型
    // （运行时无 jsx 实现），于是报 "Export named 'jsx' not found"。
    //
    // 也不能用 mock 兜底：mock.module("@solidjs/web/jsx-runtime", …) 会让 Bun 把
    // 整个 @solidjs/web 包判为 mocked，编译产物要的 template/insert 等导出全部消失
    // （报 "Export named 'template' not found"）。
    //
    // 正解：需要 JSX 就放进**被导入的** .tsx（它会被 onLoad 编译），测试入口只写
    // 纯 TS 调用。
  }
  Bun.plugin(
    solidPlugin({
      ...(opts?.filter ? { filter: opts.filter } : {}),
      resolveFrom: base,
    }),
  );
}

/** 只在「该模块本就不存在」时返回 null；其它错误原样抛出 */
function tryRequire<T>(req: NodeRequire, spec: string): T | null {
  try {
    return req(spec) as T;
  } catch (e) {
    if ((e as { code?: string }).code === "MODULE_NOT_FOUND") return null;
    throw e;
  }
}

/**
 * 取包在 **browser 条件**下的入口并 require 它。
 *
 * 为什么不能直接 require(pkg)：Solid 2 只发 ESM 产物（没有 .cjs），require 的条件
 * 解析落到 node 分支 = dist/server.js——SSR 构建，浏览器专用的 API（template /
 * delegateEvents 等）会抛 "Client-only API called on the server side"。
 * 测试跑的是浏览器语义，所以按 exports 表手工挑 browser 条目。
 *
 * 取不到 browser 分支时回退到普通 require（Solid 1.x 有 CJS 产物时走那条）。
 */
function browserRequire(
  spec: string,
  base: string,
  appRequire: NodeRequire,
): unknown {
  try {
    const pkgName = spec.startsWith("@")
      ? spec.slice(0, spec.indexOf("/", 1))
      : spec.slice(0, spec.indexOf("/") > 0 ? spec.indexOf("/") : spec.length);
    const sub = spec === pkgName ? "." : `.${spec.slice(pkgName.length)}`;
    const pkgPath = Bun.resolveSync(`${pkgName}/package.json`, base);
    const pkgDir = dirname(pkgPath);
    const exportsMap = (
      JSON.parse(readFileSync(pkgPath, "utf8")) as { exports: Record<string, unknown> }
    ).exports;
    const entry = exportsMap[sub];
    if (!entry) return tryRequire<unknown>(appRequire, spec);
    // 条件对象逐层收窄：browser → development → import → default
    let node: unknown = entry;
    for (const key of ["browser", "development", "import", "default"]) {
      if (node && typeof node === "object" && key in node)
        node = (node as Record<string, unknown>)[key];
    }
    if (typeof node !== "string") return tryRequire<unknown>(appRequire, spec);
    return appRequire(join(pkgDir, node));
  } catch {
    return tryRequire<unknown>(appRequire, spec);
  }
}
