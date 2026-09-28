#!/usr/bin/env bun
import { createCerebro } from "@visulima/cerebro";
import { errorHandlerPlugin } from "@visulima/cerebro/plugins/error-handler";
import { existsSync, cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

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

async function scaffoldModule(name: string, logger: { info: (m: string) => void }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`模块名须为 kebab-case: ${name}`);

  const root = process.cwd();
  const { loadConfig, codegen } = await import("@elysiax/core");
  const config = await loadConfig(root);
  const modulesDir = config.modules ?? "src/modules";
  const dir = resolve(root, modulesDir, name);
  if (existsSync(dir)) throw new Error(`模块已存在: ${dir}`);

  // 模块目录到 .elysiax/ 的相对深度（如 src/modules/user → ../../../）
  const up = "../".repeat(modulesDir.split("/").length + 1);
  const P = pascal(name);
  const C = camel(name);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${name}.service.ts`),
    `export class ${P}Service {
  // 依赖在构造函数里声明，${name}.di.ts 的 provide() 按顺序给类引用：
  // constructor(private readonly db: Db) {}
}
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
    resolve(dir, `${name}.controller.tsx`),
    `import { defineController } from "${up}.elysiax";

export const ${C}Controller = defineController({ prefix: "/${name}" })
  .get("/", ({ di }) => di.get("${C}Service"));
  // 返回 JSX 即 text/html 响应：.get("/ui", ({ di }) => <${P}Ui />)
`,
  );

  await codegen(root, config);
  logger.info(`✅ 模块已创建: ${modulesDir}/${name}/（.elysiax/ 已重新生成）`);
  logger.info(`   路由前缀: /${name}，服务键: ${C}Service`);
}

async function scaffoldIsland(mod: string, logger: { info: (m: string) => void }) {
  const root = process.cwd();
  const { loadConfig } = await import("@elysiax/core");
  const modulesDir = (await loadConfig(root)).modules ?? "src/modules";
  const dir = resolve(root, modulesDir, mod, "island");
  if (!existsSync(resolve(root, modulesDir, mod)))
    throw new Error(`模块不存在: ${modulesDir}/${mod}（先 elysiax new module ${mod}）`);
  if (existsSync(dir)) throw new Error(`岛已存在: ${dir}`);

  const P = pascal(mod);
  mkdirSync(dir, { recursive: true });
  // 岛需要 react / react-dom，没装就直接报错提示（避免生成后类型检查挂）
  const pkgPath = resolve(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps["react-dom"])
    throw new Error(`岛需要 react + react-dom，请先 bun add react react-dom`);
  writeFileSync(
    resolve(dir, "index.tsx"),
    `import { createRoot } from "react-dom/client";

// 边界规则：htmx 只渲染容器 <div id="${mod}-island" />，容器内部全归 React 管，
// 两边不要操作同一个 DOM 元素。
function ${P}Island() {
  return <div>${P} island</div>;
}

const el = document.getElementById("${mod}-island");
if (el) createRoot(el).render(<${P}Island />);
`,
  );
  logger.info(`✅ 岛已创建: ${modulesDir}/${mod}/island/index.tsx`);
  logger.info(`   下一步: 在 ${mod}.ui.tsx 渲染 <div id="${mod}-island" />，并在 index.html 里 <script type="module" src=".../island/index.tsx">`);
}

cli.addCommand({
  name: "new",
  description: "脚手架：new module <name> 生成模块；new island <module> 生成 React 岛",
  arguments: [
    { name: "kind", description: "module | island", type: String },
    { name: "name", description: "模块名（island 时为目标模块）", type: String },
  ],
  execute: async ({ argument, logger }) => {
    const [kind, name] = argument;
    if (!name) throw new Error("用法: elysiax new module <name> | elysiax new island <module>");
    if (kind === "module") return scaffoldModule(name, logger);
    if (kind === "island") return scaffoldIsland(name, logger);
    throw new Error(`未知类型 "${kind}"：支持 module | island`);
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
  description: "体检：DI 图装配、跨模块路由冲突、React 岛 htmx 边界",
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

    // 3) React 岛边界：有 island/ 的模块，ui 片段不得把 htmx swap 目标指向岛容器
    let islandIssues = 0;
    for (const entry of modDirs) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(root, modulesDir, entry.name);
      if (!existsSync(resolve(dir, "island"))) continue;
      // 岛是浏览器代码：import .elysiax 桶文件会把服务端图谱（modules.gen → controller
      // → service → bun:sqlite）打进浏览器 bundle，必须直接引 .elysiax/routes.gen
      for (const f of readdirSync(resolve(dir, "island"))) {
        if (!/\.tsx?$/.test(f)) continue;
        const src = readFileSync(resolve(dir, "island", f), "utf8");
        if (/from\s+["'][^"']*\.elysiax["']/.test(src)) {
          logger.error(
            `❌ ${entry.name}/island/${f}: 岛（浏览器代码）import 了 .elysiax 桶文件，` +
              `会把服务端图谱打进浏览器 bundle——routes 请从 .elysiax/routes.gen 直接引`,
          );
          islandIssues++;
          errors++;
        }
      }
      for (const f of readdirSync(dir)) {
        if (!/\.ui\.tsx$/.test(f)) continue;
        const src = readFileSync(resolve(dir, f), "utf8");
        if (new RegExp(`hx-target=["'{][^}"']*#${entry.name}-island`).test(src)) {
          logger.error(
            `❌ ${entry.name}/${f}: htmx swap 目标指向岛容器 #${entry.name}-island，` +
              `会冲掉 React 挂载点（边界规则：htmx 只渲染容器，容器内部归 React）`,
          );
          islandIssues++;
          errors++;
        }
      }
    }
    if (!islandIssues) logger.info("✅ React 岛边界无越界");

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
    const entry = config.build?.entry ?? "src/index.ts";

    await codegen(process.cwd(), config);
    logger.info("✅ .elysiax/ 已生成");

    const child = spawn("bun", ["--hot", entry], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    // 轮询模块声明（module.json / *.di.ts / infra.di.ts）变化 → 重新生成，
    // .elysiax/ 文件变化会触发 bun --hot 重载
    const snapshot = async () => {
      const times: string[] = [];
      for (const pattern of [
        `${modulesDir}/*/module.json`,
        `${modulesDir}/*/*.di.ts`,
        "src/infra.di.ts",
      ]) {
        for await (const f of new Glob(pattern).scan({ cwd: process.cwd() })) {
          times.push(`${f}:${(await Bun.file(f).lastModified)}`);
        }
      }
      return times.join("|");
    };
    let last = await snapshot();
    setInterval(async () => {
      const now = await snapshot();
      if (now !== last) {
        last = now;
        try {
          await codegen(process.cwd(), config);
          logger.info("🔄 模块声明变化，.elysiax/ 已重新生成");
        } catch (error) {
          logger.error((error as Error).message);
        }
      }
    }, 500);

    // 保持 CLI 进程存活（否则 execute 返回后 cerebro 退出，watcher 随之死亡）
    const code = await new Promise<number>((resolve) =>
      child.on("exit", (c) => resolve(c ?? 0)),
    );
    process.exit(code);
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
