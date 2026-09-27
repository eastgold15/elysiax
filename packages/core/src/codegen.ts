import { Glob } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleManifest } from "./index";
import { DEFAULTS, loadConfig, type ElysiaxConfig } from "./config";

/**
 * 模块 DI 声明条目（<name>.di.ts 的 provides 值）：
 * - `{ value }`                    → registerValue
 * - `{ class, deps, lifetime? }`   → registerClass
 * 依赖 `xxxLazy` 是约定：自动给 `xxx` 的注册加 lazyKey 伴随键。
 */
export type DiEntry =
  | { value: unknown }
  | {
      class: new (...args: any[]) => unknown;
      deps: readonly string[];
      lifetime?: "singleton" | "transient";
    };

export interface ModuleDi {
  provides: Record<string, DiEntry>;
}

/** 声明一个模块（或 infra）向容器提供什么。仅收集声明，装配由 codegen 生成。 */
export function defineModule<T extends ModuleDi>(di: T): T {
  return di;
}

interface LoadedModule {
  dir: string; // 绝对路径
  manifest: ModuleManifest;
  di?: ModuleDi;
  diPath?: string;
  diVar: string; // import 变量名，如 userDi
  controller?: string;
  ui?: string;
}

const EXTS = ["tsx", "ts"] as const;

