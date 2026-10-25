#!/usr/bin/env bun
import { createCerebro } from "@visulima/cerebro";
import { errorHandlerPlugin } from "@visulima/cerebro/plugins/error-handler";
import { existsSync, cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** 剥离 // 行注释与 块注释（正则级实现，骨架/插座场景足够；
 *  带 [^:] 前缀兜底避免误伤字符串里的 "https://…"） */
function stripComments(src: string): string {
  return src
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** 按顶层逗号切分声明列表（忽略括号/方括号/花括号内部的逗号） */
function splitDeclarators(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * 解析 socket 文件的导出符号表（named/type re-export + 本地声明）。
 * 先剥注释再匹配，避免注释里的示例 export 被计为真实出口；
 * resolveFile 用于递归解析 export * from "./x"（限深防环，HEAD 对比时不传）。
 */
function socketExports(
  src: string,
  resolveFile?: (spec: string) => string | undefined,
  depth = 0,
): Set<string> {
  const names = new Set<string>();
  const code = stripComments(src);
  // export { A, B as C } / export type { ... }（可多行）
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gs))
    for (const part of m[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const asM = /\bas\s+(\w+)$/.exec(p);
      names.add(asM ? asM[1]! : p);
    }
  // export class/function/interface/type/enum X
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:class|function|interface|type|enum)\s+(\w+)/gm))
    names.add(m[1]!);
  // export const/let/var 支持多声明：export const a = 1, b = 2
  for (const m of code.matchAll(/^export\s+(?:const|let|var)\s+([^;\n]+)/gm))
    for (const decl of splitDeclarators(m[1]!)) {
      const id = /^\s*(\w+)/.exec(decl);
      if (id) names.add(id[1]!);
    }
  // export * from "./x"：递归收集目标文件出口
  if (resolveFile && depth < 3)
    for (const m of code.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
      const target = resolveFile(m[1]!);
      if (target)
        for (const n of socketExports(readFileSync(target, "utf8"), resolveFile, depth + 1))
          names.add(n);
    }
  return names;
}

const templateDir = fileURLToPath(new URL("../template", import.meta.url));

/** @gen 别名预检：骨架代码 import "@gen"，目标项目 tsconfig paths 必须配了该别名 */
function assertGenAlias(root: string) {
  const tsconfigPath = resolve(root, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return; // 无 tsconfig 不拦（非 TS 项目）
  // tsconfig 允许注释与尾逗号（JSONC），先剥掉再 parse
  const tsconfig = JSON.parse(
    stripComments(readFileSync(tsconfigPath, "utf8")).replaceAll(/,(\s*[}\]])/g, "$1"),
  ) as { compilerOptions?: { paths?: Record<string, unknown> } };
  const paths = tsconfig.compilerOptions?.paths ?? {};
  if (!("@gen" in paths))
    throw new Error(
      `目标项目 tsconfig.json 缺少 @gen paths 别名，骨架代码里的 import "@gen" 无法解析。\n` +
        `请在 compilerOptions.paths 中添加：\n` +
        `  "@gen": ["./.elysiax/index.ts"],\n` +
        `  "@gen/*": ["./.elysiax/*"]`,
    );
}

/** 生成自含迁移骨架（幂等，副作用执行；参照 apps/demo/src/pages/todo/migrations.ts 实测写法） */
function migrationsSkeleton(name: string, dir: string, root: string): string {
  const C = camel(name);
  // shared/db 单例的相对路径；目标项目没有该文件时注释掉 import 并提示调整
  const dbFile = resolve(root, "src/shared/db.ts");
  const hasDb = existsSync(dbFile);
  const spec = relative(dir, dbFile).replaceAll("\\", "/").replace(/\.ts$/, "");
  const importLine = `import { db } from "${spec.startsWith(".") ? spec : `./${spec}`}";`;
  return (
    `// ${name} 原子自含迁移（幂等）：本文件被 import 时执行，保证本原子的表存在。\n` +
    `// 执行时机：由本原子的依赖链路引入（如 ${name}.service.ts 顶部 import "./migrations"），\n` +
    `// 跟随 shared/db 单例连接启动即跑；CREATE TABLE IF NOT EXISTS 保证重复执行安全。\n` +
    (hasDb
      ? `${importLine}\n`
      : `// ${importLine}  // 未找到 src/shared/db.ts，请按项目实际的数据库单例调整\n`) +
    `\n// 建好 schema.ts 后把 DDL 放这里（或从 schema.ts import DDL 常量）：\n` +
    `// db.run(\`CREATE TABLE IF NOT EXISTS ${C}_items (id INTEGER PRIMARY KEY AUTOINCREMENT)\`);\n`
  );
}

interface ModuleManifest {
  name: string;
  version: string;
  route?: string;
  provides?: string[];
  requires?: string[];
}

