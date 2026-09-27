/**
 * 部署自动识别（借鉴 openship 的 overlay 模型：检测先行、声明覆盖）。
 * - 仓库根有 openship.json → 按声明解析（services/domains/env），错误/警告带回 UI
 * - 没有 → 回退解析 compose 文件的 services + ports，生成同样的 DetectResult
 * 解析是手写的（无 schema 依赖），未知字段只警告不报错——同 openship 的宽容策略。
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ── openship.json 类型（对齐 tradeflow/openship.json 的实际形状）──
export interface OpenshipEnvValue {
  value: string;
  secret: boolean;
}
export interface OpenshipService {
  name: string;
  exposed: boolean;
  exposedPort?: number;
  domain?: string;
  resources?: { cpuCores?: number; memoryMb?: number; diskMb?: number };
  env: Record<string, OpenshipEnvValue>;
}
export interface OpenshipDomain {
  domain: string;
  port: number;
  type: string; // free | custom
}
export interface OpenshipConfig {
  framework?: string;
  composePath?: string;
  domains: OpenshipDomain[];
  volumes: string[];
  env: Record<string, OpenshipEnvValue>;
  services: OpenshipService[];
}

export interface ParseResult {
  config: OpenshipConfig | null;
  errors: string[];
  warnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function parseEnvValue(key: string, raw: unknown, warnings: string[]): OpenshipEnvValue | null {
  if (typeof raw === "string") return { value: raw, secret: false };
  if (isObj(raw) && typeof raw.value === "string") return { value: raw.value, secret: raw.secret === true };
  warnings.push(`env.${key} 形状无法识别，已跳过`);
  return null;
}

function parseEnvMap(raw: unknown, scope: string, warnings: string[]): Record<string, OpenshipEnvValue> {
  const out: Record<string, OpenshipEnvValue> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const parsed = parseEnvValue(`${scope}.${k}`, v, warnings);
    if (parsed) out[k] = parsed;
  }
  return out;
}

/** 手写宽容解析器：坏字段进 errors，未知字段进 warnings，能救的都救回来 */
export function parseOpenshipConfig(raw: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { config: null, errors: ["openship.json 顶层必须是对象"], warnings };

  const KNOWN = new Set(["$schema", "framework", "composePath", "domains", "volumes", "env", "services", "resources"]);
  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) warnings.push(`未知字段 ${key}（忽略）`);

  const domains: OpenshipDomain[] = [];
  if (raw.domains !== undefined) {
    if (!Array.isArray(raw.domains)) errors.push("domains 必须是数组");
    else {
      for (const [i, d] of raw.domains.entries()) {
        if (!isObj(d) || typeof d.domain !== "string" || typeof d.port !== "number") {
          errors.push(`domains[${i}] 需要 { domain: string, port: number }`);
          continue;
        }
        domains.push({ domain: d.domain, port: d.port, type: typeof d.type === "string" ? d.type : "custom" });
      }
    }
  }

  const services: OpenshipService[] = [];
  if (raw.services !== undefined) {
    if (!Array.isArray(raw.services)) errors.push("services 必须是数组");
    else {
      for (const [i, s] of raw.services.entries()) {
        if (!isObj(s) || typeof s.name !== "string" || !s.name) {
          errors.push(`services[${i}] 需要 name: string`);
          continue;
        }
        const resources = isObj(s.resources) ? s.resources : undefined;
        services.push({
          name: s.name,
          exposed: s.exposed === true,
          exposedPort: typeof s.exposedPort === "string" ? Number(s.exposedPort) || undefined
            : typeof s.exposedPort === "number" ? s.exposedPort : undefined,
          domain: typeof s.domain === "string" ? s.domain : undefined,
          resources: resources ? {
            cpuCores: typeof resources.cpuCores === "number" ? resources.cpuCores : undefined,
            memoryMb: typeof resources.memoryMb === "number" ? resources.memoryMb : undefined,
            diskMb: typeof resources.diskMb === "number" ? resources.diskMb : undefined,
          } : undefined,
          env: parseEnvMap(s.env, `services.${s.name}.env`, warnings),
        });
      }
    }
  }

  const volumes: string[] = [];
  if (raw.volumes !== undefined) {
    if (!Array.isArray(raw.volumes)) warnings.push("volumes 应为字符串数组，已忽略");
    else for (const v of raw.volumes) typeof v === "string" ? volumes.push(v) : warnings.push(`volumes 里的非字符串项已忽略`);
  }

  return {
    config: {
      framework: typeof raw.framework === "string" ? raw.framework : undefined,
      composePath: typeof raw.composePath === "string" ? raw.composePath : undefined,
      domains,
      volumes,
      env: parseEnvMap(raw.env, "env", warnings),
      services,
    },
    errors,
    warnings,
  };
}

