import { dirname, join, normalize } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { openSftp } from "@meitaim/ssh/sftp";
import type { AppPaths } from "../../shared/paths";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { events } from "../../shared/events";
import type { DeployTarget, Deployment, DepEdge, Project, TargetService } from "../../shared/schema";
import type { ProjectRepository } from "../projects/projects.repository";
import type { ResourceService, SharedEnv } from "../resources/resources.service";
import type { ServerService } from "../servers/servers.service";
import type { GithubService } from "../github/github.service";
import type { CanvasRepository } from "../canvas/canvas.repository";
import type { DeployRepository } from "./deploy.repository";
import type { EdgeService } from "../edge/edge.service";
import {
  configToDetect,
  detectFromCompose,
  envFilePaths,
  parseOpenshipConfigJson,
  textToEnvMap,
  type DetectResult,
  type DetectedService,
} from "./detect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  containerNameOf,
  dbCompose,
  generatePassword,
  instanceUrl,
  LOGICAL_DB_SUPPORT,
  logicalDbCommands,
  logicalDbUrl,
  suggestedEnvKey,
  type DbType,
} from "./db-templates";

type Log = (line: string) => Promise<void>;

/** 可引用的数据库连接（app 依赖选择器的一行） */
export interface DbRef {
  id: number;
  nodeId: number;
  name: string;
  dbType: DbType;
  logical: boolean;
  url: string;
  displayUrl: string; // 脱敏预览（密码段 •••），选择器里展示用
  envKey: string; // 建议注入的变量名（DATABASE_URL / REDIS_URL）
}

/** 流式执行本地命令，输出写入部署日志 */
async function run(cmd: string[], cwd: string, log: Log): Promise<void> {
  log(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) await log(new TextDecoder().decode(chunk).trimEnd());
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`命令失败（exit ${code}）: ${cmd.join(" ")}`);
}

// parseOwnerRepo 上移 shared/github.ts（projects 绑定仓库也要用）；此处 re-export 兼容
export { parseOwnerRepo } from "../../shared/github";
import { parseOwnerRepo } from "../../shared/github";

export class DeployService {
  /** 防同 target 重入 */
  private running = new Map<number, Promise<void>>();

  constructor(
    private readonly repo: DeployRepository,
    private readonly serverService: ServerService,
    private readonly github: GithubService,
    private readonly canvasRepo: CanvasRepository,
    private readonly paths: AppPaths,
    private readonly edge: EdgeService,
    private readonly projectRepo: ProjectRepository,
    private readonly resourceService: ResourceService,
  ) { }

  /** 项目导入来源：github = 远端拉代码+服务器构建；local = 本地构建+镜像推送。
   *  旧数据 sourceType 为 null，按 localPath/repoUrl 推断。 */
  private async sourceOf(target: DeployTarget): Promise<{ type: "local" | "github"; project?: Project }> {
    const node = await this.canvasRepo.byId(target.nodeId);
    const project = node ? await this.projectRepo.byId(node.projectId) : undefined;
    const type: "local" | "github" =
      project?.sourceType ?? (project?.localPath && !target.repoUrl ? "local" : "github");
    return { type, project };
  }

  targetsOfNode(nodeId: number) {
    return this.repo.targetsOfNode(nodeId);
  }

  targetById(id: number) {
    return this.repo.targetById(id);
  }

  latestDeployment(targetId: number) {
    return this.repo.latestDeployment(targetId);
  }

  /** 同卡片同类型名称唯一（db 层还有唯一索引兜底，这里给用户友好报错） */
  private async assertNameFree(nodeId: number, kind: "app" | "db", name: string) {
    const dup = (await this.repo.targetsOfNode(nodeId)).find(
      (t) => t.kind === kind && t.name === name,
    );
    if (dup) throw new Error(`该服务器上已存在同名${kind === "db" ? "数据库" : "应用"}「${name}」`);
  }

  async createAppTarget(input: {
    nodeId: number; name: string; repoUrl?: string; branch: string;
    composePath: string; serviceName?: string; remoteDir: string;
    envText?: string; // 识别结果合并出的 .env（enc1: 加密落库）
    overrideCompose?: string | null; // 资源限制 override（compose -f 叠加）
    dependsOn?: number[]; // 依赖的 db target id（画布连线 + 连接串引用血缘）
    domains?: { hostname: string; serviceName?: string; targetPort: number }[];
    services?: DetectedService[]; // compose 服务清单（画布小卡片；剥离秘密值后明文落库）
    upServices?: string[]; // 实际 up 的服务子集（共享资源复用过滤中间件；undefined = 全量）
  }) {
    if (input.repoUrl?.trim()) parseOwnerRepo(input.repoUrl); // 提前校验（本地导入可无仓库）
    await this.assertNameFree(input.nodeId, "app", input.name);
    const { envText, overrideCompose, domains, dependsOn, services, upServices, ...base } = input;
    const target = await this.repo.createTarget({
      kind: "app",
      ...base,
      ...(dependsOn?.length ? { dependsOn } : {}),
      ...(upServices?.length ? { upServices } : {}),
      // 只存 name/port：env 是秘密（envJson/overrideCompose 加密通道），cpu/mem 已在 override
      ...(services ? { servicesJson: { services: services.map((s) => ({ name: s.name, port: s.port })) } } : {}),
    });
    // 逻辑库容器名定死（对账用）；app 的容器名由用户 compose 决定，config 时读
    if (envText?.trim() || overrideCompose)
      await this.repo.updateTarget(target.id, {
        ...(envText?.trim() ? { envJson: encryptSecret(envText) } : {}),
        // override 含服务级 environment（秘密值），enc1: 加密落库
        ...(overrideCompose ? { overrideCompose: encryptSecret(overrideCompose) } : {}),
      });
    // 域名归 edge 上下文（含抢占检查）；建行后再绑，失败则整单撤掉
    try {
      for (const d of domains ?? [])
        await this.edge.addDomain(target.id, d);
    } catch (e) {
      await this.repo.removeTarget(target.id);
      throw e;
    }
    return (await this.repo.targetById(target.id))!;
  }

  // ── 域名门面：域名归 edge 上下文，deploy 只是转发（画布/控制器不直接碰 edge）──
  domainsOfTarget(targetId: number) {
    return this.edge.domainsOfTarget(targetId);
  }

