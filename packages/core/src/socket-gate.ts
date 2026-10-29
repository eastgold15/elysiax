/**
 * 凹凸插座门禁（契约 §1.1 / §3）：跨原子引用只能指向对方插座 `<name>.socket.ts`，
 * 且插头引用的每个符号必须由插座真实导出。
 *
 * 为什么放在 core 而不是只留在 `elysiax doctor`：
 * 契约是约束谓词（跨原子 ⇒ 必须经插座），只在手动体检里强制等于「约束没进强制层」——
 * dev/gen/build 都会经过 codegen，门禁挂在这里才是真的拦得住；doctor 复用同一实现，
 * 手动体检与构建期判定不会漂移。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// 显式从 bun 取 Glob：core 的 tsconfig 只声明 types:["bun"]，全局名不在类型层
import { Glob } from "bun";

/** 剥离 // 行注释与 块注释（字符级状态机：字符串/模板串/正则里的 // 不误伤） */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null; // ' " ` 之一，null = 不在字符串里
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 按顶层逗号切分声明列表（忽略括号/方括号/花括号内部的逗号） */
export function splitDeclarators(list: string): string[] {
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
export function socketExports(
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

export interface SocketViolation {
  /** 违规文件（相对 root） */
  file: string;
  message: string;
}

export interface SocketGateResult {
  violations: SocketViolation[];
  /** 原子目录绝对路径（有 di/socket 文件的目录） */
  atomDirs: string[];
  /** 插座文件绝对路径（纯度检查用） */
  socketFiles: string[];
  /** 插座 → 导出符号（适配检查 / 出口只增不减用；key 为绝对路径） */
  symbols: Map<string, Set<string>>;
}

/**
 * 扫描 pagesDir 并返回全部违约项（不抛错：由调用方决定拦还是记）。
 * 判定口径与 doctor 完全一致：相对 import 与 `@/` 别名指向其他原子内部文件即违规；
 * 指向 `<name>.socket.ts` 但符号不存在 = 插头插不上。
 */
export async function checkSocketGate(root: string, pagesDir: string): Promise<SocketGateResult> {
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
  const symbols = new Map<string, Set<string>>();
  const symbolsOf = (sf: string) => {
    let syms = symbols.get(sf);
    if (!syms) {
      syms = socketExports(readFileSync(sf, "utf8"), (spec) =>
        spec.startsWith(".") ? resolveImport(sf, spec) : undefined,
      );
      symbols.set(sf, syms);
    }
    return syms;
  };

  const violations: SocketViolation[] = [];
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
        violations.push({
          file: f,
          message: `跨原子 import 绕过了插座（${spec}）——只允许指向对方的 <name>.socket.ts，被引用方请先把符号登记进插座`,
        });
        continue;
      }
      // 适配检查（符号级）：插头引用的每个符号，插座必须真实导出——
      // 源码分发场景下"接口对不上"在安装期就报出来，而不是运行时炸
      const named = /^\{([^}]*)\}/s.exec(clause.trim())?.[1];
      if (!named) continue; // default/namespace import：插座无 default（§3.1），tsc 会抓
      for (const part of named.split(",")) {
        const sym = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (!sym) continue;
        if (!symbolsOf(target).has(sym)) {
          violations.push({
            file: f,
            message: `插头插不上——插座 ${relativeSpec(root, target)} 没有导出 "${sym}"（插座出口被删/改名，或复制来的原子与对方插座版本不匹配）`,
          });
        }
      }
    }
  }
  return { violations, atomDirs: atomsDirs, socketFiles, symbols };
}

/** 违规信息里展示相对路径（root 外则原样） */
function relativeSpec(root: string, abs: string): string {
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
}