export function parseOpenshipConfigJson(text: string): ParseResult {
  try {
    return parseOpenshipConfig(JSON.parse(text));
  } catch (e) {
    return { config: null, errors: [`openship.json 不是合法 JSON：${(e as Error).message}`], warnings: [] };
  }
}

// ── UI/创建共用的识别结果（openship.json 与 compose 回退统一成这个形状）──
export interface DetectedService {
  name: string;
  exposed: boolean;
  port?: number; // 对外端口
  domain?: string;
  cpuCores?: number;
  memoryMb?: number;
  env: Record<string, OpenshipEnvValue>;
}
export interface DetectResult {
  source: "openship.json" | "compose" | "none";
  composePath: string;
  services: DetectedService[];
  rootEnv: Record<string, OpenshipEnvValue>;
  errors: string[];
  warnings: string[];
}

/** openship.json → DetectResult（services[] 为空时退回 compose 探测端口） */
export function configToDetect(parsed: ParseResult, composeText: string | null): DetectResult {
  const { config, errors, warnings } = parsed;
  if (!config) return { source: "openship.json", composePath: "docker-compose.yml", services: [], rootEnv: {}, errors, warnings };
  const composePath = config.composePath ?? "docker-compose.yml";
  const domainByPort = new Map(config.domains.map((d) => [d.port, d.domain]));
  let services: DetectedService[] = config.services.map((s) => ({
    name: s.name,
    exposed: s.exposed,
    port: s.exposedPort ?? (s.exposed ? domainByPortPort(config.domains, s.domain) : undefined),
    domain: s.domain,
    cpuCores: s.resources?.cpuCores,
    memoryMb: s.resources?.memoryMb,
    env: s.env,
  }));
  if (services.length === 0 && composeText) {
    services = detectFromCompose(composeText).services;
    warnings.push("openship.json 未声明 services，已从 compose 探测");
  }
  // domains[] 里未被任何 service 认领的，按端口挂到同名/同端口 exposed 服务
  for (const d of config.domains) {
    if (services.some((s) => s.domain === d.domain)) continue;
    const svc = services.find((s) => s.exposed && s.port === d.port) ?? services.find((s) => s.exposed);
    if (svc) {
      svc.domain = svc.domain ?? d.domain;
      svc.port = svc.port ?? d.port;
    } else {
      warnings.push(`域名 ${d.domain}:${d.port} 没有可挂靠的 exposed 服务`);
    }
  }
  return { source: "openship.json", composePath, services, rootEnv: config.env, errors, warnings };
}

function domainByPortPort(domains: OpenshipDomain[], domain?: string): number | undefined {
  if (!domain) return undefined;
  return domains.find((d) => d.domain === domain)?.port;
}

/** compose 里的 env_file 相对路径（远端没有仓库目录树，up 前需要占位文件兜底，否则 compose 直接报错）。
 *  "${ENV:-production}" 这类默认值占位符按默认值展开。 */
