import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleManifest } from "./index";
import { DEFAULTS, loadConfig, type ElysiaxConfig } from "./config";

/**
 * 模块 DI 声明条目（<name>.di.ts 的 provides 值，defineModule 归一化后的形态）：
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

// ── provide / lazy：类引用代替字符串依赖（编译期校验 + 重构可跟随） ──

// Symbol.for 返回 symbol 而非 unique symbol，注解断言是官方唯一途径
const lazyBrand: unique symbol = Symbol.for(
  "elysiax.lazy",
) as typeof lazyBrand;

/** `lazy(Class)` 的返回物：标记该依赖走 Lazy 伴随键（对应字符串约定 "xxxLazy"） */
export interface LazyRef<T> {
  readonly [lazyBrand]: true;
  readonly cls: abstract new (...args: any[]) => T;
}

/**
 * 显式声明一个懒加载依赖，替代 `"xxxLazy"` 字符串约定：
 *
 * ```ts
 * provide(UserService, [UserRepository, lazy(OrderService)])
 * // 等价于 deps: ["userRepository", "orderServiceLazy"]
 * ```
 */
export function lazy<C extends abstract new (...args: any[]) => any>(
  cls: C,
): LazyRef<InstanceType<C>> {
  return { [lazyBrand]: true, cls } as LazyRef<InstanceType<C>>;
}

const isLazyRef = (v: unknown): v is LazyRef<unknown> =>
  typeof v === "object" &&
  v !== null &&
  (v as Record<symbol, unknown>)[lazyBrand] === true;

/** 依赖槽位类型：Lazy<X> 参数 → lazy(X)；其他对象 → 类引用；值服务（db 等）→ 字符串键 */
type DepItem<T> =
  | ([T] extends [import("@inferdi/inferdi").Lazy<infer U>]
    ? LazyRef<U>
    : [T] extends [object]
    ? abstract new (...args: any[]) => T
    : never)
  | (string & {});

/** 从类构造函数签名推导依赖元组：写错类型/顺序直接编译报错 */
type MapDeps<T extends readonly unknown[]> = { [K in keyof T]: DepItem<T[K]> };
type DepsOf<C extends new (...args: any[]) => any> = MapDeps<ConstructorParameters<C>>;

export interface ProvideOptions {
  lifetime?: "singleton" | "transient";
}

/** defineModule 接受的 provides 值（归一化前） */
export type DiEntryInput =
  | DiEntry
  | (new (...args: any[]) => unknown) // 简写：零依赖的类
  | {
    class: new (...args: any[]) => unknown;
    deps: readonly (string | (abstract new (...args: any[]) => unknown) | LazyRef<unknown>)[];
    lifetime?: "singleton" | "transient";
  };

/**
 * 声明一个服务：依赖写类引用而非字符串，类型从构造函数签名推导。
 *
 * ```ts
 * provide(ProjectRepository)                        // 零依赖
 * provide(ProjectService, [ProjectRepository])      // 依赖按构造函数顺序
 * provide(UserService, [UserRepository, lazy(OrderService)])
 * ```
 */