function readManifest(dir: string): ModuleManifest {
  const path = resolve(dir, "module.json");
  if (!existsSync(path)) throw new Error(`未找到 module.json: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const cli = createCerebro("elysiax", {
  packageName: "@elysiax/cli",
  packageVersion: "0.1.0",
});

// 命令抛错时以非零码退出（CLI 的正确行为）；concise 让业务错误只打印消息不打印堆栈
cli.addPlugin(errorHandlerPlugin({ exitOnError: true, concise: () => true }));

// ─────────────────────────────────────────────
// elysiax init [dir] — 从模板创建新项目
// ─────────────────────────────────────────────
cli.addCommand({
  name: "init",
  description: "从模板创建一个新的 elysiax 项目",
  argument: {
    name: "dir",
    description: "目标目录（默认当前目录）",
    type: String,
  },
  execute: ({ argument, logger }) => {
    const target = resolve(process.cwd(), argument[0] ?? ".");
    const name = basename(target);

    if (existsSync(target) && readdirSync(target).length > 0) {
      throw new Error(`目录非空: ${target}`);
    }

    cpSync(templateDir, target, { recursive: true });

    // 替换项目名占位符（package.json + elysiax.config.ts）
    for (const f of ["package.json", "elysiax.config.ts"]) {
      const p = resolve(target, f);
      if (existsSync(p))
        writeFileSync(p, readFileSync(p, "utf8").replaceAll("{{name}}", name));
    }

    // workspace:/catalog: 依赖只能在 elysiax monorepo 内安装；
    // 向上找 packages/core 判定是否在 monorepo 内，不在则提示改用已发布版本号
    let inMonorepo = false;
    for (let d = target, i = 0; i < 6; i++) {
      if (existsSync(resolve(d, "packages/core/package.json"))) {
        inMonorepo = true;
        break;
      }
      const parent = resolve(d, "..");
      if (parent === d) break;
      d = parent;
    }
    if (!inMonorepo) {
      const pkg = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const wsDeps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
        .filter(([, v]) => v.startsWith("workspace:") || v === "catalog:")
        .map(([k]) => k);
      if (wsDeps.length)
        logger.warn(
          `⚠️ 目标目录不在 elysiax monorepo 内，以下依赖使用 workspace:/catalog: 协议装不上，` +
            `请改用已发布版本号: ${wsDeps.join(", ")}`,
        );
    }

    logger.info(`✅ 项目已创建: ${target}`);
    logger.info(`下一步:`);
    logger.info(`  cd ${argument[0] ?? "."}`);
    logger.info(`  bun install`);
    logger.info(`  bun run dev`);
  },
});

// ─────────────────────────────────────────────
// elysiax new module <name> / new island <module> — 脚手架
// ─────────────────────────────────────────────

const pascal = (s: string) =>
  s.replace(/(^|[-_])([a-z])/g, (_, __, c) => c.toUpperCase());
const camel = (s: string) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

async function scaffoldPage(name: string, logger: { info: (m: string) => void }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`页面名须为 kebab-case: ${name}`);

  const root = process.cwd();
  assertGenAlias(root);
  const { loadConfig, codegen } = await import("@elysiax/core");
  const config = await loadConfig(root);
  const pagesDir = config.pages ?? "src/pages";
  const dir = resolve(root, pagesDir, name);
  if (existsSync(dir)) throw new Error(`页面已存在: ${dir}`);

  // .elysiax 产物经 tsconfig paths 别名 @gen 引入，不再算相对深度
  const P = pascal(name);
  const C = camel(name);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${name}.service.ts`),
    `export class ${P}Service {
  // 依赖在构造函数里声明，${name}.di.ts 的 provide() 按顺序给类引用：
  // constructor(private readonly db: Db) {}
  // 业务错误抛 ServiceError（@elysiax/core），框架统一映射回显
}
`,
  );
  // 数据层骨架：表归原子自己所有；跨原子的外键经对方插座 import（插头）
  writeFileSync(
    resolve(dir, "schema.ts"),
    `import { sqliteTable, integer } from "drizzle-orm/sqlite-core";

// export const ${C}Items = sqliteTable("${C}_items", {
//   id: integer().primaryKey({ autoIncrement: true }),
// });
// export type ${P}Item = typeof ${C}Items.$inferSelect;
`,
  );
  // 自含迁移（幂等，副作用执行）：模块加载即保证表存在，参照 demo todo 原子实测写法
  writeFileSync(resolve(dir, "migrations.ts"), migrationsSkeleton(name, dir, root));
  // 插座：本原子对外承诺的唯一出口；跨原子 import 只允许指向这个文件
  writeFileSync(
    resolve(dir, `${name}.socket.ts`),
    `// 对外承诺集中在这里 re-export：表锚点 / 行类型 / 服务类。
// 别的原子引用本原子时只能 import 这个文件（doctor 插座门禁强制）。
export { ${P}Service } from "./${name}.service";
// export { ${C}Items, type ${P}Item } from "./schema";
`,
  );
  writeFileSync(
    resolve(dir, `${name}.di.ts`),
    `import { defineModule, provide } from "@elysiax/core";
import { ${P}Service } from "./${name}.service";

export default defineModule({
  // 注意：页面原子的 URL 由目录推导，route 仅用于旧 modules（controller）形态
  route: "/${name}",
  provides: {
    // 键 = camelCase 类名；依赖写类引用（编译期校验），懒加载用 lazy(Class)
    ${C}Service: provide(${P}Service),
  },
});
`,
  );
  writeFileSync(
    resolve(dir, `${name}.page.tsx`),
    `import { definePage } from "@elysiax/core";
import { ${P}List } from "./${name}.partials";

export default definePage(({ di }) => ({
  title: "${name}",
  content: <${P}List />,
}));
`,
  );
  writeFileSync(
    resolve(dir, `${name}.partials.tsx`),
    `import type { Component } from "@workspace/htmx";
import { defineRoutes } from "@gen";

/** 展示组件（整页与片段刷新共用） */
export const ${P}List: Component = () => (
  <div id="${C}-list">
    <h2 class="text-lg font-semibold">${P}</h2>
  </div>
);

/** GET 片段子路由：挂在 /api/${name} 前缀下（页面 URL = 文件夹路径） */
export default defineRoutes();
  // .get("/:id", ({ di, params }) => <${P}List />)
`,
  );
  writeFileSync(
    resolve(dir, `${name}.actions.tsx`),
    `import { defineRoutes } from "@gen";

/** 写端点：校验失败框架 422 回显；业务错误由 service 抛 ServiceError，不写 try/catch */
export default defineRoutes();
  // .post("/", { body: t.Object({ name: t.String() }) }, ({ di, body, toast }) => {
  //   toast("已创建");
  //   return <${P}List />;
  // })
`,
  );

  await codegen(root, config);
  logger.info(`✅ 页面已创建: ${pagesDir}/${name}/（.elysiax/ 已重新生成）`);
  logger.info(`   URL: /${name}，API 前缀: /api/${name}，服务键: ${C}Service`);
}

/**
 * 契约 §1 原子脚手架：`elysiax new module <name> --ui htmx|react [--db]`
 * 两种形态共用：service + di（含 route）+ socket（唯一对外插座）；
 * --db 追加数据层骨架（schema.ts + migrations.ts）。
 */