export function envFilePaths(composeText: string): string[] {
  let doc: unknown;
  try {
    doc = parseYaml(composeText);
  } catch {
    return [];
  }
  const svcs = isObj(doc) && isObj(doc.services) ? doc.services : {};
  const paths = new Set<string>();
  for (const def of Object.values(svcs)) {
    if (!isObj(def)) continue;
    const raw = def.env_file;
    const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    for (const item of list) {
      const p = typeof item === "string" ? item : isObj(item) && typeof item.path === "string" ? item.path : null;
      if (!p) continue;
      const expanded = p.replace(/\$\{[^}]*:-([^}]*)\}/g, "$1");
      if (!expanded.startsWith("/") && !expanded.includes("${")) paths.add(expanded);
    }
  }
  return [...paths];
}

/** compose 回退：只探测 services 和 ports（格式 "host:container" 或 "port"），env 不猜 */
export function detectFromCompose(composeText: string): DetectResult {
  const warnings: string[] = [];
  const services: DetectedService[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(composeText);
  } catch (e) {
    return { source: "compose", composePath: "docker-compose.yml", services: [], rootEnv: {}, errors: [`compose 解析失败：${(e as Error).message}`], warnings };
  }
  const svcs = isObj(doc) && isObj(doc.services) ? doc.services : {};
  for (const [name, def] of Object.entries(svcs)) {
    if (!isObj(def)) continue;
    let port: number | undefined;
    if (Array.isArray(def.ports)) {
      // "${API_PORT:-13080}:${API_PORT:-13080}" → 取默认值再匹配 "host:container"
      const first = String(def.ports[0]).replace(/\$\{[^}]*:-(\d+)\}/g, "$1");
      const m = first.match(/^(?:(\d+):)?(\d+)(?:\/(?:tcp|udp))?$/);
      if (m) port = Number(m[1] ?? m[2]);
    }
    if (def.image === undefined && def.build === undefined) warnings.push(`服务 ${name} 既无 image 也无 build，部署可能失败`);
    services.push({ name, exposed: port !== undefined, port, env: {} });
  }
  if (services.length === 0) warnings.push("compose 里没发现任何 service");
  return { source: "compose", composePath: "docker-compose.yml", services, rootEnv: {}, errors: [], warnings };
}

/** rootEnv → .env 文本（服务 compose 的 ${VAR} 插值；服务级变量走 override 的 environment，不扁平化） */
export function detectToEnvText(detect: Pick<DetectResult, "rootEnv">): string {
  return Object.entries(detect.rootEnv).map(([k, v]) => `${k}=${v.value}`).join("\n");
}

/** 服务 env map → .env 文本（step2 服务卡片里的编辑框初值） */
export function serviceEnvToText(env: Record<string, OpenshipEnvValue>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v.value}`).join("\n");
}

/** .env 文本 → env map（step2 提交时解析回服务级 environment） */
export function textToEnvMap(text: string): Record<string, OpenshipEnvValue> {
  const out: Record<string, OpenshipEnvValue> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) out[m[1]!] = { value: m[2]!.trim(), secret: false };
  }
  return out;
}

/** 资源限制 + 服务级 environment → compose override。
 *  environment 是 openship.json 服务 env 真正送达容器的通道（用户 compose 的 env_file 相对路径远端不存在）；
 *  资源限制对应 openship 的 HostConfig.NanoCpus/Memory（compose 里是 cpus/mem_limit）。
 *  不写 name: —— 远端 up 用 -p 定死项目名，override 里的 name 反而会抢。
 *  含秘密值，落库前必须 enc1: 加密。 */
export function detectToOverrideCompose(detect: Pick<DetectResult, "services">): string | null {
  const services: Record<string, Record<string, unknown>> = {};
  for (const s of detect.services) {
    const def: Record<string, unknown> = {};
    if (s.cpuCores) def.cpus = s.cpuCores;
    if (s.memoryMb) def.mem_limit = `${s.memoryMb}m`;
    const env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, v.value]));
    if (Object.keys(env).length > 0) def.environment = env;
    if (Object.keys(def).length > 0) services[s.name] = def;
  }
  if (Object.keys(services).length === 0) return null;
  return stringifyYaml({ services });
}
