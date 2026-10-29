/**
 * 凹凸插座门禁（契约 §1.1 / §3）：跨原子引用只能指向对方插座 `<name>.socket.ts`，
 * 且插头引用的每个符号必须由插座真实导出。
 *
 * 为什么放在 core 而不是只留在 `elysiax doctor`：
 * 契约是约束谓词（跨原子 ⇒ 必须经插座），只在手动体检里强制等于「约束没进强制层」——
 * dev/gen/build 都会经过 codegen，门禁挂在这里才是真的拦得住；doctor 复用同一实现，
 * 手动体检与构建期判定不会漂移。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
// 显式从 bun 取 Glob：core 的 tsconfig 只声明 types:["bun"]，全局名不在类型层
import { Glob } from "bun";

/**
 * 词法预扫描结果：`code` 与源码等长（注释字符换成空格，换行保留），
 * `isCode[i]` = 第 i 个字符是否属于「会被执行的代码」（字符串/模板/正则内容为 false）。
 *
 * 为什么需要 isCode：注释剥离只能解决「注释里写了 import 示例」，
 * 模板串与 JSX 文本里的示例 `import` 同样是纯文本——行首锚定正则会把它当真。
 * 扫描 import 前先查 keyword 位置是否在代码区，才不会被文本骗到。
 */
export interface SourceScan {
  code: string;
  isCode: boolean[];
}

/** 这些字符之后出现的 `/` 是正则开头（而不是除号） */
const REGEX_PREV_CHARS = new Set([..."(,=:;!&|?{}[]<>+-*%~^"]);
/** 这些关键字之后出现的 `/` 是正则开头 */
const REGEX_PREV_WORDS = new Set([
  "return", "typeof", "case", "delete", "void", "instanceof", "in", "of", "new", "do", "else", "yield", "await",
]);
const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * 字符级词法扫描（不追求完整解析，只保证门禁要用的三类判定正确）：
 * - 注释：内容换空格、换行保留（行首锚点在注释后仍可用）
 * - 字符串：' " 不跨行（TSX 文本里的撇号不会把状态带出这一行）；模板串可跨行
 * - 正则字面量：`/[/*]/` 不会被当成块注释开头（按前一个 token 判断正则 vs 除号）
 *
 * 不用 Bun.Transpiler.scan 兜底：它在转译期擦掉 type-only import/export，
 * 而本门禁明确要求类型 import 同样算跨原子引用（类型也是契约）。
 */
export function scanSource(src: string): SourceScan {
  const code = src.split("");
  const isCode = new Array<boolean>(src.length).fill(true);
  /** 把 [start, end) 标为非代码区；blank 额外把注释内容换成空格（换行保留） */
  const mask = (start: number, end: number) => {
    for (let k = start; k < end && k < src.length; k++) isCode[k] = false;
  };
  const blank = (start: number, end: number) => {
    for (let k = start; k < end && k < src.length; k++) {
      isCode[k] = false;
      if (code[k] !== "\n") code[k] = " ";
    }
  };
  let prevChar = ""; // 最近一个代码字符（空白不算）
  let word = ""; // 紧邻当前位置的代码单词（用于 return /re/）
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "\n") {
      word = "";
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // ── 注释 ──
    if (c === "/" && next === "/") {
      const start = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    if (c === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, src.length);
      blank(start, i);
      continue;
    }
    // ── 字符串 / 模板串 ──
    if (c === "'" || c === '"') {
      const quote = c;
      let k = i + 1;
      while (k < src.length && src[k] !== quote && src[k] !== "\n") {
        if (src[k] === "\\") k++;
        k++;
      }
      // 跨行未闭合 = 大概率是 JSX 文本里的撇号：只吞到行尾，状态就此结束
      mask(i + 1, k);
      prevChar = quote;
      word = "";
      i = src[k] === quote ? k + 1 : k;
      continue;
    }
    if (c === "`") {
      let k = i + 1;
      while (k < src.length && src[k] !== "`") {
        if (src[k] === "\\") k++;
        k++;
      }
      const closed = src[k] === "`";
      mask(i + 1, closed ? k : src.length);
      prevChar = "`";
      word = "";
      i = Math.min(k + 1, src.length);
      continue;
    }
    // ── 正则字面量（expr 位置上的 /）──
    if (c === "/" && (REGEX_PREV_CHARS.has(prevChar) || REGEX_PREV_WORDS.has(word) || prevChar === "")) {
      let k = i + 1;
      let inClass = false;
      let closed = false;
      while (k < src.length) {
        const ch = src[k]!;
        if (ch === "\n") break; // 正则不跨行：没闭合就当作除号
        if (ch === "\\") {
          k += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          closed = true;
          break;
        }
        k++;
      }
      if (closed) {
        k++; // 闭合的 /
        while (k < src.length && /[a-z]/.test(src[k]!)) k++; // flags
        mask(i, k);
        prevChar = "/";
        word = "";
        i = k;
        continue;
      }
    }
    // ── 普通代码字符 ──
    if (WORD_CHAR.test(c)) word += c;
    else word = "";
    prevChar = c;
    i++;
  }
  return { code: code.join(""), isCode };
}