async function scaffoldModule(
  name: string,
  ui: "htmx" | "react",
  withDb: boolean,
  logger: { info: (m: string) => void },
) {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`模块名须为 kebab-case: ${name}`);

  const root = process.cwd();
  assertGenAlias(root);
  const { loadConfig, codegen } = await import("@elysiax/core");
  const config = await loadConfig(root);
  const pagesDir = config.pages ?? "src/pages";
  const dir = resolve(root, pagesDir, name);
  if (existsSync(dir)) throw new Error(`模块已存在: ${dir}`);

  // .elysiax 产物经 tsconfig paths 别名 @gen 引入，不再算相对深度
  const P = pascal(name);
  const C = camel(name);

  // 依赖预检：数据层需要 drizzle-orm；react 形态需要 react + react-dom + @elysia/eden。
  // 没装就直接报错提示，避免生成后类型检查挂
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (withDb && !deps["drizzle-orm"])
    throw new Error(`--db 数据层骨架需要 drizzle-orm，请先 bun add drizzle-orm`);
  if (ui === "react") {
    // 三者都是真依赖：client/index.tsx 用 react-dom，client/api.ts 用 @elysia/eden
    const missing = ["react", "react-dom", "@elysia/eden"].filter((d) => !deps[d]);
    if (missing.length)
      throw new Error(`react 形态缺少依赖: ${missing.join(", ")}，请先 bun add ${missing.join(" ")}`);
  }

  mkdirSync(dir, { recursive: true });

  // 服务类：业务错误抛 ServiceError（契约 §4）
  writeFileSync(
    resolve(dir, `${name}.service.ts`),
    `export class ${P}Service {
  // 依赖在构造函数里声明，${name}.di.ts 的 provide() 按顺序给类引用：
  // constructor(private readonly db: Db) {}
  // 业务错误抛 ServiceError（@elysiax/core），框架统一映射回显
}
`,
  );

  // 模块身份证（契约 §1.1 / §2）：default export defineModule({ route, provides })
  writeFileSync(
    resolve(dir, `${name}.di.ts`),
    `import { defineModule, provide } from "@elysiax/core";
import { ${P}Service } from "./${name}.service";

// 模块身份证：codegen 据此自动发现，无需手工注册（契约 §1.1）
export default defineModule({
  // 注意：页面原子的 URL 由目录推导，route 仅用于旧 modules（controller）形态
  route: "/${name}",
  provides: {
    // 键 = camelCase 类名；依赖写类引用（编译期校验），值服务用字符串键，
    // 跨上下文单向依赖用 lazy(Class)（InferDI 不支持双向 lazy 循环，契约 §2）
    ${C}Service: provide(${P}Service),
  },
});
`,
  );

  // 插座（契约 §3）：唯一对外出口，只含 named/type export，不含运行时逻辑
  writeFileSync(
    resolve(dir, `${name}.socket.ts`),
    `// ${name} 原子的插座：对外承诺的全部契约（契约 §3）。
// 跨原子 import 的唯一合法形式：
//   import { ${P}Service } from "../${name}/${name}.socket";
// 禁止穿透 import 原子内部文件（父子原子也走插座，doctor 插座门禁强制）。
export { ${P}Service } from "./${name}.service";
${
  ui === "react"
    ? `
// Eden Treaty 的 API 类型出口（react 形态追加）：本原子 client/api.ts 据此获得端到端类型
import type ${C}Api from "./${name}.actions";
export type ${P}Api = typeof ${C}Api;
`
    : ""
}`,
  );

  // 数据层骨架（--db，契约 §1.2）
  if (withDb) {
    writeFileSync(
      resolve(dir, "schema.ts"),
      `import { sqliteTable, integer } from "drizzle-orm/sqlite-core";

// 本原子的表锚点；跨原子的外键经对方插座 import（插头），不穿透对方 schema.ts
// export const ${C}Items = sqliteTable("${C}_items", {
//   id: integer().primaryKey({ autoIncrement: true }),
// });
// export type ${P}Item = typeof ${C}Items.$inferSelect;
`,
    );
    // 自含迁移（幂等，副作用执行）：模块加载即保证表存在，参照 demo todo 原子实测写法
    writeFileSync(resolve(dir, "migrations.ts"), migrationsSkeleton(name, dir, root));
  }

  if (ui === "htmx") {
    // ── 形态 A：htmx 模块（契约 §1.3-A，L1-L3 服务端渲染 + 局部刷新）──
    writeFileSync(
      resolve(dir, `${name}.page.tsx`),
      `import { definePage } from "@elysiax/core";
import { ${P}List } from "./${name}.partials";

export default definePage(({ di }) => ({
  title: "${name}",
  content: <${P}List />,
}));
`,
    );
    writeFileSync(
      resolve(dir, `${name}.partials.tsx`),
      `import type { Component } from "@workspace/htmx";
import { defineRoutes } from "@gen";

/** 展示组件（整页与片段刷新共用） */
export const ${P}List: Component = () => (
  <div id="${C}-list">
    <h2 class="text-lg font-semibold">${P}</h2>
  </div>
);

/** GET 片段子路由：挂在 /api/${name} 前缀下（页面 URL = 文件夹路径） */
export default defineRoutes();
  // .get("/:id", ({ di, params }) => <${P}List />)
`,
    );
    writeFileSync(
      resolve(dir, `${name}.actions.tsx`),
      `import { defineRoutes } from "@gen";

/** 写端点（返回 partial）：校验失败框架 422 回显；业务错误由 service 抛 ServiceError，
 *  预期错误 return status(code, { error })，actions 不写 try/catch（契约 §4） */
export default defineRoutes();
  // .post("/", { body: t.Object({ name: t.String() }) }, ({ di, body, toast }) => {
  //   toast("已创建");
  //   return <${P}List />;
  // })
`,
    );
  } else {
    // ── 形态 B：react 模块（契约 §1.3-B，L5 整页 client 模式）──
    // 纯 API 的 Elysia 实例：default export 供 Eden 推导类型（socket.ts 的 ${P}Api）
    writeFileSync(
      resolve(dir, `${name}.actions.ts`),
      `import { defineRoutes } from "@gen";

/** 纯 JSON API（react 形态无 .page.tsx，壳由 codegen 的 HTMLBundle 服务）。
 *  default export 是本原子的类型出口：${name}.socket.ts 用 typeof 导出给 Eden 推导。
 *  预期错误 return status(code, { error })，actions 不写 try/catch（契约 §4） */
export default defineRoutes().get("/", () => ({ name: "${name}", ok: true }));
`,
    );

    mkdirSync(resolve(dir, "client"), { recursive: true });
    writeFileSync(
      resolve(dir, "client/index.tsx"),
      `/** @jsxImportSource react */
// client 模式（L5）：/${name} 由壳 HTMLBundle 服务、不走 htmx，整页归 React。
// 铁律：client/ 依赖链禁止 Node-only 包（dotenv/bun:sqlite → 浏览器打包 500）；
// 后端数据经 client/api.ts 的 Eden Treaty 客户端访问（契约 §1.3-B）。
import { createRoot } from "react-dom/client";

function App() {
  return <div>${P} client</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    );
    writeFileSync(
      resolve(dir, "client/api.ts"),
      `/** client 的 API 层：Eden Treaty 端到端类型客户端（路径/params/body/query 全类型安全）。
 *  类型唯一来源是插座的 ${P}Api（../${name}.socket），禁止穿透 import ${name}.actions */
import { treaty } from "@elysia/eden";
import type { ${P}Api } from "../${name}.socket";

export const api = treaty<${P}Api>(\`\${location.origin}/api/${name}\`);
`,
    );
  }

  await codegen(root, config);
  logger.info(`✅ ${ui} 模块已创建: ${pagesDir}/${name}/（.elysiax/ 已重新生成）`);
  logger.info(
    ui === "htmx"
      ? `   URL: /${name}，API 前缀: /api/${name}，服务键: ${C}Service`
      : `   URL: /${name}（壳 HTMLBundle），API 前缀: /api/${name}，Eden 类型: ${P}Api`,
  );
}

