import { Glob } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleManifest } from "./index";

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
  dir: string; // 相对 app 根，如 modules/user
  manifest: ModuleManifest;
  di?: ModuleDi;
  diPath?: string;
  controller?: string; // 相对 import 路径
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

/**
 * 扫描 modules/ 与 src/infra.di.ts，把复杂装配生成到 .elysiax/（类 .next 模式）。
 * 返回生成文件列表。
 */
export async function codegen(root = process.cwd()): Promise<string[]> {
  const mods: LoadedModule[] = [];

  // 基础设施声明（可选）：src/infra.di.ts，永远最先装配
  const infraPath = await firstExisting(join(root, "src"), "infra.di");
  let infra: ModuleDi | undefined;
  if (infraPath) {
    infra = (await import(pathToFileURL(infraPath).href)).default as ModuleDi;
  }

  for await (const m of new Glob("modules/*/module.json").scan({ cwd: root })) {
    const dir = join(root, m, "..");
    const manifest: ModuleManifest = await Bun.file(join(root, m)).json();
    const name = manifest.name;
    const mod: LoadedModule = { dir, manifest };

    mod.diPath = await firstExisting(dir, `${name}.di`);
    if (mod.diPath) {
      mod.di = (await import(pathToFileURL(mod.diPath).href)).default as ModuleDi;
    }
    mod.controller = await firstExisting(dir, `${name}.controller`);
    mod.ui = await firstExisting(dir, `${name}.ui`);
    mods.push(mod);
  }

  // ── 拓扑排序：dep 的提供者必须先装配 ──
  // provider: key → 提供它的模块下标（-1 = infra）
  const provider = new Map<string, number>();
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
      throw new Error(`依赖 "${dep}" 没有任何模块提供（检查 module.json / *.di.ts）`);
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

  // container.gen.ts：拓扑序的完整类型链
  const lines: string[] = [
    "// 由 elysiax codegen 生成，勿手改（elysiax dev / gen 会重新生成）",
    `import { Container } from "@inferdi/inferdi";`,
  ];
  if (infraPath) lines.push(`import infraDi from "${rel(infraPath)}";`);
  for (const i of order) {
    const mod = mods[i]!;
    if (mod.di && mod.diPath)
      lines.push(`import ${mod.manifest.name}Di from "${rel(mod.diPath)}";`);
  }
  lines.push("", "export function buildRootContainer() {", "  return new Container()");
  const emit = (diExpr: string, key: string, e: DiEntry) => {
    if ("value" in e) {
      lines.push(`    .registerValue(${JSON.stringify(key)}, ${diExpr}.provides[${JSON.stringify(key)}].value)`);
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
    for (const [k, e] of Object.entries(mod.di.provides))
      emit(`${mod.manifest.name}Di`, k, e);
  }
  lines.push(";", "}", "");
  writeFileSync(join(outDir, "container.gen.ts"), lines.join("\n") + "\n");

  // modules.gen.ts：真实 import 的模块清单（取代旧的 Bun 虚拟插件）
  const ml: string[] = [
    "// 由 elysiax codegen 生成，勿手改",
    `import type { ModuleEntry } from "@elysiax/core";`,
  ];
  const names: string[] = [];
  for (const mod of mods) {
    const n = mod.manifest.name;
    const id = n.replace(/-/g, "_");
    names.push(n);
    ml.push(`import ${id}Manifest from "${rel(join(mod.dir, "module.json"))}";`);
    if (mod.controller)
      ml.push(
        `import { ${n.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Controller as ${id}Controller } from "${rel(mod.controller)}";`,
      );
    if (mod.ui) ml.push(`import ${id}Ui from "${rel(mod.ui)}";`);
  }
  ml.push("", "export const modules: Record<string, ModuleEntry> = {");
  for (const mod of mods) {
    const n = mod.manifest.name;
    const id = n.replace(/-/g, "_");
    const parts = [`manifest: ${id}Manifest`];
    if (mod.controller) parts.push(`controller: ${id}Controller`);
    if (mod.ui) parts.push(`ui: ${id}Ui`);
    ml.push(`  ${JSON.stringify(n)}: { ${parts.join(", ")} },`);
  }
  ml.push("};", "");
  writeFileSync(join(outDir, "modules.gen.ts"), ml.join("\n") + "\n");

  // index.ts：桶文件，app 只需 import * as gen from "../.elysiax"
  writeFileSync(
    join(outDir, "index.ts"),
    [
      "// 由 elysiax codegen 生成，勿手改",
      `export { modules } from "./modules.gen";`,
      `export { buildRootContainer } from "./container.gen";`,
      "",
    ].join("\n"),
  );

  return ["container.gen.ts", "modules.gen.ts", "index.ts"].map((f) =>
    join(".elysiax", f),
  );
}