  /**
   * app 的 compose 服务清单（画布小卡片 + 容器标签对账）：
   * 优先读 servicesJson 列；为 null（存量 target）则从本地仓库缓存跑 compose config 惰性补全并写回。
   * 一切失败都静默降级为空——画布轮询路径不能因为补全挂掉。
   */
  async servicesOfTarget(target: DeployTarget): Promise<{ project: string | null; services: TargetService[] }> {
    if (target.kind !== "app") return { project: null, services: [] };
    const fallbackProject = `dockyard-${target.id}`; // 与 deployApp 的 cfg.name ?? dockyard-<id> 同源
    if (target.servicesJson)
      return { project: target.servicesJson.project ?? fallbackProject, services: target.servicesJson.services };
    try {
      // 本地导入直接读项目目录；GitHub 导入读本地克隆缓存（远端构建后缓存可能不存在 → 静默降级）
      const { type, project } = await this.sourceOf(target);
      const repoDir =
        type === "local" && project?.localPath
          ? join(project.localPath, project.rootDir ?? "")
          : join(this.paths.reposDir, `target-${target.id}`);
      if (!existsSync(repoDir)) return { project: null, services: [] };
      const composePath = target.composePath ?? "docker-compose.yml";
      // env_file 多为 gitignore 的本地秘密（仓库缓存里没有）→ 写占位，否则 compose config 直接报错（同 deployApp 远端做法）
      const composeText = await Bun.file(join(repoDir, composePath)).text();
      for (const p of envFilePaths(composeText)) {
        // 相对 compose 文件所在目录解析；${VAR:-default} 取默认值（与 compose 行为一致）
        const resolved = p.replace(/\$\{[^}:]+:-([^}]*)\}/g, "$1");
        const abs = join(repoDir, dirname(composePath), resolved);
        if (!existsSync(abs)) {
          await mkdir(dirname(abs), { recursive: true });
          await Bun.write(abs, "# dockyard 占位：真实环境变量在 docker-compose.dockyard.yml 的 environment 里\n");
        }
      }
      const proc = Bun.spawn(
        ["docker", "compose", "-f", composePath, "config", "--format", "json"],
        { cwd: repoDir, stdout: "pipe", stderr: "ignore" },
      );
      const cfg = JSON.parse(await new Response(proc.stdout).text()) as {
        name?: string;
        services?: Record<string, { image?: string; ports?: { published?: string | number }[] }>;
      };
      if ((await proc.exited) !== 0) return { project: null, services: [] };
      const services = Object.entries(cfg.services ?? {}).map(([name, def]): TargetService => {
        const published = def.ports?.[0]?.published;
        const port = published === undefined ? undefined : Number(published);
        return { name, image: def.image, port: Number.isFinite(port) ? port : undefined };
      });
      const doc = { ...(cfg.name ? { project: cfg.name } : {}), services };
      await this.repo.updateTarget(target.id, { servicesJson: doc }).catch(() => {});
      return { project: cfg.name ?? fallbackProject, services };
    } catch {
      return { project: null, services: [] };
    }
  }

  domainById(id: number) {
    return this.edge.domainById(id);
  }

  addDomain(targetId: number, input: { hostname: string; targetPort: number; serviceName?: string }) {
    return this.edge.addDomain(targetId, input);
  }

  removeDomain(id: number) {
    return this.edge.removeDomain(id);
  }

  /** 域名变更后的 edge 全量对账（增删域名、手动「重新同步」按钮共用） */
  async syncEdge(targetId: number, log: Log = async () => {}) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new Error("部署目标不存在");
    await this.edge.syncServer(await this.nodeServerId(target), log);
  }

  // ── 自动识别：gh contents API 直读文件（不克隆，秒级）→ openship.json 声明覆盖 → compose 回退 ──
  async detectRepo(input: { repoUrl: string; branch: string }): Promise<DetectResult> {
    const ownerRepo = parseOwnerRepo(input.repoUrl);
    const branch = input.branch || "main";
    const read = (path: string) => this.github.fileContent(ownerRepo, path, branch);

    const openshipText = await read("openship.json");
    if (openshipText !== null) {
      const parsed = parseOpenshipConfigJson(openshipText);
      const composePath = parsed.config?.composePath ?? "docker-compose.yml";
      return configToDetect(parsed, await read(composePath));
    }
    for (const candidate of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      const text = await read(candidate);
      if (text !== null) {
        const result = detectFromCompose(text);
        result.composePath = candidate;
        return result;
      }
    }
    return {
      source: "none",
      composePath: "docker-compose.yml",
      services: [],
      rootEnv: {},
      errors: [],
      warnings: ["仓库里既没有 openship.json 也没有 compose 文件，请手动填写部署参数"],
    };
  }

  /** 本地文件夹导入的识别：直接读本机目录的 openship.json / compose（不走 GitHub API） */
  async detectLocal(input: { localPath: string; rootDir?: string }): Promise<DetectResult> {
    const dir = join(input.localPath, input.rootDir ?? "");
    const read = async (path: string): Promise<string | null> => {
      const file = Bun.file(join(dir, path));
      return (await file.exists()) ? file.text() : null;
    };
    const openshipText = await read("openship.json");
    if (openshipText !== null) {
      const parsed = parseOpenshipConfigJson(openshipText);
      const composePath = parsed.config?.composePath ?? "docker-compose.yml";
      return configToDetect(parsed, await read(composePath));
    }
    for (const candidate of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      const text = await read(candidate);
      if (text !== null) {
        const result = detectFromCompose(text);
        result.composePath = candidate;
        return result;
      }
    }
    return {
      source: "none",
      composePath: "docker-compose.yml",
      services: [],
      rootEnv: {},
      errors: [],
      warnings: ["本地目录里既没有 openship.json 也没有 compose 文件，请手动填写部署参数"],
    };
  }

  // ── 依赖与连接串引用 ──

  /** 项目空间内可引用的数据库连接（app 向导/变量抽屉的选择器数据） */
  async dbRefsOfNode(nodeId: number): Promise<DbRef[]> {
    const node = await this.canvasRepo.byId(nodeId);
    if (!node) return [];
    const dbs = await this.repo.dbTargetsOfProject(node.projectId);
    const refs: DbRef[] = [];
    for (const db of dbs) {
      if (!db.dbType || !db.envJson) continue;
      let url: string | null = null;
      try {
        const parsed = JSON.parse(decryptSecret(db.envJson)) as Record<string, unknown>;
        if (db.instanceOf) {
          url = typeof parsed.url === "string" ? parsed.url : null; // 逻辑库：凭据创建时生成
        } else {
          const server = await this.serverService.byId(await this.nodeServerId(db));
          url = instanceUrl(db.dbType as DbType, server?.host ?? "", String(parsed.env ?? ""));
        }
      } catch { /* 跳过坏记录 */ }
      if (!url) continue;
      refs.push({
        id: db.id, nodeId: db.nodeId, name: db.name,
        dbType: db.dbType as DbType, logical: Boolean(db.instanceOf),
        url,
        displayUrl: url.replace(/(\/\/[^:/@]+:)[^@]+(@)/, "$1•••$2"),
        envKey: suggestedEnvKey(db.dbType as DbType),
      });
    }
    return refs;
  }

  /** 目标所在服务器的共享变量（Env Tab 下拉引用；url 已解密，仅本机控制面） */
  async sharedEnvOfTarget(targetId: number): Promise<SharedEnv[]> {
    const target = await this.repo.targetById(targetId);
    if (!target) return [];
    return this.resourceService.sharedEnvOf(await this.nodeServerId(target));
  }

  /** Source Tab：更新来源配置（仓库/分支/compose 路径/远端目录） */
  async updateSource(
    targetId: number,
    patch: { repoUrl?: string; branch?: string; composePath?: string; remoteDir?: string },
  ) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new Error("部署目标不存在");
    if (patch.repoUrl?.trim()) parseOwnerRepo(patch.repoUrl);
    await this.repo.updateTarget(targetId, {
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl.trim() || null } : {}),
      ...(patch.branch?.trim() ? { branch: patch.branch.trim() } : {}),
      ...(patch.composePath?.trim() ? { composePath: patch.composePath.trim() } : {}),
      ...(patch.remoteDir?.trim() ? { remoteDir: patch.remoteDir.trim() } : {}),
    });
  }

  /** Console Tab：容器交互式终端（docker exec TTY，调用方负责桥接 WS 与关闭流） */
  async openConsole(targetId: number, svcName?: string) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new Error("部署目标不存在");
    const serverId = await this.nodeServerId(target);
    const remote = await this.serverService.docker(serverId);

    let containerName: string;
    if (target.kind === "db") {
      if (!target.containerName) throw new Error("数据库目标缺少容器名");
      containerName = target.containerName;
    } else {
      const { project, services } = await this.servicesOfTarget(target);
      const svc = svcName || services[0]?.name;
      if (!svc) throw new Error("没有可进入的服务（先部署，或指定服务名）");
      containerName = `${project ?? `dockyard-${target.id}`}-${svc}-1`;
    }
    const containers = await remote.listContainers();
    const hit = containers.find((c) => c.Names.includes(`/${containerName}`));
    if (!hit) throw new Error(`容器 ${containerName} 未在运行`);
    const container = remote.getContainer(hit.Id);
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Env: ["TERM=xterm-256color", "COLORTERM=truecolor"],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    return { exec, stream };
  }

  /** app 的 .env 明文（变量抽屉回显；enc1: 解密，仅本机控制面） */
  envTextOf(target: DeployTarget): string {
    if (!target.envJson) return "";
    try {
      return decryptSecret(target.envJson);
    } catch {
      return "";
    }
  }

  /** 变量抽屉保存：.env（enc1: 加密）+ 依赖血缘（画布连线） */
  async updateAppEnv(targetId: number, envText: string, dependsOn: number[]) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new Error("部署目标不存在");
    await this.repo.updateTarget(targetId, {
      envJson: envText.trim() ? encryptSecret(envText) : null,
      dependsOn: dependsOn.length ? dependsOn : null,
    });
  }

  /** 画布拖线建/删依赖：整组覆盖服务级边；dependsOn 是派生血缘（变量抽屉选择器用），双写保持一致 */
  async setDependsOn(targetId: number, edges: DepEdge[]) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new Error("部署目标不存在");
    const dependsOn = [...new Set(edges.map((e) => e.db))];
    await this.repo.updateTarget(targetId, {
      depEdges: edges.length ? edges : null,
      dependsOn: dependsOn.length ? dependsOn : null,
    });
  }

  /** app 的服务级依赖边（depEdges 为空的存量数据从 dependsOn 惰性派生，service=null 表示整体依赖） */
  edgesOfTarget(target: DeployTarget): DepEdge[] {
    if (target.depEdges) return target.depEdges;
    return (target.dependsOn ?? []).map((db) => ({ service: null, db }));
  }

  /** 画布布局持久化：app/db 卡位置 + 服务卡位置（serviceLayout 全量覆盖，岛端合并后传） */
  async setLayout(targetId: number, patch: { x?: number; y?: number; w?: number; h?: number; groupId?: number | null; serviceLayout?: Record<string, { x: number; y: number }> }) {
    await this.repo.updateTarget(targetId, patch);
  }

  /** 删除分组：组内目标回落到服务器卡 */
  async clearGroup(groupId: number) {
    await this.repo.clearGroup(groupId);
  }

  // ── 服务抽屉（Railway Service View）：部署历史 / 容器操作 / 服务变量 / 指标 / 备份 ──

  deploymentsOfTarget(targetId: number) {
    return this.repo.deploymentsOfTarget(targetId);
  }

  deploymentById(id: number) {
    return this.repo.deploymentById(id);
  }

  /** target → 它所在服务器的 dockerode 连接（SSH 中继） */
  private async dockerOfTarget(target: DeployTarget) {
    const node = await this.canvasRepo.byId(target.nodeId);
    if (!node) throw new Error("画布节点不存在");
    return this.serverService.docker(node.serverId);
  }

  /** 服务 → 容器：app 服务按 compose 标签对账；db 实例按 dockyard.target-id 标签（running 优先） */
  private async containerOfService(target: DeployTarget, svcName?: string) {
    const docker = await this.dockerOfTarget(target);
    const containers = await docker.listContainers({ all: true }) as unknown as {
      Id: string; Names?: string[]; Labels?: Record<string, string>; State?: string;
    }[];
    let hit;
    if (target.kind === "app" && svcName) {
      const { project } = await this.servicesOfTarget(target);
      const match = (c: { Labels?: Record<string, string> }) =>
        c.Labels?.["com.docker.compose.project"] === project &&
        c.Labels?.["com.docker.compose.service"] === svcName;
      hit = containers.find((c) => match(c) && c.State === "running") ?? containers.find(match);
    } else {
      const owned = (c: { Labels?: Record<string, string>; Names?: string[] }) =>
        c.Labels?.["dockyard.target-id"] === String(target.id) ||
        c.Names?.includes(`/${containerNameOf(target.id, target.name)}`);
      hit = containers.find((c) => owned(c) && c.State === "running") ?? containers.find(owned);
    }
    return hit ? docker.getContainer(hit.Id) : null;
  }

  /** 重启单个服务容器（svcName 空 = db 实例整体） */
  async restartService(targetId: number, svcName?: string) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new Error("部署目标不存在");
    const container = await this.containerOfService(target, svcName);
    if (!container) throw new Error("容器未运行（先部署）");
    await container.restart();
  }

  /** 一次性资源快照（docker stats stream:false；容器不在 → null） */
  async serviceStats(targetId: number, svcName?: string): Promise<{
    state: string; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number;
  } | null> {
    const target = await this.repo.targetById(targetId);
    if (!target) return null;
    try {
      const container = await this.containerOfService(target, svcName);
      if (!container) return null;
      const info = await container.inspect();
      if (!info.State.Running) return { state: info.State.Status ?? "exited", cpuPercent: 0, memUsage: 0, memLimit: 0, netRx: 0, netTx: 0 };
      const s = await container.stats({ stream: false });
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
      const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage ?? 0);
      const cores = s.cpu_stats.online_cpus ?? s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
      const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
      let netRx = 0, netTx = 0;
      for (const n of Object.values(s.networks ?? {})) { netRx += n.rx_bytes; netTx += n.tx_bytes; }
      return {
        state: "running",
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memUsage: s.memory_stats.usage ?? 0,
        memLimit: s.memory_stats.limit ?? 0,
        netRx, netTx,
      };
    } catch {
      return null; // 服务器离线/SSH 失败 → 前端显示"指标不可用"
    }
  }

  /** 容器实时日志（≠ 部署日志）：docker logs --tail 300，非 TTY 输出带 8 字节多路复用帧头需剥离 */
  async serviceLogs(targetId: number, svcName?: string): Promise<string> {
    const target = await this.repo.targetById(targetId);
    if (!target) return "部署目标不存在";
    try {
      const container = await this.containerOfService(target, svcName);
      if (!container) return "容器未运行（先部署）";
      const buf = await container.logs({ stdout: true, stderr: true, tail: 300 });
      const out: Buffer[] = [];
      let off = 0;
      while (off + 8 <= buf.length) {
        const size = buf.readUInt32BE(off + 4);
        out.push(buf.subarray(off + 8, off + 8 + size));
        off += 8 + size;
      }
      return Buffer.concat(out).toString("utf8").trimEnd() || "（无日志输出）";
    } catch (e) {
      return `日志不可用：${(e as Error).message}`;
    }
  }

  /** 服务的资源限制（override compose 的 cpus/mem_limit；无 → {}） */
  async serviceResources(targetId: number, svcName: string): Promise<{ cpuCores?: number; memoryMb?: number }> {
    const target = await this.repo.targetById(targetId);
    if (!target?.overrideCompose) return {};
    try {
      const doc = parseYaml(decryptSecret(target.overrideCompose)) as {
        services?: Record<string, { cpus?: number | string; mem_limit?: string }>;
      } | null;
      const svc = doc?.services?.[svcName];
      const cpu = svc?.cpus !== undefined ? Number(svc.cpus) : undefined;
      const mem = svc?.mem_limit ? Number.parseInt(svc.mem_limit, 10) : undefined;
      return {
        cpuCores: cpu !== undefined && Number.isFinite(cpu) ? cpu : undefined,
        memoryMb: mem !== undefined && Number.isFinite(mem) ? mem : undefined,
      };
    } catch {
      return {};
    }
  }

  /** 保存资源限制：只动 override compose 里该服务的 cpus/mem_limit（setServiceEnv 同款 merge） */
  async setServiceResources(targetId: number, svcName: string, cpuCores?: number, memoryMb?: number) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new Error("部署目标不存在");
    type Doc = { services?: Record<string, Record<string, unknown>> };
    let doc: Doc = { services: {} };
    if (target.overrideCompose) {
      try { doc = (parseYaml(decryptSecret(target.overrideCompose)) as Doc | null) ?? { services: {} }; } catch { /* 损坏则重建 */ }
    }
    doc.services ??= {};
    const svc = (doc.services[svcName] ??= {});
    if (cpuCores) svc.cpus = cpuCores; else delete svc.cpus;
    if (memoryMb) svc.mem_limit = `${memoryMb}m`; else delete svc.mem_limit;
    if (Object.keys(svc).length === 0) delete doc.services[svcName];
    const empty = Object.keys(doc.services).length === 0 && Object.keys(doc).length === 1;
    await this.repo.updateTarget(targetId, {
      overrideCompose: empty ? null : encryptSecret(stringifyYaml(doc)),
    });
  }

  /** 服务的注入变量（override compose 的 environment，enc1: 加密列里） */
  async serviceEnvText(targetId: number, svcName: string): Promise<string> {
    const target = await this.repo.targetById(targetId);
    if (!target?.overrideCompose) return "";
    try {
      const doc = parseYaml(decryptSecret(target.overrideCompose)) as {
        services?: Record<string, { environment?: Record<string, string> | string[] }>;
      } | null;
      const env = doc?.services?.[svcName]?.environment;
      if (!env) return "";
      // override compose 的 environment 是纯 string map（detectToOverrideCompose 落的就是这个格式）
      if (Array.isArray(env)) return env.join("\n");
      return Object.entries(env).map(([k, v]) => `${k}=${v.includes(" ") ? JSON.stringify(v) : v}`).join("\n");
    } catch {
      return "";
    }
  }

  /** 保存服务变量：只动 override compose 里该服务的 environment，其余（资源限制等）原样保留 */
  async setServiceEnv(targetId: number, svcName: string, envText: string) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new Error("部署目标不存在");
    type Doc = { services?: Record<string, Record<string, unknown>> };
    let doc: Doc = { services: {} };
    if (target.overrideCompose) {
      try { doc = (parseYaml(decryptSecret(target.overrideCompose)) as Doc | null) ?? { services: {} }; } catch { /* 损坏则重建 */ }
    }
    doc.services ??= {};
    const svc = (doc.services[svcName] ??= {});
    const env = Object.fromEntries(Object.entries(textToEnvMap(envText)).map(([k, v]) => [k, v.value]));
    if (Object.keys(env).length) svc.environment = env;
    else delete svc.environment;
    if (Object.keys(svc).length === 0) delete doc.services[svcName];
    const empty = Object.keys(doc.services).length === 0 && Object.keys(doc).length === 1;
    await this.repo.updateTarget(targetId, {
      overrideCompose: empty ? null : encryptSecret(stringifyYaml(doc)),
    });
  }

  // ── Backups（db 实例；逻辑库/应用服务暂无卷，不出 Tab）──

  private backupsDir(targetId: number) {
    return join(this.paths.dataDir, "backups", `target-${targetId}`);
  }

  /** 已有备份列表（新→旧） */
  async backupsOf(targetId: number): Promise<{ file: string; size: number; at: Date }[]> {
    const dir = this.backupsDir(targetId);
    if (!existsSync(dir)) return [];
    const { readdir, stat } = await import("node:fs/promises");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql.gz") || f.endsWith(".dump.gz"));
    const rows = await Promise.all(files.map(async (file) => {
      const st = await stat(join(dir, file));
      return { file, size: st.size, at: st.mtime };
    }));
    return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  /** 立即备份：远端容器内 dump → gzip → base64（二进制安全过 ssh exec 的文本通道）→ 本地落盘 */
  async backupNow(targetId: number): Promise<string> {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "db" || target.instanceOf) throw new Error("只有数据库实例支持备份");
    const dumpCmd: Record<string, string> = {
      postgres: 'pg_dumpall -U "${POSTGRES_USER:-postgres}"',
      mysql: 'mysqldump --all-databases -uroot -p"$MYSQL_ROOT_PASSWORD"',
      mongo: 'mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"',
      redis: "redis-cli save >/dev/null && cat /data/dump.rdb",
    };
    const cmd = dumpCmd[target.dbType ?? ""] ?? dumpCmd.postgres!;
    const node = await this.canvasRepo.byId(target.nodeId);
    if (!node) throw new Error("画布节点不存在");
    const client = await this.serverService.ssh(node.serverId);
    const container = containerNameOf(target.id, target.name);
    const { stdout, stderr, code } = await client.exec(
      `docker exec ${container} sh -c '${cmd}' | gzip | base64 -w0`,
    );
    if (code !== 0) throw new Error(`备份失败：${stderr.trim() || `exit ${code}`}`);
    const dir = this.backupsDir(targetId);
    await mkdir(dir, { recursive: true });
    const ext = target.dbType === "mongo" || target.dbType === "redis" ? "dump.gz" : "sql.gz";
    const file = `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    await Bun.write(join(dir, file), Buffer.from(stdout.trim(), "base64"));
    return file;
  }

  /** 备份文件绝对路径（防目录穿越：只认 backupsDir 下的纯文件名） */
  backupFilePath(targetId: number, file: string): string | null {
    if (!/^[\w.-]+\.(sql|dump)\.gz$/.test(file)) return null;
    const abs = join(this.backupsDir(targetId), file);
    return existsSync(abs) ? abs : null;
  }

  /** 该节点上可托管逻辑库的实例（kind=db、同类型、非逻辑库） */
  async instancesOfNode(nodeId: number, dbType: DbType): Promise<DeployTarget[]> {
    return (await this.repo.targetsOfNode(nodeId)).filter(
      (t) => t.kind === "db" && !t.instanceOf && t.dbType === dbType,
    );
  }

  /** 数据库目标（实例）：模板 compose + 凭据在创建时生成一次，enc1: 加密存 envJson。
   *  容器名/所有权标签依赖 target id，先建行再回填。 */
  async createDbTarget(input: { nodeId: number; name: string; dbType: DbType; remoteDir: string }) {
    await this.assertNameFree(input.nodeId, "db", input.name);
    if (!input.remoteDir.trim()) throw new Error("新建实例需要填写远端目录");
    const target = await this.repo.createTarget({ kind: "db", ...input });
    const node = await this.canvasRepo.byId(input.nodeId);
    const rendered = dbCompose(input.dbType, input.name, {
      targetId: target.id,
      project: `project-${node?.projectId ?? "?"}`,
    });
    const containerName = containerNameOf(target.id, input.name);
    await this.repo.updateTarget(target.id, {
      envJson: encryptSecret(JSON.stringify(rendered)),
      containerName,
    });
    return (await this.repo.targetById(target.id))!;
  }

  /** 逻辑库目标：不起容器，凭据创建时生成，部署 = 在宿主实例里 CREATE DATABASE */
  async createLogicalDbTarget(input: { nodeId: number; name: string; instanceId: number }) {
    const instance = await this.repo.targetById(input.instanceId);
    if (!instance || instance.kind !== "db" || instance.instanceOf)
      throw new Error("宿主实例不存在");
    if (!LOGICAL_DB_SUPPORT[instance.dbType as DbType])
      throw new Error(`${instance.dbType} 不支持逻辑库`);
    await this.assertNameFree(input.nodeId, "db", input.name);
    const serverId = await this.nodeServerId(instance);
    const server = await this.serverService.byId(serverId);
    const password = generatePassword();
    const url = logicalDbUrl(instance.dbType as DbType, server!.host, input.name, password);
    return this.repo.createTarget({
      kind: "db",
      nodeId: input.nodeId,
      name: input.name,
      dbType: instance.dbType,
      instanceOf: instance.id,
      envJson: encryptSecret(JSON.stringify({ url, password })),
    });
  }

  /** 删除：实例旗下有逻辑库时阻止；逻辑库只删记录（不 DROP DATABASE） */
  async removeTarget(id: number) {
    const target = await this.repo.targetById(id);
    if (!target) return;
    if (target.kind === "db" && !target.instanceOf) {
      const children = await this.repo.childrenOf(id);
      if (children.length > 0)
        throw new Error(
          `实例下还有逻辑库：${children.map((c) => c.name).join("、")}，请先删除它们`,
        );
    }
    return this.repo.removeTarget(id);
  }

  isRunning(targetId: number) {
    return this.running.has(targetId);
  }

  /** 触发部署（幂等防重入；调用方通常不 await） */
  deploy(targetId: number): Promise<void> {
    const hit = this.running.get(targetId);
    if (hit) return hit;
    const task = this.pipeline(targetId)
      .catch(() => { })
      .finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
    return task;
  }

  private async pipeline(targetId: number) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new Error(`部署目标不存在: ${targetId}`);
    // 画布 SSE 频道：状态迁移实时推给订阅了该 project 的浏览器（structure 不变，不走 refresh）
    const node = await this.canvasRepo.byId(target.nodeId);
    const ch = node ? `project:${node.projectId}` : null;
    const dep = await this.repo.createDeployment(targetId);
    const log: Log = async (line) => {
      if (line.trim()) await this.repo.appendLog(dep.id, line);
    };
    const setStatus = async (status: Deployment["status"], patch: Partial<Deployment> = {}) => {
      await this.repo.updateDeployment(dep.id, { status, ...patch });
      if (ch) events.publish(ch, { type: "status", targetId, status });
    };

    if (ch) {
      events.publish(ch, { type: "running", targetId, running: true });
      events.publish(ch, { type: "status", targetId, status: "queued" });
    }
    try {
      if (target.kind === "app") await this.deployApp(target, log, setStatus);
      else if (target.instanceOf) await this.deployLogicalDb(target, log);
      else await this.deployDb(target, log);
      await setStatus("success", { finishedAt: new Date() });
      await log("✅ 部署完成");
    } catch (error) {
      await log(`❌ ${(error as Error).message}`);
      await setStatus("failed", { finishedAt: new Date() });
    } finally {
      if (ch) events.publish(ch, { type: "running", targetId, running: false });
    }
  }

  /** SFTP 不做 shell 展开，`~` 是字面路径（No such file）——先解析成绝对路径 */
  private async resolveRemoteDir(
    client: { exec(cmd: string): Promise<{ stdout: string }> },
    dir: string,
  ): Promise<string> {
    if (!dir.startsWith("~")) return dir;
    const { stdout } = await client.exec('printf %s "$HOME"');
    return `${stdout.trim()}${dir.slice(1)}`;
  }

  // ── 部署前对账：远端同名容器归属校验，绝不动别人的容器 ──
  private async preflightCheck(
    target: DeployTarget,
    serverId: number,
    containerNames: string[],
    log: Log,
  ) {
    const remote = await this.serverService.docker(serverId);
    const containers = await remote.listContainers({ all: true });
    for (const name of containerNames) {
      const hit = containers.find((c) => c.Names.includes(`/${name}`));
      if (!hit) continue;
      const managed = hit.Labels?.["dockyard.managed"] === "true";
      const owner = hit.Labels?.["dockyard.target-id"];
      if (managed && owner === String(target.id)) {
        await log(`复用已有容器 ${name}（本工具管理）`);
        continue;
      }
      throw new Error(
        managed
          ? `远端容器 ${name} 属于另一个部署目标（#${owner}），已阻止部署`
          : `远端已存在非本工具管理的同名容器 ${name}，已阻止部署——请改名，或手动处理远端容器`,
      );
    }
  }

  // ── 逻辑库：不起容器，在宿主实例里 CREATE DATABASE + 专属账号 ──
  private async deployLogicalDb(target: DeployTarget, log: Log) {
    const instance = await this.repo.targetById(target.instanceOf!);
    if (!instance?.containerName) throw new Error("宿主实例不存在或缺少容器名");
    const serverId = await this.nodeServerId(instance);
    const remote = await this.serverService.docker(serverId);

    const containers = await remote.listContainers({ all: true });
    const hit = containers.find((c) => c.Names.includes(`/${instance.containerName}`));
    if (!hit) throw new Error(`宿主实例容器 ${instance.containerName} 不存在，请先部署实例「${instance.name}」`);
    if (
      hit.Labels?.["dockyard.managed"] !== "true" ||
      hit.Labels?.["dockyard.target-id"] !== String(instance.id)
    )
      throw new Error(`宿主实例容器 ${instance.containerName} 标签校验失败（非本工具创建），已阻止`);
    if (hit.State !== "running") throw new Error(`宿主实例「${instance.name}」未运行（${hit.State}）`);

    const creds = JSON.parse(decryptSecret(target.envJson!)) as { url: string; password: string };
    const cmds = logicalDbCommands(instance.dbType as DbType, target.name, creds.password);
    const container = remote.getContainer(hit.Id);
    const execIn = async (cmd: string[]): Promise<{ code: number; output: string }> => {
      // 不开 Tty：psql 检测到 TTY 会起 pager（less）把 exec 挂死。
      // hijack + demuxStream 拆多路复用的 stdout/stderr。
      const ex = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
      const stream = await ex.start({ hijack: true, stdin: false });
      let out = "";
      let err = "";
      const collect = (sink: (s: string) => void) =>
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            sink(chunk.toString("utf8"));
            cb();
          },
        });
      remote.modem.demuxStream(stream, collect((s) => (out += s)), collect((s) => (err += s)));
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      const { ExitCode } = await ex.inspect();
      return { code: ExitCode ?? -1, output: `${out}\n${err}`.trim() };
    };

    // 幂等：已存在时，只有"上次我们部署成功过"才跳过，否则视为别人的库，阻止
    const exists = await execIn(cmds.exists);
    // pg/mysql 查到返回 1；mongosh 打印 true/false——统一按词匹配，"false" 不误判
    if (exists.code === 0 && /\b(1|true)\b/.test(exists.output)) {
      const prev = await this.repo.lastSuccessfulDeployment(target.id);
      if (prev?.status === "success") {
        await log(`逻辑库 ${target.name} 已存在（上次部署创建），跳过`);
        return;
      }
      throw new Error(`实例「${instance.name}」中已存在名为 ${target.name} 的库且非本工具创建，已阻止`);
    }

    await log(`在实例「${instance.name}」中创建逻辑库 ${target.name} …`);
    for (const cmd of cmds.create) {
      const created = await execIn(cmd);
      if (created.code !== 0) throw new Error(`创建逻辑库失败：${created.output}`);
    }
    // 日志里不出现明文密码
    await log(`连接串：${creds.url.replace(creds.password, "****")}`);
  }

  // ── app：按项目来源分派（统一引擎，仅「代码获取 + 镜像构建」分支）──
  // github = 远端服务器拉代码、服务器上构建镜像；local = 本地客户端构建、推送镜像到服务器
  private async deployApp(
    target: DeployTarget,
    log: Log,
    setStatus: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
  ) {
    const { type, project } = await this.sourceOf(target);
    if (type === "local") {
      if (!project?.localPath) throw new Error("本地导入的项目缺少 localPath");
      return this.deployAppLocalBuild(target, project, log, setStatus);
    }
    return this.deployAppRemoteBuild(target, log, setStatus);
  }

  // ── app · 本地文件夹导入：本地构建 → docker save → 远端 load → compose up ──
  private async deployAppLocalBuild(
    target: DeployTarget,
    proj: Project,
    log: Log,
    setStatus: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
  ) {
    const repoDir = join(proj.localPath!, proj.rootDir ?? "");
    await setStatus("building");
    const shaProc = Bun.spawn(["git", "rev-parse", "--short=8", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "ignore" });
    const sha = ((await new Response(shaProc.stdout).text()).trim()) || `local-${Date.now()}`;
    await log(`本地构建 ${repoDir} @${sha} …`);

    const composePath = target.composePath ?? "docker-compose.yml";
    const composeBase = ["docker", "compose", "-f", composePath];
    await run(
      [...composeBase, "build", ...(target.serviceName ? [target.serviceName] : [])],
      repoDir, log,
    );

    // 用户决定怎么打包：镜像名从 compose 配置里读
    const imgProc = Bun.spawn(
      [...composeBase, "config", "--images", ...(target.serviceName ? [target.serviceName] : [])],
      { cwd: repoDir, stdout: "pipe" },
    );
    const images = (await new Response(imgProc.stdout).text()).trim().split("\n").filter(Boolean);
    if (images.length === 0) throw new Error("compose 没有产生任何镜像");

    await setStatus("transferring", { commitSha: sha });
    const remote = await this.serverService.docker(await this.nodeServerId(target));
    for (const image of images) {
      await log(`传输镜像 ${image} …`);
      const save = Bun.spawn(["docker", "save", image], { stdout: "pipe" });
      // dockerode 要 Node stream；Bun.stdout 是 Bun 扩展的 Web stream（类型不完全重合）
      await remote.loadImage(
        Readable.fromWeb(save.stdout as unknown as import("stream/web").ReadableStream),
      );
      if ((await save.exited) !== 0) throw new Error(`docker save 失败: ${image}`);
      await log(`已传输 ${image}`);
    }

    await setStatus("deploying");
    const serverId = await this.nodeServerId(target);

    // 对账用容器名：compose 项目名定死（远端 -p 一致），显式 container_name 优先
    const cfgProc = Bun.spawn([...composeBase, "config", "--format", "json"], {
      cwd: repoDir,
      stdout: "pipe",
    });
    const cfg = JSON.parse(await new Response(cfgProc.stdout).text()) as {
      name?: string;
      services?: Record<string, { container_name?: string }>;
    };
    const project = cfg.name ?? `dockyard-${target.id}`;
    const containerNames = Object.entries(cfg.services ?? {}).map(
      ([svc, def]) => def.container_name ?? `${project}-${svc}-1`,
    );
    if (containerNames.length > 0)
      await this.preflightCheck(target, serverId, containerNames, log);

    const client = await this.serverService.ssh(serverId);
    const remoteDir = await this.resolveRemoteDir(client, target.remoteDir ?? `~/dockyard/${target.name}`);
    await client.exec(`mkdir -p ${remoteDir}`);
    const sftp = await openSftp(client);
    const composeText = await Bun.file(join(repoDir, composePath)).text();
    await sftp.write(`${remoteDir}/docker-compose.yml`, composeText);
    // 用户 compose 的 env_file 是相对仓库的路径（远端没有目录树）——放空占位，
    // 否则 compose up 直接报 "env file not found"；真实值由 override 的 environment 注入
    for (const p of envFilePaths(composeText)) {
      await client.exec(
        `cd ${remoteDir} && mkdir -p "${join(".", p, "..")}" && [ -f "${p}" ] || printf '# dockyard 占位：真实环境变量在 docker-compose.dockyard.yml 的 environment 里\\n' > "${p}"`,
      );
    }
    if (target.envJson) await sftp.write(`${remoteDir}/.env`, decryptSecret(target.envJson));
    // 识别出的资源限制/服务级 environment 以 override compose 叠加（不改用户原 compose）
    if (target.overrideCompose)
      await sftp.write(`${remoteDir}/docker-compose.dockyard.yml`, decryptSecret(target.overrideCompose));
    await sftp.close();
    await log("远端 docker compose up -d …");
    // 注意：-f 一旦指定就只认列出的文件，base 必须一起带上
    const overrideArg = target.overrideCompose ? " -f docker-compose.yml -f docker-compose.dockyard.yml" : "";
    // 共享资源复用时只 up 业务服务子集（compose 仍会拉起 depends_on 依赖——复用场景的 compose 不应依赖被跳过的中间件）
    const upArg = target.upServices?.length ? ` ${target.upServices.join(" ")}` : "";
    if (upArg) await log(`只部署业务服务：${target.upServices!.join("、")}（中间件复用服务器共享资源）`);
    const up = await client.exec(`cd ${remoteDir} && docker compose -p ${project}${overrideArg} up -d${upArg}`);
    await log(up.stdout + up.stderr);
    if (up.code !== 0) throw new Error(`远端 compose up 失败（exit ${up.code}）`);

    // 有域名绑定 → edge 全量对账（路由 + 证书状态回写）
    const domains = await this.edge.domainsOfTarget(target.id);
    if (domains.length > 0) {
      await log("同步 edge 路由与证书 …");
      await this.edge.syncServer(serverId, log);
    }

    await this.repo.updateTarget(target.id, { lastKnownSha: sha, updateAvailable: false });
  }

  /** 带断线重连的短命令：连接失效则丢弃缓存重建后重试 */
  private async sshExec(serverId: number, cmd: string, retries = 2) {
    for (;;) {
      try {
        return await (await this.serverService.ssh(serverId)).exec(cmd);
      } catch (error) {
        if (retries-- <= 0) throw error;
        await this.serverService.dropSsh(serverId);
      }
    }
  }

  /**
   * 长跑命令（镜像构建）放远端后台执行 + 轮询日志文件：
   * 单条 exec 挂几十分钟会被中间网络/sshd 断开，通道一关命令就被 SIGHUP 杀掉；
   * nohup 后台 + 短轮询则断线只废掉一次轮询，重连后续跑，构建本体不受影响。
   */
  private async execLongRemote(
    serverId: number,
    cmd: string,
    tag: string,
    log: Log,
  ): Promise<{ code: number }> {
    const logFile = `/tmp/dockyard-long-${tag}.log`;
    const codeFile = `${logFile}.code`;
    const partFile = `${logFile}.part`;
    const quoted = cmd.replace(/'/g, `'\\''`);
    const start = await this.sshExec(
      serverId,
      // < /dev/null 必须：后台进程继承通道 stdin 会让 sshd 一直等 EOF，start 命令挂到构建结束才返回
      `rm -f ${logFile} ${codeFile} ${partFile} && nohup sh -c '${quoted}; echo $? > ${codeFile}' > ${logFile} 2>&1 < /dev/null & echo started`,
    );
    if (start.code !== 0) throw new Error(`远端后台命令启动失败：${start.stderr}`);
    let offset = 0;
    let delay = 4_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, delay));
      delay = 4_000;
      let res: { stdout: string; stderr: string; code: number | null };
      try {
        res = await this.sshExec(
          serverId,
          // 窗口读取：每轮最多 256KB——构建日志可达数 MB，弱网下全量重传必然反复失败（偏移不涨、越传越大）
          // 服务端报告本次实际输出字节数，避免客户端按解码后字符串估算偏移踩 UTF-8 边界
          `tail -c +${offset + 1} ${logFile} 2>/dev/null | head -c 262144 > ${partFile}; cat ${partFile};` +
            `printf '\\n__DC_SIZE__\\n'; wc -c < ${partFile}; printf '__DC_CODE__\\n'; cat ${codeFile} 2>/dev/null || true`,
          0,
        );
      } catch {
        await this.serverService.dropSsh(serverId); // 本轮轮询撞上断线：重建连接下轮续跑
        continue;
      }
      const [rest = "", codeText = ""] = res.stdout.split("__DC_CODE__\n");
      const [chunk = "", sizeText = "0"] = rest.split("\n__DC_SIZE__\n");
      const printed = Number(sizeText.trim());
      if (Number.isFinite(printed) && printed > 0) {
        offset += printed;
        if (chunk) await log(chunk.trimEnd());
        if (printed >= 262144) delay = 300; // 读满窗口说明积压严重，加速排空
      }
      const codeStr = codeText.trim();
      // 命令已结束但日志还有积压时继续排空（失败上下文在文件尾部），printed==0 说明已追到 EOF
      if (codeStr !== "" && (!Number.isFinite(printed) || printed === 0)) {
        const code = Number(codeStr);
        return { code: Number.isFinite(code) ? code : -1 };
      }
    }
  }

  // ── app · GitHub 导入：远端服务器拉代码 → 服务器上构建镜像 → compose up（免镜像传输）──
  private async deployAppRemoteBuild(
    target: DeployTarget,
    log: Log,
    setStatus: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
  ) {
    if (!target.repoUrl) throw new Error("GitHub 导入的部署目标缺少 repoUrl");
    const ownerRepo = parseOwnerRepo(target.repoUrl);
    const branch = target.branch ?? "main";
    const serverId = await this.nodeServerId(target);
    const client = await this.serverService.ssh(serverId);
    const authedUrl = await this.github.authedRepoUrl(ownerRepo);
    // git 报错会把整条带 token 的 URL 打进 stderr——所有日志/异常先脱敏
    const cred = authedUrl.match(/^https:\/\/([^@]+)@/)?.[1];
    const redact = (s: string) => (cred ? s.split(cred).join("***") : s);
    const rlog: Log = async (s) => log(redact(s));
    const srcDir = await this.resolveRemoteDir(client, `~/dockyard/src/${target.id}-${target.name}`);
    const composePath = target.composePath ?? "docker-compose.yml";

    // 1. 代码获取：远端 clone / fetch（token 不落盘——clone 后立即重写 remote）
    await setStatus("building");
    const probe = await client.exec(`[ -d "${srcDir}/.git" ] && echo yes || echo no`);
    if (probe.stdout.trim() !== "yes") {
      await rlog(`远端克隆 ${ownerRepo} …`);
      await client.exec(`mkdir -p "$(dirname "${srcDir}")"`);
      const clone = await client.exec(`git clone "${authedUrl}" "${srcDir}"`);
      if (clone.code !== 0) throw new Error(redact(`远端克隆失败（exit ${clone.code}）\n${clone.stderr}`));
      await client.exec(`git -C "${srcDir}" remote set-url origin "https://github.com/${ownerRepo}.git"`);
    }
    const fetch = await client.exec(`git -C "${srcDir}" fetch "${authedUrl}" "${branch}" && git -C "${srcDir}" checkout FETCH_HEAD`);
    if (fetch.code !== 0) throw new Error(redact(`远端拉取失败（exit ${fetch.code}）\n${fetch.stderr}`));
    const sha = (await client.exec(`git -C "${srcDir}" rev-parse --short=8 HEAD`)).stdout.trim();
    await rlog(`远端构建 ${ownerRepo}@${sha} …`);

    // 2. env_file 占位（compose config/build 要求文件存在；真实值由 override/.env 注入）。
    // compose 把 env_file 解析为「相对 compose 文件所在目录」，子目录 compose（deploy/x.yml 写 ../apps/.env）必须同样解析
    const composeText = (await client.exec(`cat "${srcDir}/${composePath}"`)).stdout;
    for (const p of envFilePaths(composeText)) {
      const rel = normalize(join(dirname(composePath), p));
      if (rel.startsWith("..") || rel.startsWith("/")) continue; // 逃出仓库的路径不创建
      await client.exec(
        `cd "${srcDir}" && mkdir -p "$(dirname "${rel}")" && [ -f "${rel}" ] || printf '# dockyard 占位\\n' > "${rel}"`,
      );
    }

    // 3. 服务器上构建镜像：后台跑 + 轮询（断线重连不杀构建，全量输出进部署日志）。
    // 逐服务串行构建——小内存 VPS 并行构建多个镜像会 OOM 到 sshd 都无响应
    const buildCmd = target.serviceName
      ? `docker compose -f "${composePath}" build ${target.serviceName}`
      : `for s in $(docker compose -f "${composePath}" config --services); do docker compose -f "${composePath}" build "$s" || exit 1; done`;
    const build = await this.execLongRemote(
      serverId,
      `cd "${srcDir}" && ${buildCmd}`,
      `build-${target.id}`,
      rlog,
    );
    if (build.code !== 0) throw new Error(`远端构建失败（exit ${build.code}）`);

    // 4. 对账 + 环境变量/override 注入 + up
    await setStatus("deploying", { commitSha: sha });
    const cfgOut = await this.sshExec(serverId, `cd "${srcDir}" && docker compose -f "${composePath}" config --format json`);
    if (cfgOut.code !== 0) throw new Error(redact(`远端 compose config 失败：${cfgOut.stderr}`));
    const cfg = JSON.parse(cfgOut.stdout) as {
      name?: string;
      services?: Record<string, { container_name?: string }>;
    };
    const projectName = cfg.name ?? `dockyard-${target.id}`;
    const containerNames = Object.entries(cfg.services ?? {}).map(
      ([svc, def]) => def.container_name ?? `${projectName}-${svc}-1`,
    );
    if (containerNames.length > 0)
      await this.preflightCheck(target, serverId, containerNames, log);

    // 构建期间缓存连接可能已被丢弃重建——拿当前可用连接
    const fresh = await this.serverService.ssh(serverId);
    const sftp = await openSftp(fresh);
    if (target.envJson) await sftp.write(`${srcDir}/.env`, decryptSecret(target.envJson));
    if (target.overrideCompose)
      await sftp.write(`${srcDir}/docker-compose.dockyard.yml`, decryptSecret(target.overrideCompose));
    await sftp.close();
    await rlog("远端 docker compose up -d …");
    const overrideArg = target.overrideCompose ? ` -f "${composePath}" -f docker-compose.dockyard.yml` : ` -f "${composePath}"`;
    // 共享资源复用时只 up 业务服务子集（同本地构建路径的语义）
    const upArg = target.upServices?.length ? ` ${target.upServices.join(" ")}` : "";
    if (upArg) await rlog(`只部署业务服务：${target.upServices!.join("、")}（中间件复用服务器共享资源）`);
    const up = await this.sshExec(serverId, `cd "${srcDir}" && docker compose -p ${projectName}${overrideArg} up -d${upArg}`);
    await rlog(up.stdout + up.stderr);
    if (up.code !== 0) throw new Error(`远端 compose up 失败（exit ${up.code}）`);

    // 5. 域名绑定 → edge 全量对账
    const domains = await this.edge.domainsOfTarget(target.id);
    if (domains.length > 0) {
      await log("同步 edge 路由与证书 …");
      await this.edge.syncServer(serverId, log);
    }

    await this.repo.updateTarget(target.id, { lastKnownSha: sha, updateAvailable: false });
  }

  // ── db：模板 compose + .env 推远端 → up ──
  private async deployDb(target: DeployTarget, log: Log) {
    if (!target.envJson) throw new Error("数据库目标缺少模板内容");
    if (!target.containerName) throw new Error("数据库目标缺少容器名（旧数据？重建该目标）");
    const rendered = JSON.parse(decryptSecret(target.envJson)) as { compose: string; env: string };
    const serverId = await this.nodeServerId(target);
    await this.preflightCheck(target, serverId, [target.containerName], log);
    const client = await this.serverService.ssh(serverId);
    const remoteDir = await this.resolveRemoteDir(client, target.remoteDir ?? `~/dockyard/${target.name}`);
    await client.exec(`mkdir -p ${remoteDir}`);
    const sftp = await openSftp(client);
    await sftp.write(`${remoteDir}/docker-compose.yml`, rendered.compose);
    await sftp.write(`${remoteDir}/.env`, rendered.env);
    await sftp.close();
    await log(`推送 ${target.dbType} 模板到 ${remoteDir}`);
    const up = await client.exec(`cd ${remoteDir} && docker compose up -d`);
    await log(up.stdout + up.stderr);
    if (up.code !== 0) throw new Error(`远端 compose up 失败（exit ${up.code}）`);
  }

  /** target → node → serverId（deploy 位于 canvas 之上，可直接查） */
  private async nodeServerId(target: DeployTarget): Promise<number> {
    const node = await this.canvasRepo.byId(target.nodeId);
    if (!node) throw new Error("画布节点已删除");
    return node.serverId;
  }
}
