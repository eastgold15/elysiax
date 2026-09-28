import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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

const lazyBrand: unique symbol = Symbol.for("elysiax.lazy") as any;

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
  typeof v === "object" && v !== null && (v as any)[lazyBrand] === true;

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
    return lowerFirst((d as any).name);
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
  const entry = config.build?.entry ?? DEFAULTS.entry;
  const written: string[] = [];

  // 基础设施声明（可选）：src/infra.di.ts，永远最先装配
  const infraPath = await firstExisting(join(root, "src"), "infra.di");
  let infra: ModuleDi | undefined;
  if (infraPath) {
    infra = (await import(pathToFileURL(infraPath).href)).default as ModuleDi;
  }

  const mods: LoadedModule[] = [];
  // module.json 已可选：模块 = 含 <name>.di.ts / <name>.controller.* / <name>.ui.* 的目录
  const entries = readdirSync(join(root, modulesDir), { withFileTypes: true });
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
      di = (await import(pathToFileURL(diPath).href)).default as ModuleDi;
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
  for (const mod of mods) {
    const n = mod.manifest.name;
    if (!mod.controller) continue;
    const src = await Bun.file(mod.controller).text();
    const { prefix, paths } = extractRoutes(src, mod.manifest.route ?? `/${n}`);
    const entries: [string, string][] = [];
    for (const path of paths) {
      const sub = path === prefix ? "/" : path.slice(prefix.length);
      // /ui/detect → uiDetect；/domains/:id → domainsById；/ → index
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
    if (!entries.length) continue;
    rl.push(`  ${JSON.stringify(n)}: {`);
    for (const [name, fn] of entries) rl.push(`    ${name}: ${fn},`);
    rl.push("  },");
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
      `export type * from "./services.gen"; // ServiceMap + 每模块窄类型 <Name>Services`,
      `export { defineController } from "./controller.gen";`,
      `export { routes } from "./routes.gen"; // 类型化路径助手：hx-post={routes.x.y()}`,
      "",
    ].join("\n"),
  );
  written.push(".elysiax/index.ts");

  return written;
}