/** 剥离 // 行注释与块注释（实现见 scanSource；注释内容换成空格、行结构不变） */
export function stripComments(src: string): string {
  return scanSource(src).code;
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
  const { code, isCode } = scanSource(src);
  /** 匹配起点必须落在代码区：字符串/模板/正则里的「export 示例」不算出口 */
  const real = (m: RegExpMatchArray) => {
    const start = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    return isCode[start] === true;
  };
  // export { A, B as C } / export type { ... }（可多行）
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gs)) {
    if (!real(m)) continue;
    for (const part of m[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const asM = /\bas\s+(\w+)$/.exec(p);
      names.add(asM ? asM[1]! : p);
    }
  }
  // export class/function/interface/type/enum X
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:class|function|interface|type|enum)\s+(\w+)/gm)) {
    if (real(m)) names.add(m[1]!);
  }
  // export const/let/var 支持多声明：export const a = 1, b = 2
  for (const m of code.matchAll(/^export\s+(?:const|let|var)\s+([^;\n]+)/gm)) {
    if (!real(m)) continue;
    for (const decl of splitDeclarators(m[1]!)) {
      const id = /^\s*(\w+)/.exec(decl);
      if (id) names.add(id[1]!);
    }
  }
  // export * as NS from "./x"：命名空间再导出本身就是一个命名出口
  for (const m of code.matchAll(/export\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+["'][^"']+["']/g)) {
    if (real(m)) names.add(m[1]!);
  }
  // export * from "./x"（含 export type * from）：递归收集目标文件出口
  if (resolveFile && depth < 3)
    for (const m of code.matchAll(/export\s+(?:type\s+)?\*\s+from\s+["']([^"']+)["']/g)) {
      if (!real(m)) continue;
      const target = resolveFile(m[1]!);
      if (target)
        for (const n of socketExports(readFileSync(target, "utf8"), resolveFile, depth + 1))
          names.add(n);
    }
  return names;
}

/**
 * 插座纯度（契约 §3.1）：插座只许 named/type export。
 * - 不 export default：default 出口绕开「符号必须登记」的清单语义
 * - 不导出实例（export const = new …）：共享可变状态必须走 DI
 * 注释/字符串里的示例不算。
 */
export function socketPurityViolations(src: string): string[] {
  const { code, isCode } = scanSource(src);
  const real = (m: RegExpMatchArray) => {
    const start = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    return isCode[start] === true;
  };
  let hasDefault = false;
  let hasInstance = false;
  // export default X
  for (const m of code.matchAll(/^export\s+default\b/gm)) if (real(m)) hasDefault = true;
  // export { x as default }
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm))
    if (real(m) && /\bas\s+default\b/.test(m[1]!)) hasDefault = true;
  // export const/let/var 多声明里任何一个 = new
  for (const m of code.matchAll(/^export\s+(?:const|let|var)\s+([^;\n]+)/gm)) {
    if (!real(m)) continue;
    for (const decl of splitDeclarators(m[1]!)) if (/=\s*new\s/.test(decl)) hasInstance = true;
  }
  const issues: string[] = [];
  if (hasDefault) issues.push("含 export default——插座只许 named/type export（契约 §3.1）");
  if (hasInstance) issues.push("导出了实例（export const = new …）——共享可变状态必须走 DI，不进插座");
  return issues;
}

export interface SocketViolation {
  /** 违规文件（相对 root） */
  file: string;
  message: string;
}

