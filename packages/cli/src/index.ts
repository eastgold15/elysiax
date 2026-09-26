#!/usr/bin/env bun
import { createCerebro } from "@visulima/cerebro";
import { errorHandlerPlugin } from "@visulima/cerebro/plugins/error-handler";
import { existsSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
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

    // 替换 package.json 里的项目名占位符
    const pkgPath = resolve(target, "package.json");
    writeFileSync(
      pkgPath,
      readFileSync(pkgPath, "utf8").replaceAll("{{name}}", name),
    );

    logger.info(`✅ 项目已创建: ${target}`);
    logger.info(`下一步:`);
    logger.info(`  cd ${argument[0] ?? "."}`);
    logger.info(`  bun install`);
    logger.info(`  bun run dev`);
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
    description: "模块源码目录（本地路径，需含 module.json）",
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
  execute: ({ argument, options, logger }) => {
    const source = resolve(process.cwd(), argument[0] ?? "");
    if (!existsSync(source)) {
      throw new Error(`源码目录不存在: ${source}`);
    }

    let manifest: ModuleManifest;
    try {
      manifest = readManifest(source);
    } catch (error) {
      throw new Error((error as Error).message);
    }

    const target = resolve(process.cwd(), "modules", manifest.name);

    if (source === target) {
      throw new Error(`源和目标相同: ${source}`);
    }

    if (existsSync(target) && !options.force) {
      throw new Error(
        `modules/${manifest.name} 已存在。源码安装原则：不做静默覆盖。请先手动 diff，或用 --force 覆盖。`,
      );
    }

    cpSync(source, target, { recursive: true });
    logger.info(
      `✅ 已安装 ${manifest.name}@${manifest.version} → modules/${manifest.name}/`,
    );
    if (manifest.route) logger.info(`   路由前缀: ${manifest.route}`);
    if (manifest.provides?.length)
      logger.info(`   provides: ${manifest.provides.join(", ")}`);
    if (manifest.requires?.length)
      logger.info(`   requires: ${manifest.requires.join(", ")}`);
  },
});

// ─────────────────────────────────────────────
// elysiax list — 列出已安装模块
// ─────────────────────────────────────────────
cli.addCommand({
  name: "list",
  alias: "ls",
  description: "列出 ./modules/ 下已安装的模块",
  execute: ({ logger }) => {
    const modulesDir = resolve(process.cwd(), "modules");
    if (!existsSync(modulesDir)) {
      logger.warn("当前目录没有 modules/ 文件夹");
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
        logger.warn(`${entry.name}/  （缺少 module.json，已跳过）`);
      }
    }
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
    const { codegen } = await import("@elysiax/core");
    const { Glob } = await import("bun");
    const { spawn } = await import("node:child_process");

    await codegen(process.cwd());
    logger.info("✅ .elysiax/ 已生成");

    const child = spawn("bun", ["--hot", "src/index.ts"], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    // 轮询模块声明（module.json / *.di.ts / infra.di.ts）变化 → 重新生成，
    // .elysiax/ 文件变化会触发 bun --hot 重载
    const snapshot = async () => {
      const times: string[] = [];
      for (const pattern of [
        "modules/*/module.json",
        "modules/*/*.di.ts",
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
          await codegen(process.cwd());
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

await cli.run();
