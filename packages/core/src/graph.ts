/**
 * 依赖图：两套边，同一份事实来源。
 *
 * 1. **服务键级 DI 图**（key → 依赖 key）：容器装配顺序与环检测都以它为准。
 *    粒度必须落到 key：模块粒度会把一个原子里所有 provides 的依赖并成一条边，
 *    于是「canvas 里加一个只读 deploy 的叶子服务」会被判成 canvas↔deploy 环（假环）。
 *    key 级图上 `canvasBoardQuery → deployService → canvasService` 是一条链，不是环。
 *
 * 2. **原子级引用图**（原子 → 原子 / 原子 → shared 文件）：给 CLI 算依赖闭包用，
 *    决定「装这个原子要连带哪些原子、哪些共享文件」。
 *
 * 依赖不手维护：DI 边从 `*.di.ts` 的 provides.deps 读，引用边从源码 import 语句读。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
// 显式从 bun 取 Glob：core 的 tsconfig 只声明 types:["bun"]，全局名不在类型层
import { Glob } from "bun";
import type { ModuleDi } from "./codegen";
import { scanSource } from "./socket-gate";

/** Lazy 伴随键归一：`xxxLazy` 的依赖边连到基键 `xxx`（lazy 不打破环） */
export const stripLazy = (dep: string): string =>
  dep.endsWith("Lazy") ? dep.slice(0, -4) : dep;

/** 服务键图的输入：一个归属的一组 provides */
export interface ServiceGraphInput {
  /** 归属的唯一 id（模块下标 / "infra"） */
  id: string;
  /** 归属的显示名（原子名，报错用） */
  name: string;
  di: ModuleDi;
}

export interface ServiceGraph {
  /** key → 归属 id */
  owner: Map<string, string>;
  /** 归属 id → 显示名 */
  display: Map<string, string>;
  /** key → 依赖的基键列表（Lazy 已归一） */
  deps: Map<string, string[]>;
  /** key → 原始依赖键（保留 Lazy 后缀，报错用） */
  rawDeps: Map<string, string[]>;
  /** 拓扑序：依赖在依赖者之前（可直接当容器注册顺序） */
  order: string[];
  /** 环：服务键链路（首尾同键，闭合） */
  cycles: string[][];
  /** 缺失依赖：声明了但没有任何归属提供的键 */
  missing: { key: string; dep: string; base?: string }[];
}

/**
 * 建服务键级图并求拓扑序。
 * 值服务（db 等）没有出边，是叶子。
 */
export function buildServiceGraph(inputs: ServiceGraphInput[]): ServiceGraph {
  const owner = new Map<string, string>();
  const display = new Map<string, string>();
  const deps = new Map<string, string[]>();
  const rawDeps = new Map<string, string[]>();
  for (const input of inputs) {
    display.set(input.id, input.name);
    for (const [key, entry] of Object.entries(input.di.provides)) {
      const prev = owner.get(key);
      if (prev !== undefined && prev !== input.id)
        throw new Error(
          `[elysiax] 服务键 "${key}" 冲突：${display.get(prev) ?? prev} 与 ${input.name} 都提供它，` +
            `依赖方会静默注入后扫到的那个，请改名`,
        );
      owner.set(key, input.id);
      const raw = "class" in entry ? [...entry.deps] : [];
      rawDeps.set(key, raw);
      deps.set(
        key,
        raw.map(stripLazy),
      );
    }
  }

  // 缺失依赖：声明了但没人提供（Lazy 伴随键查基键）
  const missing: { key: string; dep: string; base?: string }[] = [];
  for (const [key, list] of rawDeps)
    for (const dep of list) {
      const base = stripLazy(dep);
      if (!owner.has(base))
        missing.push(
          dep === base ? { key, dep } : { key, dep, base },
        );
    }

  // DFS 求拓扑序 + 检环（key 粒度）
  const order: string[] = [];
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (key: string) => {
    const st = state.get(key) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      // 回边 → 环：记录从该键起的一段链路
      const at = stack.lastIndexOf(key);
      cycles.push([...stack.slice(at), key]);
      return;
    }
    state.set(key, 1);
    stack.push(key);
    for (const dep of deps.get(key) ?? []) if (owner.has(dep)) visit(dep);
    stack.pop();
    state.set(key, 2);
    order.push(key);
  };
  for (const key of owner.keys()) visit(key);

  return { owner, display, deps, rawDeps, order, cycles, missing };
}

// ── 原子级引用图（给 CLI 算依赖闭包） ──

/** 一个原子：目录 + 名字 */
export interface AtomInfo {
  /** 原子名（di 文件的 stem） */
  name: string;
  /** 绝对路径 */
  dir: string;
  /** 相对 root 的路径 */
  relDir: string;
}