export interface SocketGateResult {
  violations: SocketViolation[];
  /** 插座纯度违规（契约 §3.1）：default / 实例出口，codegen 与 doctor 共用 */
  purity: SocketViolation[];
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
    // Bun 的 ?raw / ?url 等资源查询串不参与文件解析
    const clean = spec.replace(/[?#].*$/, "");
    // 路径别名（模板 tsconfig paths 约定）：@gen → .elysiax/，@/ → src/
    const base = clean.startsWith("@gen")
      ? resolve(root, ".elysiax", clean.slice(4))
      : clean.startsWith("@/")
        ? resolve(root, "src", clean.slice(2))
        : resolve(fromFile, "..", clean);
    // NodeNext 风格显式扩展名：./x.socket.js 实际落在 ./x.socket.ts
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
      // 必须落到文件：目录导入命中 base 会把 atomOf 算到父目录，整条检查被静默跳过
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
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
  /** 判定一条跨文件引用（静态 import/export、副作用 import、动态 import 共用） */
  const checkSpec = (fileRel: string, absFile: string, spec: string, clause: string) => {
    // 只查相对 import 与 @/ 别名（指向 src/ 内部）；包与 shared 基建不查
    if (!spec.startsWith(".") && !spec.startsWith("@/")) return;
    const target = resolveImport(absFile, spec);
    if (!target || !target.includes(`/${pagesDir}/`)) return;
    const srcAtom = atomOf(absFile);
    const tgtAtom = atomOf(target);
    if (!tgtAtom || tgtAtom === srcAtom) return; // 原子内部 / 非原子目标
    if (!/\.socket\.tsx?$/.test(target)) {
      violations.push({
        file: fileRel,
        message: `跨原子 import 绕过了插座（${spec}）——只允许指向对方的 <name>.socket.ts，被引用方请先把符号登记进插座`,
      });
      return;
    }
    // 适配检查（符号级）：插头引用的每个符号，插座必须真实导出——
    // 源码分发场景下"接口对不上"在安装期就报出来，而不是运行时炸
    const named = /^\{([^}]*)\}/s.exec(clause.trim())?.[1];
    if (!named) return; // default/namespace import：插座无 default（§3.1），tsc 会抓
    for (const part of named.split(",")) {
      const sym = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (!sym) continue;
      if (!symbolsOf(target).has(sym)) {
        violations.push({
          file: fileRel,
          message: `插头插不上——插座 ${relativeSpec(root, target)} 没有导出 "${sym}"（插座出口被删/改名，或复制来的原子与对方插座版本不匹配）`,
        });
      }
    }
  };

  for await (const f of new Glob(`${pagesDir}/**/*.ts*`).scan({ cwd: root })) {
    const abs = resolve(root, f);
    // 先剥注释：注释里的示例 import 不能算数，import 花括号里的行注释也不能混进符号名
    const { code: src, isCode } = scanSource(readFileSync(abs, "utf8"));
    /** 语句首个非空白字符必须落在代码区：模板串/JSX 文本里的示例 import 是纯文本，不算引用 */
    const startsInCode = (m: RegExpMatchArray) => {
      const text = m[0];
      const lead = text.length - text.trimStart().length;
      return isCode[(m.index ?? 0) + lead] === true;
    };
    // 静态形态：import ... from / export ... from（再导出）/ import "..."（副作用）
    for (const m of src.matchAll(/^\s*(?:import\s+(?:type\s+)?([^"']*?)from|export\s+(?:type\s+)?([^"']*?)from|import)\s*["']([^"']+)["']/gm)) {
      if (!startsInCode(m)) continue;
      checkSpec(f, abs, m[3]!, m[1] ?? m[2] ?? "");
    }
    // 动态 import(): 同样是跨原子引用通道，别名/相对路径一律按同一口径判
    // （字符串引号与无插值模板串都算；带插值的模板串无法静态解析，跳过）
    for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)) {
      if (!startsInCode(m)) continue;
      checkSpec(f, abs, m[1]!, "");
    }
  }
  // 插座符号表全量预热：doctor 的「只增不减」对没被任何插头引用的叶子插座
  // 也要拿到出口，否则会把 HEAD 里的全部出口误判成「被删」
  for (const sf of socketFiles) symbolsOf(sf);

  // 插座纯度：同样在生成期拦（default / 实例出口是契约违规，不该等手动体检）
  const purity: SocketViolation[] = [];
  for (const sf of socketFiles)
    for (const message of socketPurityViolations(readFileSync(sf, "utf8")))
      purity.push({ file: relativeSpec(root, sf), message });
  return { violations, purity, atomDirs: atomsDirs, socketFiles, symbols };
}

/** 违规信息里展示相对路径（root 外则原样） */
function relativeSpec(root: string, abs: string): string {
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
}