async function firstExisting(dir: string, base: string) {
  for (const ext of EXTS) {
    const p = `${dir}/${base}.${ext}`;
    if (await Bun.file(p).exists()) return p;
  }
  return undefined;
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const ident = (s: string) => s.replace(/-/g, "_");

/**
 * 扫描模块目录与 src/infra.di.ts，把复杂装配生成到 .elysiax/（类 .next 模式）。
 * 返回生成文件列表。
 */
export async function codegen(
  root = process.cwd(),
  config?: ElysiaxConfig,
): Promise<string[]> {
  config ??= await loadConfig(root);
  const modulesDir = config.modules ?? DEFAULTS.modules;
  const entry = config.build?.entry ?? DEFAULTS.entry;
  const written: string[] = [];

  // 基础设施声明（可选）：src/infra.di.ts，永远最先装配
  const infraPath = await firstExisting(join(root, "src"), "infra.di");
  let infra: ModuleDi | undefined;
  if (infraPath) {
    infra = (await import(pathToFileURL(infraPath).href)).default as ModuleDi;
  }

  const mods: LoadedModule[] = [];
  for await (const m of new Glob(`${modulesDir}/*/module.json`).scan({
    cwd: root,
  })) {
    const dir = join(root, m, "..");
    const manifest: ModuleManifest = await Bun.file(join(root, m)).json();
    const name = manifest.name;
    const mod: LoadedModule = { dir, manifest, diVar: `${ident(name)}Di` };

    mod.diPath = await firstExisting(dir, `${name}.di`);
    if (mod.diPath) {
      mod.di = (await import(pathToFileURL(mod.diPath).href)).default as ModuleDi;
    }
    mod.controller = await firstExisting(dir, `${name}.controller`);
    mod.ui = await firstExisting(dir, `${name}.ui`);
    mods.push(mod);
  }

  // ── 拓扑排序：dep 的提供者必须先装配 ──
  const provider = new Map<string, number>(); // key → 模块下标（-1 = infra）
  if (infra) for (const k of Object.keys(infra.provides)) provider.set(k, -1);
  mods.forEach((mod, i) => {
    if (mod.di) for (const k of Object.keys(mod.di.provides)) provider.set(k, i);
  });

  const depsOf = (di: ModuleDi): string[] =>
    Object.values(di.provides).flatMap((e) => ("class" in e ? [...e.deps] : []));

  // lazyKey 收集：dep 'fooLazy' → foo 的注册需要伴随键 'fooLazy'
  const lazyKeys = new Map<string, string>();
  const allDeps = [
    ...(infra ? depsOf(infra) : []),
    ...mods.flatMap((m) => (m.di ? depsOf(m.di) : [])),
  ];
  for (const dep of allDeps) {
    if (dep.endsWith("Lazy")) {
      const base = dep.slice(0, -4);
      if (!provider.has(base))
        throw new Error(`依赖 "${dep}" 的基键 "${base}" 没有任何模块提供`);
      lazyKeys.set(base, dep);
    } else if (!provider.has(dep)) {
      throw new Error(`依赖 "${dep}" 没有任何模块提供（检查 *.di.ts）`);
    }
  }

  const order: number[] = [];
  const state = new Array(mods.length).fill(0); // 0 未访问 1 访问中 2 完成
  const visit = (i: number, chain: string[]) => {
    if (state[i] === 2) return;
    if (state[i] === 1) {
      throw new Error(
        `检测到依赖环: ${[...chain, mods[i]!.manifest.name].join(" → ")}\n` +
          `InferDI 不支持双向 Lazy —— 请按限界上下文拆成单向依赖，` +
          `跨上下文的组合上移到 controller（见 CLAUDE.md）。`,
      );
    }
    state[i] = 1;
    for (const dep of mods[i]!.di ? depsOf(mods[i]!.di!) : []) {
      const base = dep.endsWith("Lazy") ? dep.slice(0, -4) : dep;
      const p = provider.get(base)!;
      if (p >= 0 && p !== i) visit(p, [...chain, mods[i]!.manifest.name]);
    }
    state[i] = 2;
    order.push(i);
  };
  mods.forEach((_, i) => visit(i, []));

  // ── 生成 .elysiax/ ──
  const outDir = join(root, ".elysiax");
  mkdirSync(outDir, { recursive: true });
  const rel = (p: string) => {
    let r = relative(outDir, p).replaceAll("\\", "/");
    if (!r.startsWith(".")) r = "./" + r;
    return r.replace(/\.tsx?$/, ""); // .json 扩展必须保留
  };
  const header = "// 由 elysiax codegen 生成，勿手改（elysiax dev / gen 会重新生成）";

  // container.gen.ts：拓扑序的完整类型链
  const lines: string[] = [header, `import { Container } from "@inferdi/inferdi";`];
  if (infraPath) lines.push(`import infraDi from "${rel(infraPath)}";`);
  for (const i of order) {
    const mod = mods[i]!;
    if (mod.di && mod.diPath)
      lines.push(`import ${mod.diVar} from "${rel(mod.diPath)}";`);
  }
  lines.push("", "export function buildRootContainer() {", "  return new Container()");
  const emit = (diExpr: string, key: string, e: DiEntry) => {
    if ("value" in e) {
      lines.push(
        `    .registerValue(${JSON.stringify(key)}, ${diExpr}.provides[${JSON.stringify(key)}].value)`,
      );
    } else {
      const lazy = lazyKeys.get(key);
      lines.push(
        `    .registerClass(${JSON.stringify(key)}, ${diExpr}.provides[${JSON.stringify(key)}].class, ` +
          `${JSON.stringify(e.deps)}, ${JSON.stringify(e.lifetime ?? "singleton")}` +
          (lazy ? `, ${JSON.stringify(lazy)}` : "") +
          `)`,
      );
    }
  };
  if (infra) for (const [k, e] of Object.entries(infra.provides)) emit("infraDi", k, e);
  for (const i of order) {
    const mod = mods[i]!;
    if (!mod.di) continue;
    lines.push(`    // ── ${mod.manifest.name} 模块 ──`);
    for (const [k, e] of Object.entries(mod.di.provides)) emit(mod.diVar, k, e);
  }
  lines.push(";", "}", "");
  writeFileSync(join(outDir, "container.gen.ts"), lines.join("\n") + "\n");
  written.push(".elysiax/container.gen.ts");

  // modules.gen.ts：真实 import 的模块清单
  const ml: string[] = [header, `import type { ModuleEntry } from "@elysiax/core";`];
  for (const mod of mods) {
    const n = mod.manifest.name;
    const id = ident(n);
    ml.push(`import ${id}Manifest from "${rel(join(mod.dir, "module.json"))}";`);
    if (mod.controller)
      ml.push(
        `import { ${camel(n)}Controller as ${id}Controller } from "${rel(mod.controller)}";`,
      );
    if (mod.ui) ml.push(`import ${id}Ui from "${rel(mod.ui)}";`);
  }
  ml.push("", "export const modules: Record<string, ModuleEntry> = {");
  for (const mod of mods) {
    const n = mod.manifest.name;
    const id = ident(n);
    const parts = [`manifest: ${id}Manifest`];
    if (mod.controller) parts.push(`controller: ${id}Controller`);
    if (mod.ui) parts.push(`ui: ${id}Ui`);
    ml.push(`  ${JSON.stringify(n)}: { ${parts.join(", ")} },`);
  }
  ml.push("};", "");
  writeFileSync(join(outDir, "modules.gen.ts"), ml.join("\n") + "\n");
  written.push(".elysiax/modules.gen.ts");

  // services.gen.ts：从 di 声明推导 ServiceMap（类型一体化，di 泛型可省）
  const sl: string[] = [
    header,
    `import type { Lazy } from "@inferdi/inferdi";`,
  ];
  if (infraPath) sl.push(`import type infraDi from "${rel(infraPath)}";`);
  for (const i of order) {
    const mod = mods[i]!;
    if (mod.di && mod.diPath)
      sl.push(`import type ${mod.diVar} from "${rel(mod.diPath)}";`);
  }
  sl.push(
    "",
    "type Provided<E> = E extends { class: infer C }",
    "  ? C extends new (...args: any[]) => infer I ? I : never",
    "  : E extends { value: infer V } ? V : never;",
    "",
    "type ProvidesOf<D> = D extends { provides: infer P }",
    "  ? { [K in keyof P]: Provided<P[K]> }",
    "  : {};",
    "",
  );
  const bases: string[] = [];
  if (infra) bases.push("ProvidesOf<typeof infraDi>");
  for (const i of order) {
    const mod = mods[i]!;
    if (mod.di) bases.push(`ProvidesOf<typeof ${mod.diVar}>`);
  }
  sl.push(`type BaseServices = ${bases.length ? bases.join(" & ") : "{}"};`);
  const lazyEntries = [...lazyKeys.values()].map((lk) => {
    const base = lk.slice(0, -4);
    return `  ${JSON.stringify(lk)}: Lazy<BaseServices[${JSON.stringify(base)}]>;`;
  });
  sl.push(
    "",
    "/** 全图服务类型：di.get() 的键与返回值由此推导 */",
    "export type ServiceMap = BaseServices & {",
    ...lazyEntries,
    "};",
    "",
  );
  writeFileSync(join(outDir, "services.gen.ts"), sl.join("\n") + "\n");
  written.push(".elysiax/services.gen.ts");

  // controller.gen.ts：defineController —— di 默认带全图 ServiceMap
  writeFileSync(
    join(outDir, "controller.gen.ts"),
    [
      header,
      `import type { Elysia } from "elysia";`,
      `import { elysiaxModule } from "@elysiax/core";`,
      `import type { ServiceMap } from "./services.gen";`,
      "",
      "/** 定义模块 controller：di 默认带全图 ServiceMap（可传更窄泛型收敛） */",
      "export function defineController<",
      "  S extends Record<string, unknown> = ServiceMap,",
      ">(options?: ConstructorParameters<typeof Elysia>[0]) {",
      "  return elysiaxModule<S>(options);",
      "}",
      "",
    ].join("\n"),
  );
  written.push(".elysiax/controller.gen.ts");

  // desktop.gen.ts：桌面入口（config.desktop 存在时；src/desktop.ts 可覆盖）
  if (config.desktop) {
    const d = config.desktop;
    writeFileSync(
      join(outDir, "desktop.gen.ts"),
      [
        header,
        `import { Webview, SizeHint } from "webview-bun";`,
        "",
        "// server 用独立进程跑：webview.run() 是阻塞式 FFI 事件循环，",
        "// 与 Bun 的 HTTP 事件循环不能同线程共存。编译后 spawn 自身 + --server。",
        `if (process.argv.includes("--server")) {`,
        `  await import(${JSON.stringify(rel(join(root, entry)))});`,
        "} else {",
        "  const isCompiled = !import.meta.path.endsWith(\".ts\");",
        "  const server = Bun.spawn(",
        "    isCompiled",
        "      ? [process.execPath, \"--server\"]",
        `      : [process.execPath, ${JSON.stringify(entry)}],`,
        "    { stdout: \"inherit\", stderr: \"inherit\" },",
        "  );",
        "",
        `  const port = Number(process.env.PORT ?? ${d.port ?? 3000});`,
        "  for (;;) {",
        "    try {",
        "      if ((await fetch(`http://localhost:${port}/`)).ok) break;",
        "    } catch {}",
        "    if (server.exitCode !== null) throw new Error(\"server 进程提前退出\");",
        "    await Bun.sleep(100);",
        "  }",
        "",
        "  const webview = new Webview(false, {",
        `    width: ${d.width ?? 1100},`,
        `    height: ${d.height ?? 720},`,
        "    hint: SizeHint.NONE,",
        "  });",
        `  webview.title = ${JSON.stringify(d.title ?? config.app?.name ?? "elysiax")};`,
        "  webview.navigate(`http://localhost:${port}/`);",
        "  webview.run(); // 阻塞直到窗口关闭",
        "  server.kill();",
        "  process.exit(0);",
        "}",
        "",
      ].join("\n"),
    );
    written.push(".elysiax/desktop.gen.ts");
  }

  // index.ts：桶文件
  writeFileSync(
    join(outDir, "index.ts"),
    [
      header,
      `export { modules } from "./modules.gen";`,
      `export { buildRootContainer } from "./container.gen";`,
      `export type { ServiceMap } from "./services.gen";`,
      `export { defineController } from "./controller.gen";`,
      "",
    ].join("\n"),
  );
  written.push(".elysiax/index.ts");

  return written;
}
