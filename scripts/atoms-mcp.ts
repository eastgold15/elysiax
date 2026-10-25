// elysiax 原子插座目录 MCP server
// 暴露项目原子地图：卡片目录 + 每个原子的 socket/di 原文，供 AI 按需拉取（不用 grep 全仓库）。
// 扫描规则（凹凸插座契约）：文件夹里有 <name>.di.ts / <name>.socket.ts = 原子（身份证判定）。
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const git = promisify(execFile);

const REPO_ROOT = resolve(import.meta.dir, "..");
// 扫描根：dockyard 的页面目录（未来多 app 可扩展）
const SCAN_ROOTS = ["apps/dockyard/src/pages"];

interface AtomCard {
  name: string;
  dir: string; // 相对仓库根
  route?: string;
  socketExports: string[]; // 插座出口（原始 export 行摘要）
  plugs: string[]; // 插头：di.ts 里 import 的他人 socket
  files: string[];
}

/** 递归找身份证文件（<name>.di.ts / <name>.socket.ts），所在文件夹即原子 */
async function findAtoms(root: string): Promise<Map<string, string[]>> {
  const atoms = new Map<string, string[]>();
  async function walk(dir: string, depth: number) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const ids = entries.filter(
      (e) => e.isFile() && /\.(di|socket)\.ts$/.test(e.name),
    );
    if (ids.length > 0) atoms.set(dir, ids.map((e) => e.name));
    for (const e of entries) {
      if (e.isDirectory() && !["node_modules", ".elysiax", "client"].includes(e.name)) {
        await walk(join(dir, e.name), depth + 1);
      }
    }
  }
  await walk(root, 0);
  return atoms;
}

/** 解析 socket.ts：提取 export 行（插座出口承诺） */
function parseSocketExports(src: string): string[] {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("export ") && !l.startsWith("export default"))
    .map((l) => l.replace(/;?$/, ""));
}

/** 从 socket 源码提取导出的符号集合（用于只增不减对比，忽略 from 路径差异） */
function parseSocketSymbols(src: string): Set<string> {
  const symbols = new Set<string>();
  for (const line of src.split("\n")) {
    const l = line.trim();
    // export { a, b as c } from "..." / export type { ... }
    const brace = l.match(/^export\s+(?:type\s+)?\{([^}]+)\}/);
    if (brace) {
      for (const part of brace[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (name) symbols.add(name);
      }
      continue;
    }
    // export type X = ... / export const x = ...
    const single = l.match(/^export\s+(?:type|const|class|function|interface)\s+(\w+)/);
    if (single) symbols.add(single[1]);
  }
  return symbols;
}

/** 插座只增不减检查：当前导出 vs git HEAD 导出快照，减出口 = 拔插头 */
async function diffSockets(): Promise<string> {
  const cards = await buildCards();
  const lines = ["# 插座只增不减检查（vs git HEAD）", ""];
  let removed = 0, added = 0, fresh = 0;
  for (const c of cards) {
    const socketPath = join(c.dir, `${c.name}.socket.ts`);
    const hasSocket = c.files.includes(`${c.name}.socket.ts`);
    if (!hasSocket) continue;
    let headSrc: string | null = null;
    try {
      const { stdout } = await git("git", ["show", `HEAD:${socketPath}`], { cwd: REPO_ROOT });
      headSrc = stdout;
    } catch {
      fresh++; // HEAD 里没有 = 新原子，无基线可比
      continue;
    }
    const cur = parseSocketSymbols(await readFile(resolve(REPO_ROOT, socketPath), "utf8"));
    const base = parseSocketSymbols(headSrc);
    const del = [...base].filter((s) => !cur.has(s));
    const add = [...cur].filter((s) => !base.has(s));
    if (del.length === 0 && add.length === 0) continue;
    lines.push(`## ${c.name}  \`${socketPath}\``);
    for (const s of del) { lines.push(`- 🔴 **拔插头**: \`${s}\` 从插座移除（HEAD 里有，现在没了）`); removed++; }
    for (const s of add) { lines.push(`- 🟢 新增出口: \`${s}\``); added++; }
    lines.push("");
  }
  lines.push("---");
  lines.push(`合计: 🔴 移除 ${removed} 处（需确认无引用方）/ 🟢 新增 ${added} 处 / 🆕 新原子 ${fresh} 个（无基线）`);
  if (removed === 0) lines.push("✅ 未发现拔插头");
  return lines.join("\n");
}

/** 原子依赖图 → Mermaid flowchart（文本即图：GitHub/文档站直接渲染，AI 也能读源码） */
function cardsToMermaid(cards: AtomCard[]): string {
  // 插头路径（../x/x.socket）→ 原子名
  const bySocketFile = new Map(cards.map((c) => [join(c.dir, `${c.name}.socket`), c.name]));
  const lines = ["flowchart LR"];
  for (const c of cards) {
    const label = c.route ? `${c.name}\\n${c.route}` : `${c.name}\\n(无URL)`;
    lines.push(`  ${c.name}["${label}"]`);
  }
  for (const c of cards) {
    for (const plug of c.plugs) {
      const target = bySocketFile.get(join(c.dir, plug).replace(/\.ts$/, ""));
      if (target) lines.push(`  ${c.name} -.插头.-> ${target}`);
    }
  }
  // 整页 client 形态的原子染色（canvas）
  const solidish = cards.filter((c) => c.files.some((f) => f === "canvas.actions.ts")).map((c) => c.name);
  if (solidish.length) lines.push(`  classDef client fill:#1e293b,stroke:#38bdf8,color:#e2e8f0`);
  for (const n of solidish) lines.push(`  class ${n} client`);
  return lines.join("\n");
}