/** 纯服务模块：只有 di + service，不进路由表（deploy/edge/github 形态） */
async function scaffoldService(name: string, logger: { info: (m: string) => void }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`服务名须为 kebab-case: ${name}`);

  const root = process.cwd();
  const { loadConfig, codegen } = await import("@elysiax/core");
  const config = await loadConfig(root);
  const pagesDir = config.pages ?? "src/pages";
  const dir = resolve(root, pagesDir, name);
  if (existsSync(dir)) throw new Error(`目录已存在: ${dir}`);

  const P = pascal(name);
  const C = camel(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${name}.service.ts`),
    `export class ${P}Service {}
`,
  );
  writeFileSync(
    resolve(dir, `${name}.di.ts`),
    `import { defineModule, provide } from "@elysiax/core";
import { ${P}Service } from "./${name}.service";

export default defineModule({
  provides: {
    ${C}Service: provide(${P}Service),
  },
});
`,
  );
  // 契约 §1.1：socket.ts 是原子必选文件，纯服务模块也要经插座对外承诺
  writeFileSync(
    resolve(dir, `${name}.socket.ts`),
    `// ${name} 原子的插座：对外承诺的全部契约（契约 §3）。
// 跨原子 import 只允许指向这个文件，禁止穿透 import 内部文件。
export { ${P}Service } from "./${name}.service";
`,
  );
  await codegen(root, config);
  logger.info(`✅ 纯服务模块已创建: ${pagesDir}/${name}/（无路由，仅供其他页面注入）`);
}

/** client 模式升舱：在已有页面目录下生成 client/index.tsx（L5 逃生舱） */
async function scaffoldClient(page: string, logger: { info: (m: string) => void }) {
  const root = process.cwd();
  const { loadConfig, codegen } = await import("@elysiax/core");
  const config = await loadConfig(root);
  const pagesDir = config.pages ?? "src/pages";
  const pageDir = resolve(root, pagesDir, page);
  if (!existsSync(pageDir))
    throw new Error(`页面不存在: ${pagesDir}/${page}（先 elysiax new page ${page}）`);
  const dir = resolve(pageDir, "client");
  if (existsSync(dir)) throw new Error(`client 已存在: ${dir}`);

  const P = pascal(page);
  mkdirSync(dir, { recursive: true });
  // client 需要 react / react-dom，没装就直接报错提示（避免生成后类型检查挂）
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps["react-dom"])
    throw new Error(`client 模式需要 react + react-dom，请先 bun add react react-dom`);
  writeFileSync(
    resolve(dir, "index.tsx"),
    `import { createRoot } from "react-dom/client";

// client 模式：/${page} 由 codegen 壳 HTMLBundle 服务，整页归 React。
// 铁律：依赖链不得 import Node-only 包（dotenv/bun:sqlite 等会让浏览器打包 500）；
// 后端数据走 /api/${page} 的 JSON 端点（${page}.actions.ts）。
function App() {
  return <div>${P} client</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
`,
  );
  await codegen(root, config);
  logger.info(`✅ client 模式已启用: ${pagesDir}/${page}/client/index.tsx（壳 .elysiax/shells/ 已生成）`);
}

cli.addCommand({
  name: "new",
  description:
    "脚手架：new module <name> --ui htmx|react [--db] 契约原子；new page|service|client 旧形态",
  arguments: [
    { name: "kind", description: "module | page | service | client", type: String },
    { name: "name", description: "名称（client 时为目标页面）", type: String },
  ],
  options: [
    {
      name: "ui",
      type: String,
      description: "module 的 UI 形态：htmx（默认）| react（L5 整页 client 模式）",
    },
    {
      name: "db",
      type: Boolean,
      description: "module 附带数据层骨架（schema.ts + migrations.ts，契约 §1.2）",
    },
  ],
  execute: async ({ argument, options, logger }) => {
    const [kind, name] = argument;
    if (!name) throw new Error("用法: elysiax new module|page|service|client <name>");
    if (kind === "module") {
      const ui = options.ui === "react" ? "react" : ("htmx" as const);
      return scaffoldModule(name, ui, Boolean(options.db), logger);
    }
    if (kind === "page") return scaffoldPage(name, logger);
    if (kind === "service") return scaffoldService(name, logger);
    if (kind === "client") return scaffoldClient(name, logger);
    throw new Error(`未知类型 "${kind}"：支持 module | page | service | client`);
  },
});

// ─────────────────────────────────────────────
// elysiax add <source> — 源码安装一个模块（本地路径）
// ─────────────────────────────────────────────
cli.addCommand({
  name: "add",
  description: "源码安装原子：把原子源码复制到 ./modules/<name>/（--kind page 装到 pages/）",
  argument: {
    name: "source",
    description: "原子源码目录（本地路径；含 <name>.di.ts 身份证，名字取目录名）",
    type: String,
  },
  options: [
    {
      name: "force",
      alias: "f",
      type: Boolean,
      description: "目标已存在时直接覆盖（跳过确认）",
    },
    {
      name: "kind",
      alias: "k",
      type: String,
      description: "安装目标：module（默认，src/modules/）或 page（src/pages/ 页面原子）",
    },
  ],
  execute: async ({ argument, options, logger }) => {
    const source = resolve(process.cwd(), argument[0] ?? "");
    if (!existsSync(source)) {
      throw new Error(`源码目录不存在: ${source}`);
    }

    // module.json 可选（旧约定）：原子名取清单名或目录名，装配正确性由 gen/codegen 校验
    let manifest: ModuleManifest | undefined;
    try {
      manifest = readManifest(source);
    } catch {
      manifest = undefined;
    }
    const name = manifest?.name ?? basename(source);

    const { loadConfig } = await import("@elysiax/core");
    const config = await loadConfig(process.cwd());
    const baseDir = options.kind === "page" ? (config.pages ?? "src/pages") : (config.modules ?? "src/modules");
    const target = resolve(process.cwd(), baseDir, name);

    if (source === target) {
      throw new Error(`源和目标相同: ${source}`);
    }

    if (existsSync(target) && !options.force) {
      throw new Error(
        `${baseDir}/${name} 已存在。源码安装原则：不做静默覆盖。请先手动 diff，或用 --force 覆盖。`,
      );
    }

    cpSync(source, target, { recursive: true });
    logger.info(`✅ 已安装 ${name} → ${baseDir}/${name}/`);
    if (manifest?.route) logger.info(`   路由前缀: ${manifest.route}`);
    // 装配校验（依赖是否都有提供者）交给 gen，错误会在那里集中报出
    const { codegen } = await import("@elysiax/core");
    try {
      await codegen(process.cwd());
      logger.info(`   .elysiax/ 已重新生成，依赖校验通过`);
    } catch (error) {
      logger.error(`   装配校验失败: ${(error as Error).message}`);
    }
  },
});

// ─────────────────────────────────────────────
// elysiax list — 列出已安装模块
// ─────────────────────────────────────────────
cli.addCommand({
  name: "list",
  alias: "ls",
  description: "列出 ./modules/ 下已安装的模块",
  execute: async ({ logger }) => {
    const { loadConfig } = await import("@elysiax/core");
    const modulesDir = resolve(
      process.cwd(),
      (await loadConfig(process.cwd())).modules ?? "src/modules",
    );
    if (!existsSync(modulesDir)) {
      logger.warn(`当前目录没有 ${modulesDir}/ 文件夹`);
      return;
    }

    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = readManifest(resolve(modulesDir, entry.name));
        logger.info(
          `${manifest.name}@${manifest.version}` +
            (manifest.route ? `  route=${manifest.route}` : ""),
        );
      } catch {
        // module.json 可选：没有清单就按目录名列出
        logger.info(`${entry.name}`);
      }
    }
  },
});

// ─────────────────────────────────────────────
// elysiax doctor — 模块约定体检（路由冲突 / 岛边界 / DI 图 / 插座门禁 /
// 数据层 / schema 漂移 / 迁移只追加 / 错误约定）
// ─────────────────────────────────────────────
cli.addCommand({
  name: "doctor",
  description: "体检：DI 图、路由冲突、岛边界、插座门禁、数据层、schema 漂移、迁移只追加、错误约定",
  options: [
    {
      name: "db",
      type: String,
      description: "schema 漂移检查用的 sqlite 库路径（默认在项目内 data/.data/ 探测 .db 文件）",
    },
  ],
  execute: async ({ options, logger }) => {
    const root = process.cwd();
    const { codegen, loadConfig, extractRoutes } = await import("@elysiax/core");
    const config = await loadConfig(root);
    const modulesDir = config.modules ?? "src/modules";
    let errors = 0;

    // 1) DI 图 + codegen（依赖缺失/环会在这里抛出来）
    try {
      await codegen(root, config);
      logger.info("✅ DI 图装配通过（.elysiax/ 已生成）");
    } catch (error) {
      logger.error(`❌ DI 图装配失败: ${(error as Error).message}`);
      errors++;
    }

    // 2) 跨模块路由冲突：同一路径被两个模块声明，运行时才炸太晚了
    const pathOwner = new Map<string, string>();
    const modDirs = existsSync(resolve(root, modulesDir))
      ? readdirSync(resolve(root, modulesDir), { withFileTypes: true })
      : [];
    for (const entry of modDirs) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(root, modulesDir, entry.name);
      for (const f of readdirSync(dir)) {
        const m = f.match(/^(.+)\.controller\.tsx?$/);
        if (!m) continue;
        const src = readFileSync(resolve(dir, f), "utf8");
        const { paths } = extractRoutes(src, `/${entry.name}`);
        for (const p of paths) {
          // 参数段归一化后再比（/a/:id 与 /a/:name 是同一路径）
          const norm = p.replaceAll(/:[^/]+/g, ":");
          const owner = pathOwner.get(norm);
          if (owner && owner !== entry.name) {
            logger.error(`❌ 路由冲突: ${p}（${entry.name}）与 ${owner} 模块重复`);
            errors++;
          } else {
            pathOwner.set(norm, entry.name);
          }
        }
      }
    }
    if (errors === 0) logger.info(`✅ 路由无冲突（${pathOwner.size} 条）`);

    // 3) client 模式边界：client/ 是浏览器代码，import .elysiax 桶文件会把服务端
    //    图谱（modules.gen → service → bun:sqlite）打进浏览器 bundle，
    //    必须直接引 .elysiax/routes.gen；Node-only 包（dotenv/bun:sqlite）同理禁止
    let clientIssues = 0;
    const pagesDir = config.pages ?? "src/pages";
    const { Glob } = await import("bun");
    for await (const f of new Glob(`${pagesDir}/**/client/**/*.ts*`).scan({ cwd: root })) {
      const src = readFileSync(resolve(root, f), "utf8");
      // 只查值级 import（type import 会被擦除，不进入浏览器包）
      for (const m of src.matchAll(/^import\s+(?!type\b)[^"']*from\s+["']([^"']+)["']/gm)) {
        const spec = m[1]!;
        if (/\.elysiax(\/index)?$/.test(spec) || spec === ".elysiax" || spec === "@gen") {
          logger.error(
            `❌ ${f}: client（浏览器代码）import 了 .elysiax 桶文件，` +
              `会把服务端图谱打进浏览器 bundle——routes 请从 .elysiax/routes.gen 直接引`,
          );
          clientIssues++;
          errors++;
        } else if (["dotenv", "bun:sqlite", "node:fs", "node:child_process"].some((p) => spec === p || spec.startsWith("node:"))) {
          logger.error(
            `❌ ${f}: client 依赖链引入 Node-only 包 "${spec}"，Bun 浏览器打包会 500` +
              `——抽零依赖模块共用（参考 dockyard 的 env-text.ts）`,
          );
          clientIssues++;
          errors++;
        }
      }
    }
    if (!clientIssues) logger.info("✅ client 模式边界无越界");

    // 4) 插座门禁（凹凸契约）：有 <name>.di.ts / <name>.socket.ts 的文件夹是原子；
    //    跨原子 import 只允许指向对方插座文件（<name>.socket.ts），
    //    指向原子内部其他文件 = 私拉电线（type import 同样算——类型也是契约）
    let socketIssues = 0;
    const atomsDirs: string[] = [];
    const socketFiles: string[] = [];
    for await (const f of new Glob(`${pagesDir}/**/*.{di,socket}.ts`).scan({ cwd: root })) {
      if (f.endsWith(".socket.ts")) socketFiles.push(resolve(root, f));
      const d = resolve(root, f, "..");
      if (!atomsDirs.includes(d)) atomsDirs.push(d);
    }
    const atomOf = (absFile: string): string | undefined => {
      const dir = resolve(absFile, "..");
      // 嵌套原子取最深归属
      return atomsDirs
        .filter((a) => dir === a || dir.startsWith(`${a}/`))
        .sort((a, b) => b.length - a.length)[0];
    };
    const resolveImport = (fromFile: string, spec: string): string | undefined => {
      // 路径别名（模板 tsconfig paths 约定）：@gen → .elysiax/，@/ → src/
      const base = spec.startsWith("@gen")
        ? resolve(root, ".elysiax", spec.slice(4))
        : spec.startsWith("@/")
          ? resolve(root, "src", spec.slice(2))
          : resolve(fromFile, "..", spec);
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`])
        if (existsSync(cand)) return cand;
      return undefined;
    };
    // 插座导出符号缓存（适配检查用）；传 resolver 让 export * from "./x" 也能被解析
    const socketSymbols = new Map<string, Set<string>>();
    const symbolsOf = (sf: string) => {
      let syms = socketSymbols.get(sf);
      if (!syms) {
        syms = socketExports(readFileSync(sf, "utf8"), (spec) =>
          spec.startsWith(".") ? resolveImport(sf, spec) : undefined,
        );
        socketSymbols.set(sf, syms);
      }
      return syms;
    };
    for await (const f of new Glob(`${pagesDir}/**/*.ts*`).scan({ cwd: root })) {
      const abs = resolve(root, f);
      const src = readFileSync(abs, "utf8");
      // 三种跨文件引用形态都查：import ... from / export ... from（再导出）/ import "..."（副作用）
      for (const m of src.matchAll(/^\s*(?:import\s+(?:type\s+)?([^"']*?)from|export\s+(?:type\s+)?([^"']*?)from|import)\s*["']([^"']+)["']/gm)) {
        const clause = m[1] ?? m[2] ?? "";
        const spec = m[3]!;
        // 只查相对 import 与 @/ 别名（指向 src/ 内部）；包与 shared 基建不查
        if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
        const target = resolveImport(abs, spec);
        if (!target || !target.includes(`/${pagesDir}/`)) continue;
        const srcAtom = atomOf(abs);
        const tgtAtom = atomOf(target);
        if (!tgtAtom || tgtAtom === srcAtom) continue; // 原子内部 / 非原子目标
        if (!/\.socket\.tsx?$/.test(target)) {
          logger.error(
            `❌ ${f}: 跨原子 import 绕过了插座（${spec}）——` +
              `只允许指向对方的 <name>.socket.ts，被引用方请先把符号登记进插座`,
          );
          socketIssues++;
          errors++;
          continue;
        }
        // 5) 适配检查（符号级）：插头引用的每个符号，插座必须真实导出——
        //    源码分发场景下"接口对不上"在安装期就报出来，而不是运行时炸
        const named = /^\{([^}]*)\}/s.exec(clause.trim())?.[1];
        if (!named) continue; // default/namespace import：插座无 default（§3.1），tsc 会抓
        for (const part of named.split(",")) {
          const sym = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
          if (!sym) continue;
          if (!symbolsOf(target).has(sym)) {
            logger.error(
              `❌ ${f}: 插头插不上——插座 ${relative(root, target)} 没有导出 "${sym}"` +
                `（插座出口被删/改名，或复制来的原子与对方插座版本不匹配）`,
            );
            socketIssues++;
            errors++;
          }
        }
      }
    }
    if (!socketIssues) logger.info(`✅ 插座门禁 + 适配检查通过（${atomsDirs.length} 个原子）`);

    // 6) 插座纯度（契约 §3.1）：socket 只含 named/type export，
    //    不 export default、不导出实例（共享可变状态绕过 DI）
    let purityIssues = 0;
    for (const sf of socketFiles) {
      const src = readFileSync(sf, "utf8");
      const rel = relative(root, sf);
      if (/^export\s+default\s/m.test(src)) {
        logger.error(`❌ ${rel}: 插座含 export default——插座只许 named/type export（契约 §3.1）`);
        purityIssues++;
        errors++;
      }
      if (/^export\s+const\s+\w+\s*=\s*new\s/m.test(src)) {
        logger.error(`❌ ${rel}: 插座导出了实例（export const = new …）——共享可变状态必须走 DI，不进插座`);
        purityIssues++;
        errors++;
      }
    }
    if (!purityIssues) logger.info("✅ 插座纯度通过（无 default / 实例出口）");

    // 7) 插座只增不减（additive-only）：插座出口是承诺，对比 git HEAD，
    //    出口减少 = 拔插头。未入库的新文件跳过。
    let removedTotal = 0;
    for (const sf of socketFiles) {
      const rel = relative(root, sf).replaceAll("\\", "/");
      // HEAD:./<rel>：./ 前缀让 git 按 cwd 解析（monorepo 子目录下裸相对路径会解析到仓库根）
      const old = Bun.spawnSync(["git", "show", `HEAD:./${rel}`], { cwd: root, stdout: "pipe", stderr: "ignore" });
      if (old.exitCode !== 0) continue;
      const removed = [...socketExports(old.stdout.toString())].filter((s) => !symbolsOf(sf).has(s));
      if (removed.length) {
        logger.error(
          `❌ ${rel}: 插座出口减少了 ${removed.map((s) => `"${s}"`).join(", ")}——` +
            `插座只增不减；确需删改请先确认没有插头在使用（doctor 适配检查）`,
        );
        removedTotal += removed.length;
        errors++;
      }
    }
    if (!removedTotal) logger.info("✅ 插座出口只增不减");

    // 8) 数据层门禁（契约 §8）：表名全局唯一、迁移 timestamp 全局唯一、
    //    迁移只许动自己的表（外键 REFERENCES 别家表是插头，允许；CREATE/ALTER 别家表禁止）。
    //    表分两类计数：drizzle sqliteTable 锚点 与 裸 SQL（CREATE TABLE）——裸 SQL 原子
    //    没有 drizzle 表，只认 sqliteTable 会报「0 张表」假绿
    let dataIssues = 0;
    const tableOwner = new Map<string, string>(); // 表名 → schema.ts 绝对路径
    const rawSqlTables = new Set<string>(); // 裸 SQL 建表（CREATE TABLE）去重
    /** 表归属/前缀检查，drizzle 与裸 SQL 共用 */
    const checkTable = (tbl: string, abs: string, f: string) => {
      const owner = tableOwner.get(tbl);
      if (owner && owner !== abs) {
        logger.error(`❌ 表名撞车: "${tbl}" 同时定义在 ${relative(root, owner)} 与 ${f}——复制原子时请改表名前缀`);
        dataIssues++;
        errors++;
      } else tableOwner.set(tbl, abs);
      // 表名前缀 = 原子名（下划线化）：复制原子进项目时防撞、一眼知归属
      const atomDir = atomOf(abs);
      const prefix = atomDir ? basename(atomDir).replaceAll("-", "_") : undefined;
      if (prefix && !tbl.startsWith(prefix)) {
        logger.error(`❌ ${f}: 表 "${tbl}" 未以原子名 "${prefix}" 开头（契约 §9.1：表名前缀 = 原子名）`);
        dataIssues++;
        errors++;
      }
    };
    for await (const f of new Glob(`${pagesDir}/**/schema.ts`).scan({ cwd: root })) {
      const abs = resolve(root, f);
      // 剥注释：骨架里的注释示例（sqliteTable/CREATE TABLE）不算真实表锚点
      const src = stripComments(readFileSync(abs, "utf8"));
      for (const m of src.matchAll(/sqliteTable\(\s*["'`](\w+)["'`]/g))
        checkTable(m[1]!, abs, f);
      // 裸 SQL 原子：schema.ts 里直接写 CREATE TABLE 也算表锚点
      for (const m of src.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi)) {
        rawSqlTables.add(m[1]!);
        checkTable(m[1]!, abs, f);
      }
    }
    // timestamp 撞名判定：同 timestamp + 同 name = 合法（拆分片段）；
    // 同 timestamp + 不同 name = 撞车（执行顺序不确定，shared/db 按 import 序兜底太脆）
    const seenTs = new Map<number, Map<string, string>>(); // ts → (name → file)
    for await (const f of new Glob(`${pagesDir}/**/migrations.ts`).scan({ cwd: root })) {
      const abs = resolve(root, f);
      // 剥注释：骨架注释里的 DDL 示例不算真实迁移
      const src = stripComments(readFileSync(abs, "utf8"));
      // 逐条 journal 抓 name + timestamp（条目形如 { name: "...", timestamp: N, ... }）
      for (const m of src.matchAll(/\{[^{}]*?name:\s*["'`]([^"'`]+)["'`][^{}]*?timestamp:\s*(\d+)[^{}]*?\}/gs)) {
        const [, name, tsRaw] = m;
        const ts = Number(tsRaw);
        const names = seenTs.get(ts) ?? new Map<string, string>();
        const prev = names.get(name!);
        if (prev && prev !== f) {
          // 同名同 timestamp 跨文件 = 合法拆分片段，只记一次
        } else if (!prev) names.set(name!, f);
        const others = [...names.keys()].filter((n) => n !== name);
        if (others.length > 0) {
          logger.error(
            `❌ 迁移 timestamp ${ts} 撞车: "${name}"（${f}）与 "${others[0]}"（${names.get(others[0]!)}）` +
              `——同 timestamp 只允许是同一条迁移的拆分片段（同 name），新迁移请用新 timestamp`,
          );
          dataIssues++;
          errors++;
        }
        seenTs.set(ts, names);
      }
      const fileAtom = atomOf(abs);
      for (const m of src.matchAll(/\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`](\w+)["`]/gi)) {
        if (/^\s*CREATE\s+TABLE/i.test(m[0])) rawSqlTables.add(m[1]!);
        const owner = tableOwner.get(m[1]!);
        if (owner && atomOf(owner) !== fileAtom) {
          logger.error(`❌ ${f}: 迁移改动了别家原子的表 "${m[1]}"（属 ${relative(root, owner)}）——跨原子 DDL 禁止，外键引用才是插头`);
          dataIssues++;
          errors++;
        }
      }
    }
    // 表数区分 drizzle 锚点与裸 SQL；两者皆为 0 才报 0
    const drizzleCount = tableOwner.size - [...rawSqlTables].filter((t) => tableOwner.has(t)).length;
    if (!dataIssues)
      logger.info(
        `✅ 数据层门禁通过（drizzle 表 ${Math.max(drizzleCount, 0)} 张 / 裸 SQL 表 ${rawSqlTables.size} 张 / ${seenTs.size} 条迁移）`,
      );

    // 9) 端点 schema 完整性（警告，不 fail）：2-arg 形态的端点 handler
    //    解构了 params/query/body 但路由没声明 schema——Eden/OpenAPI 的类型缺口
    let schemaWarnings = 0;
    for await (const f of new Glob(`${pagesDir}/**/*.actions.ts*`).scan({ cwd: root })) {
      // 先剥注释：骨架里的注释示例（.post("/", {...}, ({ body }) => ...)）不算违规
      const src = stripComments(readFileSync(resolve(root, f), "utf8"));
      for (const m of src.matchAll(/\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:async\s*)?\(\s*\{([^}]*)\}/g)) {
        const keys = m[3]!;
        if (/\bparams\b/.test(keys)) {
          logger.warn(`⚠️  ${f}: ${m[1]!.toUpperCase()} ${m[2]} handler 读了 params 但路由无 schema——Eden/OpenAPI 缺参数类型`);
          schemaWarnings++;
        }
        if (/\bbody\b/.test(keys)) {
          logger.warn(`⚠️  ${f}: ${m[1]!.toUpperCase()} ${m[2]} handler 读了 body 但路由无 schema`);
          schemaWarnings++;
        }
        if (/\bquery\b/.test(keys)) {
          logger.warn(`⚠️  ${f}: ${m[1]!.toUpperCase()} ${m[2]} handler 读了 query 但路由无 schema`);
          schemaWarnings++;
        }
      }
    }
    if (!schemaWarnings) logger.info("✅ 端点 schema 完整（Eden/OpenAPI 类型无缺口）");

    // 10) schema 漂移：schema.ts 声明的表 vs 存量库 sqlite_master 实际表。
    //    教训：改过历史迁移 SQL 后存量库不会重跑，表名漂移靠运行时 500 才暴露。
    //    无 DB 文件（CI/新克隆）跳过；`--db <路径>` 可显式指定，否则按约定位置探测。
    let driftIssues = 0;
    const dbFlag = typeof options.db === "string" ? options.db : undefined;
    const dbCandidates = dbFlag
      ? [resolve(root, dbFlag)]
      : ["data", ".data", ""].flatMap((d) => {
          const dir = resolve(root, d);
          return existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => f.endsWith(".db") || f.endsWith(".sqlite"))
                .map((f) => resolve(dir, f))
            : [];
        });
    const dbFile = dbCandidates.find((p) => existsSync(p));
    if (dbFile && tableOwner.size > 0) {
      const { Database } = await import("bun:sqlite");
      const sqlite = new Database(dbFile, { readonly: true });
      const actual = new Set(
        sqlite
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name)
          // drizzle 迁移元表与 sqlite 内部表不算业务表
          .filter((n) => !n.startsWith("__") && !n.startsWith("sqlite_")),
      );
      sqlite.close();
      const declared = new Set(tableOwner.keys());
      for (const t of declared) {
        if (!actual.has(t)) {
          logger.error(`❌ schema 漂移: 表 "${t}" 在 schema.ts 声明但库里不存在（${relative(root, dbFile)}）——历史迁移被改过？存量库需手工对齐`);
          driftIssues++;
          errors++;
        }
      }
      for (const t of actual) {
        if (!declared.has(t)) {
          logger.error(`❌ schema 漂移: 库里存在表 "${t}" 但没有任何 schema.ts 声明它（${relative(root, dbFile)}）——疑似旧表名残留`);
          driftIssues++;
          errors++;
        }
      }
      if (!driftIssues) logger.info(`✅ schema 与存量库一致（${actual.size} 张表）`);
    } else {
      logger.info("⏭️  跳过 schema 漂移检查（未找到 .db 文件，或用 --db <路径> 指定）");
    }

    // 11) 迁移只追加：历史迁移条目（name+timestamp）对比 git HEAD，
    //     内容被改或整条被删 = 存量库漂移源头。新条目随意加。
    //     与插座只增不减（检查 7）同款思路：入口是承诺。
    let migrationIssues = 0;
    for await (const f of new Glob(`${pagesDir}/**/migrations.ts`).scan({ cwd: root })) {
      const rel = f.replaceAll("\\", "/");
      // HEAD:./<rel> 的 ./ 前缀让 git 按 cwd 解析（monorepo 子目录下裸相对路径会解析到仓库根）
      const old = Bun.spawnSync(["git", "show", `HEAD:./${rel}`], { cwd: root, stdout: "pipe", stderr: "ignore" });
      if (old.exitCode !== 0) continue; // 未入库的新文件跳过
      // 抓迁移条目的原始文本块：name/timestamp → 整块文本（到下一个条目或数组尾）
      const entriesOf = (src: string) => {
        const map = new Map<string, string>();
        for (const m of src.matchAll(/\{[^{}]*?name:\s*["'`]([^"'`]+)["'`][^{}]*?timestamp:\s*(\d+)[^{}]*?\}/gs))
          map.set(`${m[1]}@${m[2]}`, m[0].replaceAll(/\s+/g, ""));
        return map;
      };
      const oldEntries = entriesOf(old.stdout.toString());
      const newEntries = entriesOf(readFileSync(resolve(root, f), "utf8"));
      for (const [key, text] of oldEntries) {
        const now = newEntries.get(key);
        if (!now) {
          logger.error(`❌ ${f}: 历史迁移 "${key}" 被删除——迁移只追加，删除会让新库建不出存量结构`);
          migrationIssues++;
          errors++;
        } else if (now !== text) {
          logger.error(`❌ ${f}: 历史迁移 "${key}" 的 SQL 被修改——存量库不会重跑已执行的迁移，改历史 = 制造 schema 漂移；请追加新迁移条目`);
          migrationIssues++;
          errors++;
        }
      }
    }
    if (!migrationIssues) logger.info("✅ 迁移只追加（历史条目未变）");

    // 12) 错误约定：services 抛 ServiceError（框架统一映射），禁裸 Error 回显。
    //     actions 零 try/catch 靠 review 把关，这里先抓最机械的一条。
    let errorIssues = 0;
    for await (const f of new Glob(`${pagesDir}/**/*.service.ts`).scan({ cwd: root })) {
      const src = stripComments(readFileSync(resolve(root, f), "utf8"));
      for (const m of src.matchAll(/throw\s+new\s+(\w+)/g)) {
        if (m[1] === "Error" || m[1] === "TypeError") {
          logger.error(`❌ ${f}: service 抛了裸 ${m[1]}——请抛 ServiceError（@elysiax/core），由框架统一映射为 { error }`);
          errorIssues++;
          errors++;
        }
      }
    }
    if (!errorIssues) logger.info("✅ 错误约定通过（services 只抛 ServiceError）");

    if (errors > 0) throw new Error(`doctor 发现 ${errors} 个问题`);
    logger.info("✅ 全部检查通过");
  },
});

// ─────────────────────────────────────────────
// elysiax gen — 生成 .elysiax/（模块清单 + 容器装配）
// ─────────────────────────────────────────────
cli.addCommand({
  name: "gen",
  description: "扫描 modules/ 与 src/infra.di.ts，生成 .elysiax/ 装配代码",
  execute: async ({ logger }) => {
    const { codegen } = await import("@elysiax/core");
    const files = await codegen(process.cwd());
    for (const f of files) logger.info(`✅ ${f}`);
  },
});

// ─────────────────────────────────────────────
// elysiax dev — codegen + bun --hot，并 watch 模块声明变化自动重生成
// ─────────────────────────────────────────────
cli.addCommand({
  name: "dev",
  description: "开发模式：生成 .elysiax/ 后启动 bun --hot，模块声明变化自动重生成",
  execute: async ({ logger }) => {
    const { codegen, loadConfig } = await import("@elysiax/core");
    const { Glob } = await import("bun");
    const { spawn } = await import("node:child_process");

    const config = await loadConfig(process.cwd());
    const modulesDir = config.modules ?? "src/modules";
    const pagesDir = config.pages ?? "src/pages";
    const entry = config.build?.entry ?? "src/index.ts";

    await codegen(process.cwd(), config);
    logger.info("✅ .elysiax/ 已生成");

    // 当前子进程退出（非重启换掉的旧进程）→ CLI 随之退出
    const spawnChild = () => {
      const c = spawn("bun", ["--hot", entry], {
        stdio: "inherit",
        cwd: process.cwd(),
      });
      c.on("exit", (code) => {
        if (child === c) process.exit(code ?? 0);
      });
      return c;
    };
    let child = spawnChild();

    // 轮询两类变化：
    // 1. 声明变化（module.json / *.di.ts / infra.di.ts）→ 重新 codegen，
    //    .elysiax/ 文件变化触发 bun --hot 重载
    // 2. 页面结构变化（page/partials/actions/client 文件增删）→ Bun.serve
    //    routes 表不可热增，codegen 后重启子进程
    const snapshot = async () => {
      const times: string[] = [];
      for (const pattern of [
        `${modulesDir}/*/module.json`,
        `${modulesDir}/*/*.di.ts`,
        `${pagesDir}/**/*.di.ts`,
        "src/infra.di.ts",
        // SSR 全局样式内容变化 → 重新 codegen（assets.gen 内联文本），
        // .elysiax/ 变化触发 bun --hot 重载；client 页 CSS 走 HTMLBundle HMR
        config.clientCss ?? "src/global.css",
      ]) {
        for await (const f of new Glob(pattern).scan({ cwd: process.cwd() })) {
          times.push(`${f}:${(await Bun.file(f).lastModified)}`);
        }
      }
      return times.join("|");
    };
    const structureSnapshot = async () => {
      const files: string[] = [];
      for (const pattern of [
        `${pagesDir}/**/*.page.tsx`,
        `${pagesDir}/**/*.page.ts`,
        `${pagesDir}/**/*.partials.tsx`,
        `${pagesDir}/**/*.partials.ts`,
        `${pagesDir}/**/*.actions.ts`,
        `${pagesDir}/**/*.actions.tsx`,
        `${pagesDir}/**/client/index.tsx`,
      ]) {
        for await (const f of new Glob(pattern).scan({ cwd: process.cwd() })) {
          files.push(f);
        }
      }
      return files.sort().join("|");
    };
    const restart = () => {
      child.kill();
      child = spawnChild();
      logger.info("🔄 页面结构变化，dev server 已重启");
    };
    let last = await snapshot();
    let lastStructure = await structureSnapshot();
    setInterval(async () => {
      const structure = await structureSnapshot();
      const now = await snapshot();
      if (structure === lastStructure && now === last) return;
      try {
        await codegen(process.cwd(), config);
      } catch (error) {
        logger.error((error as Error).message);
        return;
      }
      if (structure !== lastStructure) {
        lastStructure = structure;
        last = now;
        restart();
      } else {
        last = now;
        logger.info("🔄 模块声明变化，.elysiax/ 已重新生成");
      }
    }, 500);

    // 保持 CLI 进程存活（setInterval 持有事件循环；子进程退出时 spawnChild
    // 的 exit 回调里 process.exit）
    await new Promise(() => {});
  },
});

// ─────────────────────────────────────────────
// 构建辅助
// ─────────────────────────────────────────────

/** 从项目目录解析依赖（CLI 自身不直接依赖这些包） */
function resolveFrom(root: string, pkg: string): string {
  return Bun.resolveSync(pkg, root);
}

/** PNG → ICO（Vista+ 支持 PNG 载荷，纯包装无需外部工具） */
async function pngToIco(pngPath: string, outPath: string) {
  const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
  // IHDR 宽高在第 16-24 字节
  const dv = new DataView(png.buffer, png.byteOffset);
  const w = dv.getUint32(16) % 256;
  const h = dv.getUint32(20) % 256;
  const header = new DataView(new ArrayBuffer(22));
  header.setUint16(2, 1, true); // type: icon
  header.setUint16(4, 1, true); // count
  header.setUint8(6, w);
  header.setUint8(7, h);
  header.setUint16(10, 1, true); // planes
  header.setUint16(12, 32, true); // bitcount
  header.setUint32(14, png.length, true);
  header.setUint32(18, 22, true); // offset
  await Bun.write(outPath, Buffer.concat([Buffer.from(header.buffer), png]));
}

const BUN_TARGETS = {
  "linux-x64": "bun-linux-x64",
  "windows-x64": "bun-windows-x64",
} as const;

// ─────────────────────────────────────────────
// elysiax build [--desktop] — 按 elysiax.config.ts 构建二进制
// ─────────────────────────────────────────────
cli.addCommand({
  name: "build",
  description: "构建二进制（读 elysiax.config.ts 的 build/desktop 配置）",
  options: [
    {
      name: "desktop",
      alias: "d",
      type: Boolean,
      description: "构建桌面应用（webview 窗口版）而非 server",
    },
  ],
  execute: async ({ options, logger }) => {
    const root = process.cwd();
    const { codegen, loadConfig } = await import("@elysiax/core");
    const config = await loadConfig(root);
    await codegen(root, config);

    const name = config.app?.name ?? "app";
    const outdir = resolve(root, config.build?.outdir ?? "dist");
    const targets = config.build?.targets ?? ["linux-x64"];
    const tailwind = (await import(resolveFrom(root, "bun-plugin-tailwind")))
      .default;

    let entry: string;
    if (options.desktop) {
      if (!config.desktop)
        throw new Error("elysiax.config.ts 里没有 desktop 配置段");
      // 逃生口：项目自带 src/desktop.ts 时优先使用，否则用生成的
      entry = resolve(root, "src/desktop.ts");
      if (!existsSync(entry)) entry = resolve(root, ".elysiax/desktop.gen.ts");
    } else {
      entry = resolve(root, config.build?.entry ?? "src/index.ts");
    }

    for (const t of targets) {
      const isWin = t.startsWith("windows");
      const outfile = resolve(
        outdir,
        `${name}${options.desktop ? "-app" : ""}${isWin ? ".exe" : ""}`,
      );
      const compile: Record<string, unknown> = {
        target: BUN_TARGETS[t],
        outfile,
      };
      if (isWin && config.desktop?.icon) {
        const ico = resolve(outdir, "icon.ico");
        await pngToIco(resolve(root, config.desktop.icon), ico);
        compile.windowsIcon = ico;
        compile.windowsHideConsole = true;
      }
      const result = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        plugins: [tailwind],
        compile,
      });
      if (!result.success) {
        for (const l of result.logs) logger.error(l.message);
        throw new Error(`构建失败: ${t}`);
      }
      logger.info(`✅ ${outfile}`);
    }
  },
});

// ─────────────────────────────────────────────
// elysiax package — 生成安装包产物（当前：Arch PKGBUILD）
// ─────────────────────────────────────────────
cli.addCommand({
  name: "package",
  description: "生成安装包产物到 dist/packaging/（当前支持 Arch PKGBUILD）",
  execute: async ({ logger }) => {
    const root = process.cwd();
    const { loadConfig } = await import("@elysiax/core");
    const config = await loadConfig(root);
    if (!config.package?.linux?.pkgbuild)
      throw new Error("elysiax.config.ts 里没有 package.linux.pkgbuild 配置");

    const name = config.app?.name ?? "app";
    const version = config.app?.version ?? "0.1.0";
    const outdir = resolve(root, config.build?.outdir ?? "dist");
    const binary = resolve(outdir, `${name}-app`);
    if (!existsSync(binary))
      throw new Error(`未找到 ${binary}，请先运行 elysiax build --desktop`);

    const pkgDir = resolve(outdir, "packaging");
    mkdirSync(pkgDir, { recursive: true });
    const { copyFileSync } = await import("node:fs");
    copyFileSync(binary, resolve(pkgDir, `${name}-app`));
    const iconName = `${name}.png`;
    if (config.desktop?.icon)
      copyFileSync(resolve(root, config.desktop.icon), resolve(pkgDir, iconName));

    writeFileSync(
      resolve(pkgDir, `${name}.desktop`),
      [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${name}`,
        `Comment=${name} (Bun + Elysia + htmx)`,
        `Exec=${name}`,
        `Icon=${name}`,
        "Terminal=false",
        "Categories=Development;Utility;",
        "",
      ].join("\n"),
    );

    writeFileSync(
      resolve(pkgDir, "PKGBUILD"),
      `# 由 elysiax package 生成。本地试用：makepkg -si    发布 AUR 后：yay -S ${name}-bin
pkgname=${name}-bin
pkgver=${version}
pkgrel=1
pkgdesc="${name} (Bun + Elysia + htmx, webview window)"
arch=('x86_64')
license=('MIT')
depends=('webkitgtk-6.0' 'gtk4')
# bun --compile 的内嵌负载会被 strip/debug 分离破坏，必须禁用
options=('!strip' '!debug')
source=("${name}-app" "${name}.desktop" "${iconName}")
sha256sums=('SKIP' 'SKIP' 'SKIP')

package() {
  install -Dm755 "$srcdir/${name}-app" "$pkgdir/usr/bin/${name}"
  install -Dm644 "$srcdir/${name}.desktop" \\
    "$pkgdir/usr/share/applications/${name}.desktop"
  install -Dm644 "$srcdir/${iconName}" \\
    "$pkgdir/usr/share/icons/hicolor/256x256/apps/${iconName}"
}
`,
    );
    logger.info(`✅ ${pkgDir}/（PKGBUILD + .desktop + 图标 + 二进制）`);
    logger.info(`   本地安装: cd ${pkgDir} && makepkg -si`);
  },
});

await cli.run();
