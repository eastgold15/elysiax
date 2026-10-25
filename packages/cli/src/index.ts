#!/usr/bin/env bun
import { createCerebro } from "@visulima/cerebro";
import { errorHandlerPlugin } from "@visulima/cerebro/plugins/error-handler";
import { existsSync, cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** 解析 socket 文件的导出符号表（named/type re-export + 本地声明） */
function socketExports(src: string): Set<string> {
  const names = new Set<string>();
  // export { A, B as C } / export type { ... }（可多行）
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gs))
    for (const part of m[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const asM = /\bas\s+(\w+)$/.exec(p);
      names.add(asM ? asM[1]! : p);
    }
  // export class/function/const/interface/type X
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+)/gm))
    names.add(m[1]!);
  return names;
}

const templateDir = fileURLToPath(new URL("../template", import.meta.url));

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
  // 迁移 journal 片段：shared/db 聚合所有原子的片段后按 timestamp 排序重放
  writeFileSync(
    resolve(dir, "migrations.ts"),
    `// drizzle-kit generate 生成 SQL 后，把语句放进这里（保留 name/timestamp）
export default [] as { name: string; timestamp: number; sql: string }[];
`,
  );
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
  if (ui === "react" && !deps["react-dom"])
    throw new Error(
      `react 形态需要 react + react-dom + @elysia/eden，请先 bun add react react-dom @elysia/eden`,
    );

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
    writeFileSync(
      resolve(dir, "migrations.ts"),
      `// drizzle-kit generate 生成 SQL 后，把语句放进这里（保留 name/timestamp）；
// shared/db 聚合所有原子的片段后按 timestamp 排序重放
export default [] as { name: string; timestamp: number; sql: string }[];
`,
    );
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
  description: "源码安装模块：把模块源码复制到 ./modules/<name>/",
  argument: {
    name: "source",
    description: "模块源码目录（本地路径；module.json 可选，名字取目录名）",
    type: String,
  },
  options: [
    {
      name: "force",
      alias: "f",
      type: Boolean,
      description: "目标已存在时直接覆盖（跳过确认）",
    },
  ],
  execute: async ({ argument, options, logger }) => {
    const source = resolve(process.cwd(), argument[0] ?? "");
    if (!existsSync(source)) {
      throw new Error(`源码目录不存在: ${source}`);
    }

    // module.json 可选：模块名取清单名或目录名，装配正确性由 gen/codegen 校验
    let manifest: ModuleManifest | undefined;
    try {
      manifest = readManifest(source);
    } catch {
      manifest = undefined;
    }
    const name = manifest?.name ?? basename(source);

    const { loadConfig } = await import("@elysiax/core");
    const modulesDir = (await loadConfig(process.cwd())).modules ?? "src/modules";
    const target = resolve(process.cwd(), modulesDir, name);

    if (source === target) {
      throw new Error(`源和目标相同: ${source}`);
    }

    if (existsSync(target) && !options.force) {
      throw new Error(
        `${modulesDir}/${name} 已存在。源码安装原则：不做静默覆盖。请先手动 diff，或用 --force 覆盖。`,
      );
    }

    cpSync(source, target, { recursive: true });
    logger.info(`✅ 已安装 ${name} → ${modulesDir}/${name}/`);
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
// elysiax doctor — 模块约定体检（路由冲突 / 岛边界 / DI 图）
// ─────────────────────────────────────────────
cli.addCommand({
  name: "doctor",
  description: "体检：DI 图装配、跨模块路由冲突、client 模式浏览器边界",
  execute: async ({ logger }) => {
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
    // 插座导出符号缓存（适配检查用）
    const socketSymbols = new Map<string, Set<string>>();
    const symbolsOf = (sf: string) => {
      let syms = socketSymbols.get(sf);
      if (!syms) {
        syms = socketExports(readFileSync(sf, "utf8"));
        socketSymbols.set(sf, syms);
      }
      return syms;
    };
    for await (const f of new Glob(`${pagesDir}/**/*.ts*`).scan({ cwd: root })) {
      const abs = resolve(root, f);
      const src = readFileSync(abs, "utf8");
      for (const m of src.matchAll(/^import\s+(?:type\s+)?([^"']*?)from\s+["']([^"']+)["']/gm)) {
        const clause = m[1]!;
        const spec = m[2]!;
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
      const old = Bun.spawnSync(["git", "show", `HEAD:${rel}`], { cwd: root, stdout: "pipe", stderr: "ignore" });
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
    //    迁移只许动自己的表（外键 REFERENCES 别家表是插头，允许；CREATE/ALTER 别家表禁止）
    let dataIssues = 0;
    const tableOwner = new Map<string, string>(); // 表名 → schema.ts 绝对路径
    for await (const f of new Glob(`${pagesDir}/**/schema.ts`).scan({ cwd: root })) {
      const abs = resolve(root, f);
      const src = readFileSync(abs, "utf8");
      for (const m of src.matchAll(/sqliteTable\(\s*["'`](\w+)["'`]/g)) {
        const owner = tableOwner.get(m[1]!);
        if (owner && owner !== abs) {
          logger.error(`❌ 表名撞车: "${m[1]}" 同时定义在 ${relative(root, owner)} 与 ${f}——复制原子时请改表名前缀`);
          dataIssues++;
          errors++;
        } else tableOwner.set(m[1]!, abs);
      }
    }
    // timestamp 撞名判定：同 timestamp + 同 name = 合法（拆分片段）；
    // 同 timestamp + 不同 name = 撞车（执行顺序不确定，shared/db 按 import 序兜底太脆）
    const seenTs = new Map<number, Map<string, string>>(); // ts → (name → file)
    for await (const f of new Glob(`${pagesDir}/**/migrations.ts`).scan({ cwd: root })) {
      const abs = resolve(root, f);
      const src = readFileSync(abs, "utf8");
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
        const owner = tableOwner.get(m[1]!);
        if (owner && atomOf(owner) !== fileAtom) {
          logger.error(`❌ ${f}: 迁移改动了别家原子的表 "${m[1]}"（属 ${relative(root, owner)}）——跨原子 DDL 禁止，外键引用才是插头`);
          dataIssues++;
          errors++;
        }
      }
    }
    if (!dataIssues) logger.info(`✅ 数据层门禁通过（${tableOwner.size} 张表 / ${seenTs.size} 条迁移）`);

    // 9) 端点 schema 完整性（警告，不 fail）：2-arg 形态的端点 handler
    //    解构了 params/query/body 但路由没声明 schema——Eden/OpenAPI 的类型缺口
    let schemaWarnings = 0;
    for await (const f of new Glob(`${pagesDir}/**/*.actions.ts*`).scan({ cwd: root })) {
      const src = readFileSync(resolve(root, f), "utf8");
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