/** 解析 di.ts：route + 插头（import 的他人 *.socket 路径） */
function parseDi(src: string): { route?: string; plugs: string[] } {
  const route = src.match(/route:\s*["'`]([^"'`]+)["'`]/)?.[1];
  const plugs = [...src.matchAll(/from\s+["'`]([^"'`]*\.socket)["'`]/g)].map((m) => m[1]);
  return { route, plugs };
}

async function buildCards(): Promise<AtomCard[]> {
  const cards: AtomCard[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const atoms = await findAtoms(resolve(REPO_ROOT, scanRoot));
    for (const [dir, idFiles] of atoms) {
      const socketFile = idFiles.find((f) => f.endsWith(".socket.ts"));
      const diFile = idFiles.find((f) => f.endsWith(".di.ts"));
      const name = (socketFile ?? diFile ?? "").replace(/\.(socket|di)\.ts$/, "");
      let socketExports: string[] = [];
      let route: string | undefined;
      let plugs: string[] = [];
      if (socketFile) socketExports = parseSocketExports(await readFile(join(dir, socketFile), "utf8"));
      if (diFile) ({ route, plugs } = parseDi(await readFile(join(dir, diFile), "utf8")));
      const files = (await readdir(dir)).filter((f) => /\.(ts|tsx)$/.test(f));
      cards.push({ name, dir: relative(REPO_ROOT, dir), route, socketExports, plugs, files });
    }
  }
  return cards.sort((a, b) => a.dir.localeCompare(b.dir));
}

function cardsToMarkdown(cards: AtomCard[]): string {
  const lines = ["# elysiax 原子插座目录", ""];
  for (const c of cards) {
    lines.push(`## ${c.name}  ${c.route ?? "(无 URL)"}  \`${c.dir}\``);
    lines.push(`- 插座出口: ${c.socketExports.length ? "" : "（无 socket —— 不对外承诺）"}`);
    for (const e of c.socketExports) lines.push(`  - \`${e}\``);
    lines.push(`- 插头（依赖的他人 socket）: ${c.plugs.length ? c.plugs.map((p) => `\`${p}\``).join(", ") : "无"}`);
    lines.push(`- 文件: ${c.files.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

const server = new McpServer({ name: "elysiax-atoms", version: "0.1.0" });

// 固定资源：原子卡片目录（项目地图总览）
server.registerResource(
  "atoms-index",
  "elysiax://atoms",
  {
    title: "原子插座目录",
    description: "elysiax 全项目原子地图：每个原子的 route、插座出口（对外承诺）、插头（依赖的他人 socket）、文件清单。审查插头对接/新建原子前先读。",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, text: cardsToMarkdown(await buildCards()) }] }),
);

// 固定资源：原子依赖图（Mermaid 源码，文本即图）
server.registerResource(
  "atoms-graph",
  "elysiax://atoms/graph",
  {
    title: "原子依赖图（Mermaid）",
    description: "原子间插头→插座依赖关系的 Mermaid flowchart 源码。嵌进 markdown 即渲染成图，AI 也可直接读文本。",
    mimeType: "text/plain",
  },
  async (uri) => ({ contents: [{ uri: uri.href, text: cardsToMermaid(await buildCards()) }] }),
);

// 固定资源：插座只增不减检查（契约 §8）
server.registerResource(
  "atoms-diff",
  "elysiax://atoms/diff",
  {
    title: "插座只增不减检查",
    description: "对比 git HEAD 的插座出口快照：减出口 = 拔插头（报错级），增出口正常。提交前/审查时拉取。",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, text: await diffSockets() }] }),
);

// 模板资源：elysiax://atoms/{name}/socket 与 /di —— 拉单个原子的身份证原文
server.registerResource(
  "atom-file",
  new ResourceTemplate("elysiax://atoms/{name}/{kind}", {
    list: async () => {
      const cards = await buildCards();
      return {
        resources: cards.flatMap((c) => [
          { uri: `elysiax://atoms/${c.name}/socket`, name: `${c.name} 插座` },
          { uri: `elysiax://atoms/${c.name}/di`, name: `${c.name} di` },
        ]),
      };
    },
  }),
  { title: "原子身份证文件", description: "单个原子的 socket.ts 或 di.ts 原文", mimeType: "text/plain" },
  async (uri, { name, kind }) => {
    if (kind !== "socket" && kind !== "di") throw new Error(`未知 kind: ${kind}（只支持 socket|di）`);
    const card = (await buildCards()).find((c) => c.name === name);
    if (!card) throw new Error(`原子不存在: ${name}`);
    const file = resolve(REPO_ROOT, card.dir, `${name}.${kind}.ts`);
    if (!file.startsWith(REPO_ROOT)) throw new Error("路径越界");
    return { contents: [{ uri: uri.href, text: await readFile(file, "utf8") }] };
  },
);

// emit 模式：bun run scripts/atoms-mcp.ts --emit <输出.md> —— 卡片 + Mermaid 图落盘，退出
// 无参数 = MCP server（stdio）
const emitIdx = process.argv.indexOf("--emit");
if (emitIdx !== -1) {
  const out = resolve(REPO_ROOT, process.argv[emitIdx + 1] ?? "docs/atoms.md");
  const cards = await buildCards();
  const doc = [
    "<!-- 由 scripts/atoms-mcp.ts --emit 生成，勿手改 -->",
    "",
    cardsToMermaid(cards).replace(/^/m, "```mermaid\n") + "\n```",
    "",
    cardsToMarkdown(cards),
  ].join("\n");
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(resolve(out, ".."), { recursive: true });
  await writeFile(out, doc);
  console.log(`✅ 已生成 ${out}`);
  process.exit(0);
}

await server.connect(new StdioServerTransport());