export function provide<C extends new (...args: any[]) => any>(
  cls: C,
  opts?: ProvideOptions,
): { class: C; deps: readonly []; lifetime?: "singleton" | "transient" };
export function provide<C extends new (...args: any[]) => any>(
  cls: C,
  deps: DepsOf<C>,
  opts?: ProvideOptions,
): { class: C; deps: DepsOf<C>; lifetime?: "singleton" | "transient" };
export function provide(cls: any, a?: any, b?: any): any {
  const deps = Array.isArray(a) ? a : [];
  const opts = Array.isArray(a) ? b : a;
  return { class: cls, deps, lifetime: opts?.lifetime };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** 把类引用/lazy 标记归一化成字符串键（camelCase 类名，lazy 加 Lazy 后缀） */
function normalizeEntry(key: string, e: DiEntryInput): DiEntry {
  if (typeof e === "function") {
    if (lowerFirst(e.name) !== key) warnKeyMismatch(key, e.name);
    return { class: e, deps: [] };
  }
  if ("value" in e) return e;
  const deps: string[] = e.deps.map((d): string => {
    if (typeof d === "string") return d;
    if (isLazyRef(d)) return `${lowerFirst(d.cls.name)}Lazy`;
    return lowerFirst(d.name);
  });
  if (lowerFirst(e.class.name) !== key) warnKeyMismatch(key, e.class.name);
  return { class: e.class, deps, lifetime: e.lifetime };
}

function warnKeyMismatch(key: string, className: string) {
  console.warn(
    `[elysiax] provides 键 "${key}" 与类名推导键 "${lowerFirst(className)}" 不一致，` +
    `其他模块必须用 "${key}" 才能注入`,
  );
}

/** codegen 消费的形态：provides 已归一化（deps 全是字符串键） */
export interface ModuleDi {
  /** 模块名（默认取目录名）；有 name/route 后 module.json 可整个删掉 */
  name?: string;
  /** 路由前缀（默认 `/${name}`） */
  route?: string;
  version?: string;
  provides: Record<string, DiEntry>;
}

/** defineModule 的输入形态：deps 可以是类引用 / lazy() / 字符串 */
export interface ModuleDiInput extends Omit<ModuleDi, "provides"> {
  provides: Record<string, DiEntryInput>;
}

/**
 * 声明一个模块（或 infra）向容器提供什么。仅收集声明，装配由 codegen 生成。
 * 依赖里的类引用 / lazy() 在声明时归一化成字符串键，codegen 逻辑不变。
 */
export function defineModule<T extends ModuleDiInput>(di: T): T {
  const provides = Object.fromEntries(
    Object.entries(di.provides).map(([k, e]) => [k, normalizeEntry(k, e)]),
  );
  // 运行时归一化成 ModuleDi；类型上保留输入形态供 services.gen 推导
  return { ...di, provides } as unknown as T;
}

/**
 * 导入并校验 di 声明文件（契约 §1.1：必须 default export defineModule({ route, provides })）。
 * 缺 default export / provides 不是对象时给出指向契约的清晰报错，
 * 而不是让后续 Object.keys(undefined) 抛出费解的运行时错误。
 */
async function loadDi(diPath: string, root: string): Promise<ModuleDi> {
  const mod = (await import(pathToFileURL(diPath).href)) as { default?: unknown };
  const di = mod.default as ModuleDi | undefined;
  if (!di || typeof di !== "object" || typeof di.provides !== "object" || di.provides === null) {
    throw new Error(
      `[elysiax] ${relative(root, diPath)} 必须 default export defineModule({ route, provides })` +
      `（契约 §1.1：di 文件是模块身份证，codegen 据此自动发现）`,
    );
  }
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
const pascalCase = (s: string) => s.charAt(0).toUpperCase() + camel(s).slice(1);
const ident = (s: string) => s.replace(/-/g, "_");

// ── 页面扫描（page-architecture.md：module → page，URL = 文件夹路径） ──

const PAGE_FILE_RE = /^(.+)\.(page|partials|actions)\.tsx?$/;
const DI_FILE_RE = /^(.+)\.di\.ts$/;
const LEGACY_RE = /^.+\.(controller|ui)\.tsx?$/;

/** 一个页面组：同目录同 stem 的 page/partials/actions + 可选 client/ */
export interface LoadedPage {
  stem: string;
  url: string;
  page?: string;
  partials?: string;
  actions?: string;
  clientIndex?: string;
}

interface PageScan {
  pages: LoadedPage[];
  /** 页面树里的 DI 声明（与模块 di 一视同仁进拓扑排序） */
  dis: { stem: string; path: string }[];
}

/**
 * 递归扫描 pages 目录：
 * - `[id]` 目录段 → `:id`；下划线/点开头跳过；`client/` 是页面标记不进 URL
 * - stem 规则：`index.page.tsx` 或 `<目录名>.page.tsx` → 目录 URL；
 *   其他 `<x>.page.tsx` → 目录 URL + /x
 * - 目录含 `client/index.tsx` → client 模式（L5 逃生舱）
 * - 检测到 .controller./.ui. 旧约定文件 → 直接报错（P2-4 起拒绝）
 */
async function scanPages(root: string, pagesDir: string): Promise<PageScan> {
  const base = join(root, pagesDir);
  const groups = new Map<string, LoadedPage>();
  const dis: PageScan["dis"] = [];
  const legacy: string[] = [];
  if (!existsSync(base)) return { pages: [], dis };

  const groupOf = (dir: string, urlPrefix: string, stem: string) => {
    const dirBase = basename(dir);
    const url =
      stem === "index" || stem === dirBase
        ? urlPrefix || "/"
        : `${urlPrefix}/${stem}`;
    const key = `${dir}#${stem}`;
    let g = groups.get(key);
    if (!g) {
      g = { stem, url };
      groups.set(key, g);
    }
    return g;
  };

  const walk = async (dir: string, urlPrefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "client") continue;
        const seg =
          entry.name.startsWith("[") && entry.name.endsWith("]")
            ? `:${entry.name.slice(1, -1)}`
            : entry.name;
        await walk(full, `${urlPrefix}/${seg}`);
        continue;
      }
      if (LEGACY_RE.test(entry.name)) {
        legacy.push(full);
        continue;
      }
      const diM = entry.name.match(DI_FILE_RE);
      if (diM) {
        dis.push({ stem: diM[1]!, path: full });
        continue;
      }
      const m = entry.name.match(PAGE_FILE_RE);
      if (!m) continue;
      const [, stem, kind] = m as unknown as [string, string, "page" | "partials" | "actions"];
      groupOf(dir, urlPrefix, stem)[kind] = full;
    }
    // client/index.tsx 标记本目录（dirBase 组）为 client 模式
    for (const ext of ["tsx", "ts"]) {
      const ci = join(dir, "client", `index.${ext}`);
      if (existsSync(ci)) {
        const g = groupOf(dir, urlPrefix, basename(dir));
        g.clientIndex = ci;
        break;
      }
    }
  };
  await walk(base, "");

  // URL 冲突校验：不同页面组推导出同一 URL 时挂载结果不可预测，直接报错
  const urlOwner = new Map<string, string>();
  for (const [key, p] of groups) {
    const prev = urlOwner.get(p.url);
    if (prev)
      throw new Error(
        `[elysiax] 页面 URL "${p.url}" 重复："${prev}" 与 "${key.replace(`${base}/`, "")}" 都映射到它，` +
        `请调整目录结构或页面文件名（URL = 文件夹路径 + stem）`,
      );
    urlOwner.set(p.url, key.replace(`${base}/`, ""));
  }

  // P2-4：旧约定从警告升级为拒绝——controller/ui 形态已被页面约定取代
  if (legacy.length)
    throw new Error(
      `[elysiax] 检测到已废弃的 .controller./.ui. 文件，请迁移到页面约定` +
      `（.page.tsx 整页 / .partials.tsx hx 片段 / .actions.ts 写端点）:\n` +
      legacy.map((p) => `  - ${relative(root, p)}`).join("\n"),
    );

  return { pages: [...groups.values()], dis };
}