/** 引用边：from 依赖 to */
export interface AtomEdge {
  from: string;
  to: string;
  kind: "di" | "import";
  /** kind=import 时的具体文件（相对 root） */
  via?: string;
}

export interface AtomGraph {
  atoms: AtomInfo[];
  /** 原子 → 原子的边 */
  edges: AtomEdge[];
  /** 原子 → src/shared 下的文件（相对 root） */
  shared: { from: string; file: string }[];
  /** 服务键级图（同一份事实，CLI 报环用） */
  services: ServiceGraph;
}

/** 解析 import 说明符到真实文件（相对 / `@/` 别名 / `@gen` 别名） */
export function resolveSpecifier(
  fromFile: string,
  spec: string,
  root: string,
): string | undefined {
  const clean = spec.replace(/[?#].*$/, "");
  const base = clean.startsWith("@gen")
    ? resolve(root, ".elysiax", clean.slice(4))
    : clean.startsWith("@/")
      ? resolve(root, "src", clean.slice(2))
      : resolve(fromFile, "..", clean);
  const stripped = base.replace(/\.(c|m)?jsx?$/, "");
  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ])
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  return undefined;
}

/**
 * 扫 pages 目录，建原子级引用图：
 * - DI 边：某原子的 provides 依赖了另一个原子提供的服务键
 * - import 边：某原子的源文件 import 了另一个原子的文件（跨原子只准走插座，门禁另有判定）
 * - shared 引用：import 落在 src/shared/ 下的文件
 */
export async function buildAtomGraph(
  root: string,
  pagesDir: string,
  services: ServiceGraph,
  /** 归属 id → 原子名（DI 边连到原子名而不是 id） */
  ownerName: (id: string) => string,
): Promise<AtomGraph> {
  // 原子 = 含 *.di.ts 的目录（含嵌套原子）
  const diFiles: string[] = [];
  for await (const f of new Glob(`${pagesDir}/**/*.di.ts`).scan({ cwd: root }))
    diFiles.push(resolve(root, f));
  const atomDirs = diFiles.map((p) => resolve(p, ".."));
  const atoms: AtomInfo[] = diFiles.map((p) => ({
    name: p.slice(p.lastIndexOf("/") + 1).replace(/\.di\.ts$/, ""),
    dir: resolve(p, ".."),
    relDir: resolve(p, "..").slice(root.length + 1),
  }));

  /** 原子目录 → 原子名 */
  const nameByDir = new Map<string, string>();
  atoms.forEach((a, i) => nameByDir.set(a.dir, a.name));

  /** 文件 → 所属原子名（取最深的含 di 的目录） */
  const atomOf = (file: string): string | undefined => {
    const dir = atomDirs
      .filter((a) => file.startsWith(`${a}/`))
      .sort((a, b) => b.length - a.length)[0];
    return dir ? nameByDir.get(dir) : undefined;
  };

  const edges: AtomEdge[] = [];
  const shared: { from: string; file: string }[] = [];

  // DI 边：服务键的归属 ≠ 使用者 → 依赖边
  for (const [key, depList] of services.deps) {
    const user = services.owner.get(key);
    if (!user) continue;
    for (const dep of depList) {
      const provider = services.owner.get(dep);
      if (!provider || provider === user) continue;
      edges.push({ from: ownerName(user), to: ownerName(provider), kind: "di" });
    }
  }

  // import 边：扫源码里的 import 语句
  for await (const f of new Glob(`${pagesDir}/**/*.{ts,tsx}`).scan({ cwd: root })) {
    const abs = resolve(root, f);
    const srcAtom = atomOf(abs);
    if (!srcAtom) continue;
    const { code, isCode } = scanSource(readFileSync(abs, "utf8"));
    const startsInCode = (m: RegExpMatchArray) => {
      const text = m[0];
      const lead = text.length - text.trimStart().length;
      return isCode[(m.index ?? 0) + lead] === true;
    };
    for (const m of code.matchAll(
      /^\s*(?:import\s+(?:type\s+)?[^"']*?from|export\s+(?:type\s+)?[^"']*?from|import)\s*["']([^"']+)["']/gm,
    )) {
      if (!startsInCode(m)) continue;
      const spec = m[1]!;
      if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
      const target = resolveSpecifier(abs, spec, root);
      if (!target) continue;
      if (target.includes("/src/shared/")) {
        const file = target.slice(root.length + 1);
        if (!shared.some((s) => s.from === srcAtom && s.file === file))
          shared.push({ from: srcAtom, file });
        continue;
      }
      const tgtAtom = atomOf(target);
      if (!tgtAtom || tgtAtom === srcAtom) continue;
      edges.push({ from: srcAtom, to: tgtAtom, kind: "import", via: f });
    }
  }

  return { atoms, edges, shared, services };
}