/** client 页壳 HTML 的 slug：URL 段拼合（/projects/:id/env → projects_id_env） */
const shellSlug = (url: string) =>
  url.split("/").filter(Boolean).join("_").replaceAll(":", "") || "root";

/** 从 controller 源码提取路由。负向后瞻排除 di.get("...")；只认 "/" 开头字面量 */
export function extractRoutes(
  src: string,
  fallbackPrefix: string,
): { prefix: string; paths: string[] } {
  const prefixMatch = src.match(
    /defineController(?:<[^>]*>)?\(\s*\{\s*prefix:\s*["'`]([^"'`]+)["'`]/,
  );
  const prefix = prefixMatch?.[1] ?? fallbackPrefix;
  const routeRe =
    /(?<![\w$])\.(?:get|post|put|patch|delete|ui)\(\s*["'`](\/[^"'`]*)["'`]/g;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(routeRe)) {
    const sub = m[1]!;
    const path = sub === "/" ? prefix : `${prefix}${sub}`;
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return { prefix, paths };
}

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
  const pagesDir = config.pages ?? DEFAULTS.pages;
  const entry = config.build?.entry ?? DEFAULTS.entry;
  const written: string[] = [];

  // 页面树扫描（新约定）：URL = 文件夹路径，页面文件夹内聚一切
  const pageScan = await scanPages(root, pagesDir);

  // 基础设施声明（可选）：src/infra.di.ts，永远最先装配
  const infraPath = await firstExisting(join(root, "src"), "infra.di");
  let infra: ModuleDi | undefined;
  if (infraPath) {
    infra = await loadDi(infraPath, root);
  }

  const mods: LoadedModule[] = [];
  // module.json 已可选：模块 = 含 <name>.di.ts / <name>.controller.* / <name>.ui.* 的目录
  // 旧约定目录可整个不存在（pages/ 一统后 dockyard 已无 src/modules）
  const entries = existsSync(join(root, modulesDir))
    ? readdirSync(join(root, modulesDir), { withFileTypes: true })
    : [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, modulesDir, entry.name);
    const manifestPath = join(dir, "module.json");
    const manifestJson: Partial<ModuleManifest> = (await Bun.file(manifestPath).exists())
      ? await Bun.file(manifestPath).json()
      : {};
    const name = manifestJson.name ?? entry.name;
    // 先按清单名找 di，找不到再按目录名兜底（清单可整个不存在）
    let diPath = await firstExisting(dir, `${name}.di`);
    diPath ??= await firstExisting(dir, `${entry.name}.di`);
    const controller = await firstExisting(dir, `${name}.controller`);
    const ui = await firstExisting(dir, `${name}.ui`);
    // 目录里什么模块特征都没有 → 不是模块，跳过
    if (!diPath && !controller && !ui && !manifestJson.name) continue;

    let di: ModuleDi | undefined;
    if (diPath) {
      di = await loadDi(diPath, root);
    }
    // di 声明优先，module.json 兜底，最后默认值
    const manifest: ModuleManifest = {
      name: di?.name ?? name,
      version: di?.version ?? manifestJson.version ?? "0.0.0",
      route: di?.route ?? manifestJson.route,
      provides: manifestJson.provides,
      requires: manifestJson.requires,
    };
    const mod: LoadedModule = { dir, manifest, di, diPath, diVar: `${ident(manifest.name)}Di`, controller, ui };
    mods.push(mod);
  }

  // 页面树里的 di 声明：与模块 di 一视同仁进拓扑排序（纯服务文件夹 = 无
  // page/partials/actions 只有 di 的目录，deploy/edge/github 即此形态）
  for (const d of pageScan.dis) {
    const di = await loadDi(d.path, root);
    const dir = join(d.path, "..");
    // 契约 §1.1/§3：原子对外暴露能力时必须提供 <name>.socket.ts 唯一插座。
    // 触发条件：目录有 schema.ts（表锚点要出口）或 di 提供了类服务（供外原子注入）。
    // 纯值服务聚合（如 infra）不强制。
    const needsSocket =
      existsSync(join(dir, "schema.ts")) ||
      Object.values(di.provides).some((e) => "class" in e);
    if (needsSocket && !(await firstExisting(dir, `${d.stem}.socket`))) {
      throw new Error(
        `[elysiax] 原子 "${d.stem}" 缺少 ${d.stem}.socket.ts（契约 §3：socket 是唯一对外插座，` +
        `跨原子 import 只能走它）。目录 ${relative(root, dir)} 含 schema.ts 或 di 提供类服务时必须提供。`,
      );
    }
    const name = di.name ?? d.stem;
    mods.push({
      dir,
      manifest: { name, version: di.version ?? "0.0.0", route: di.route },
      di,
      diPath: d.path,
      diVar: `${ident(name)}Di`,
    });
  }

  // route 冲突校验：两个原子声明同一路由前缀会导致请求落点不确定，直接报错
  {
    const routeOwner = new Map<string, string>();
    for (const mod of mods) {
      const route = mod.manifest.route ?? `/${mod.manifest.name}`;
      const prev = routeOwner.get(route);
      if (prev)
        throw new Error(
          `[elysiax] route "${route}" 重复：原子 "${prev}" 与 "${mod.manifest.name}" 都声明了它，` +
          `请在各自的 <name>.di.ts 里换用不同 route`,
        );
      routeOwner.set(route, mod.manifest.name);
    }
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
    // module.json 可选：文件在就 import，不在就内联清单字面量
    const manifestPath = join(mod.dir, "module.json");
    if (await Bun.file(manifestPath).exists()) {
      ml.push(`import ${id}Manifest from "${rel(manifestPath)}";`);
    } else {
      ml.push(
        `const ${id}Manifest = { name: ${JSON.stringify(n)}, version: ${JSON.stringify(mod.manifest.version)}` +
        (mod.manifest.route ? `, route: ${JSON.stringify(mod.manifest.route)}` : "") +
        ` };`,
      );
    }
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

  // pages.gen.ts：页面路由表 + 真实 import；client 页额外生成壳 HTML
  if (pageScan.pages.length) {
    const shellsDir = join(outDir, "shells");
    const pl: string[] = [
      header,
      `import type { PageEntry } from "@elysiax/core";`,
    ];
    const entries: string[] = [];
    let idx = 0;
    // client 页的全局样式（默认 src/global.css，config.clientCss 可覆盖）
    const clientCss = config.clientCss ?? "src/global.css";
    const cssPath = join(root, clientCss);
    for (const p of pageScan.pages) {
      const i = idx++;
      const parts: string[] = [`url: ${JSON.stringify(p.url)}`];
      if (p.clientIndex) {
        parts.push("client: true");
        mkdirSync(shellsDir, { recursive: true });
        const slug = shellSlug(p.url);
        const cssLink = existsSync(cssPath)
          ? `    <link rel="stylesheet" href="${relative(shellsDir, cssPath).replaceAll("\\", "/")}" />\n`
          : "";
        writeFileSync(
          join(shellsDir, `${slug}.html`),
          [
            "<!doctype html>",
            `<html lang="zh-CN">`,
            `  <head>`,
            `    <meta charset="utf-8" />`,
            `    <meta name="viewport" content="width=device-width, initial-scale=1" />`,
            cssLink.trimEnd(),
            `  </head>`,
            `  <body>`,
            `    <div id="root"></div>`,
            `    <script type="module" src="${relative(shellsDir, p.clientIndex).replaceAll("\\", "/")}"></script>`,
            `  </body>`,
            `</html>`,
            "",
          ].filter((l) => l !== "").join("\n"),
        );
        pl.push(`import shell${i} from "./shells/${slug}.html";`);
        parts.push(`shell: shell${i}`);
      }
      if (p.page) {
        pl.push(`import page${i} from "${rel(p.page)}";`);
        parts.push(`page: page${i}`);
      }
      if (p.partials) {
        pl.push(`import partials${i} from "${rel(p.partials)}";`);
        parts.push(`partials: partials${i}`);
      }
      if (p.actions) {
        pl.push(`import actions${i} from "${rel(p.actions)}";`);
        parts.push(`actions: actions${i}`);
      }
      entries.push(`  { ${parts.join(", ")} },`);
    }
    pl.push("", "export const pages: PageEntry[] = [", ...entries, "];", "");
    writeFileSync(join(outDir, "pages.gen.ts"), pl.join("\n") + "\n");
    written.push(".elysiax/pages.gen.ts");
  }

  // routes.gen.ts：静态解析 controller 源码里的字面量路由，生成类型化路径助手。
  // hx-post={routes.deploy.uiDetect()} —— 改路由/前缀时 TSX 编译报错，不再静默 404。
  // （不 import controller：controller → .elysiax → modules.gen → controller 存在循环）
  const apiPrefix = config.apiPrefix ?? "/api";
  const rl: string[] = [
    header,
    "/** 路径参数 */",
    "type P = string | number;",
    "",
    "export const routes = {",
  ];
  // 由完整路径（已含挂载前缀）生成类型化助手条目：
  // /ui/detect → uiDetect；/domains/:id → domainsById；/ → index
  const buildEntries = (prefix: string, paths: string[]): [string, string][] => {
    const entries: [string, string][] = [];
    for (const path of paths) {
      const sub = path === prefix ? "/" : path.slice(prefix.length);
      const parts = sub.split("/").filter(Boolean);
      let name = "index";
      const params: string[] = [];
      if (parts.length) {
        name = parts
          .map((p, i) => {
            if (p.startsWith(":")) {
              params.push(p.slice(1));
              return `By${pascalCase(p.slice(1))}`;
            }
            if (p === "*") return "Wildcard";
            return i === 0 ? camel(p) : pascalCase(p);
          })
          .join("");
      }
      const sig = params.map((p) => `${p}: P`).join(", ");
      const body = path.replaceAll(/:([^/]+)/g, (_, p) => `\${${p}}`);
      entries.push([name, `(${sig}) => \`${apiPrefix}${body}\``]);
    }
    return entries;
  };
  for (const mod of mods) {
    const n = mod.manifest.name;
    if (!mod.controller) continue;
    const src = await Bun.file(mod.controller).text();
    const { prefix, paths } = extractRoutes(src, mod.manifest.route ?? `/${n}`);
    const entries = buildEntries(prefix, paths);
    if (!entries.length) continue;
    rl.push(`  ${JSON.stringify(n)}: {`);
    for (const [name, fn] of entries) rl.push(`    ${name}: ${fn},`);
    rl.push("  },");
  }
  // 页面路由：page → 自然 URL；partials/actions → /api<页面URL>（7.1/7.2）
  if (pageScan.pages.length) {
    rl.push(`  pages: {`);
    const usedPageKeys = new Set<string>();
    for (const p of pageScan.pages) {
      const key = camel(p.stem);
      if (usedPageKeys.has(key))
        throw new Error(
          `页面路由助手键冲突：多个页面 stem 都是 "${p.stem}"（${p.url}），` +
          `routes.pages.${key} 无法区分，请给页面文件换名`,
        );
      usedPageKeys.add(key);
      rl.push(`    ${JSON.stringify(key)}: {`);
      const emitted = new Set<string>(["page"]);
      if (p.page || p.clientIndex) {
        const body = p.url.replaceAll(/:([^/]+)/g, (_, pm) => `\${${pm}}`);
        const params = [...p.url.matchAll(/:([^/]+)/g)].map((m) => m[1]);
        const sig = params.map((pm) => `${pm}: P`).join(", ");
        rl.push(`      page: (${sig}) => \`${body}\`,`);
      }
      for (const kind of ["partials", "actions"] as const) {
        const file = p[kind];
        if (!file) continue;
        const src = await Bun.file(file).text();
        const { paths } = extractRoutes(src, p.url);
        for (const [name, fn] of buildEntries(p.url, paths)) {
          // GET /config（partials）与 POST /config（actions）同名同 URL：
          // 助手只返路径，重名即重复，跳过后者
          if (emitted.has(name)) continue;
          emitted.add(name);
          rl.push(`      ${name}: ${fn},`);
        }
      }
      rl.push(`    },`);
    }
    rl.push(`  },`);
  }
  rl.push("} as const;", "");
  writeFileSync(join(outDir, "routes.gen.ts"), rl.join("\n") + "\n");
  written.push(".elysiax/routes.gen.ts");

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
    "  : E extends { value: infer V } ? V",
    "  : E extends new (...args: any[]) => infer I ? I : never;",
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

  // 每模块窄类型：<Name>Services = 本模块 provides ∪ 直接 deps，
  // defineController<ProjectsServices> 可把 di 收敛到模块声明的边界内
  for (const mod of mods) {
    if (!mod.di) continue;
    const keys = new Set<string>(Object.keys(mod.di.provides));
    for (const dep of depsOf(mod.di)) keys.add(dep);
    const typeName = `${mod.manifest.name.charAt(0).toUpperCase()}${ident(mod.manifest.name).slice(1)}Services`;
    sl.push(
      `/** ${mod.manifest.name} 模块的窄 ServiceMap：defineController<${typeName}> 收敛 di */`,
      `export type ${typeName} = Pick<ServiceMap, ${[...keys].map((k) => JSON.stringify(k)).join(" | ")}>;`,
      "",
    );
  }
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
      "/** 定义模块 controller：di 默认带全图 ServiceMap；传 services.gen 的 <Name>Services 窄泛型可收敛到模块边界 */",
      "export function defineController<",
      "  S extends Record<string, unknown> = ServiceMap,",
      ">(options?: ConstructorParameters<typeof Elysia>[0]) {",
      "  return elysiaxModule<S>(options);",
      "}",
      "",
      "/** 页面 partials/actions 的子路由工厂：同 defineController，但不带 prefix（挂载点 = /api<页面URL>，由页面目录推导） */",
      "export function defineRoutes<",
      "  S extends Record<string, unknown> = ServiceMap,",
      ">() {",
      "  return elysiaxModule<S>();",
      "}",
      "",
    ].join("\n"),
  );
  written.push(".elysiax/controller.gen.ts");

  // assets.gen.ts：SSR 页面的全局样式（AppLayout 引用的固定 URL
  // /api/assets/global.css 由 start() 服务）。HTMLBundle 的资产走 /_bun/
  // 哈希路径 SSR 拿不到，故编译产物内联成文本——dev 与 bun --compile
  // 二进制（文本随包嵌入）都可用。有 bun-plugin-tailwind 就用它编译。
  {
    const cssFile = join(root, config.clientCss ?? "src/global.css");
    if (existsSync(cssFile)) {
      let cssText: string;
      try {
        const pluginPath = Bun.resolveSync("bun-plugin-tailwind", root);
        const tailwind = (await import(pluginPath)).default;
        const out = await Bun.build({
          entrypoints: [cssFile],
          plugins: [tailwind],
          throw: true,
        });
        cssText = await out.outputs[0]!.text();
      } catch {
        cssText = await Bun.file(cssFile).text(); // 无插件/编译失败 → 原样服务
      }
      writeFileSync(
        join(outDir, "assets.gen.ts"),
        [
          header,
          "/** AppLayout 引用的全局样式（start() 服务在 /api/assets/global.css） */",
          `export const globalCss: string = ${JSON.stringify(cssText)};`,
          "",
        ].join("\n"),
      );
      written.push(".elysiax/assets.gen.ts");
    }
  }

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
      `export type * from "./services.gen"; // ServiceMap + 每模块窄类型 <Name>Services`,
      `export { defineController, defineRoutes } from "./controller.gen";`,
      `export { routes } from "./routes.gen"; // 类型化路径助手：hx-post={routes.x.y()}`,
      ...(pageScan.pages.length
        ? [`export { pages } from "./pages.gen"; // 页面路由表（PageEntry[]）`]
        : []),
      ...(written.includes(".elysiax/assets.gen.ts")
        ? [`export { globalCss } from "./assets.gen"; // AppLayout 全局样式文本`]
        : []),
      "",
    ].join("\n"),
  );
  written.push(".elysiax/index.ts");

  return written;
}
