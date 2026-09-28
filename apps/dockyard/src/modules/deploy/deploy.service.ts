import { join } from "node:path";
import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { openSftp } from "@meitaim/ssh/sftp";
import type { AppPaths } from "../../shared/paths";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import type { DeployTarget, Deployment } from "../../shared/schema";
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
  type DetectResult,
} from "./detect";
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

export function parseOwnerRepo(repoUrl: string): string {
  const m =
    repoUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ??
    repoUrl.match(/^([^/\s]+\/[^/\s]+)$/);
  if (!m) throw new Error(`无法解析 GitHub 仓库: ${repoUrl}`);
  return m[1]!;
}

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
  ) { }

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
    nodeId: number; name: string; repoUrl: string; branch: string;
    composePath: string; serviceName?: string; remoteDir: string;
    envText?: string; // 识别结果合并出的 .env（enc1: 加密落库）
    overrideCompose?: string | null; // 资源限制 override（compose -f 叠加）
    dependsOn?: number[]; // 依赖的 db target id（画布连线 + 连接串引用血缘）
    domains?: { hostname: string; serviceName?: string; targetPort: number }[];
  }) {
    parseOwnerRepo(input.repoUrl); // 提前校验
    await this.assertNameFree(input.nodeId, "app", input.name);
    const { envText, overrideCompose, domains, dependsOn, ...base } = input;
    const target = await this.repo.createTarget({
      kind: "app",
      ...base,
      ...(dependsOn?.length ? { dependsOn } : {}),
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
    const dep = await this.repo.createDeployment(targetId);
    const log: Log = async (line) => {
      if (line.trim()) await this.repo.appendLog(dep.id, line);
    };
    const setStatus = (status: Deployment["status"], patch: Partial<Deployment> = {}) =>
      this.repo.updateDeployment(dep.id, { status, ...patch });

    try {
      if (target.kind === "app") await this.deployApp(target, log, setStatus);
      else if (target.instanceOf) await this.deployLogicalDb(target, log);
      else await this.deployDb(target, log);
      await setStatus("success", { finishedAt: new Date() });
      await log("✅ 部署完成");
    } catch (error) {
      await log(`❌ ${(error as Error).message}`);
      await setStatus("failed", { finishedAt: new Date() });
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

  // ── app：clone → 本地构建 → 传输镜像 → 远端 compose up ──
  private async deployApp(
    target: DeployTarget,
    log: Log,
    setStatus: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
  ) {
    const ownerRepo = parseOwnerRepo(target.repoUrl!);
    const branch = target.branch ?? "main";
    const repoDir = join(this.paths.reposDir, `target-${target.id}`);
    const authedUrl = await this.github.authedRepoUrl(ownerRepo);

    await setStatus("building");
    if (!existsSync(repoDir)) {
      await log(`克隆 ${ownerRepo} …`);
      await run(["git", "clone", authedUrl, repoDir], this.paths.reposDir, log);
      // token 不落盘：clone 后重写 remote 为无凭据 URL
      await run(
        ["git", "remote", "set-url", "origin", `https://github.com/${ownerRepo}.git`],
        repoDir, log,
      );
    }
    await run(["git", "fetch", authedUrl, branch], repoDir, log);
    await run(["git", "checkout", "FETCH_HEAD"], repoDir, log);
    const shaProc = Bun.spawn(["git", "rev-parse", "--short=8", "HEAD"], { cwd: repoDir, stdout: "pipe" });
    const sha = (await new Response(shaProc.stdout).text()).trim();
    await log(`构建 ${ownerRepo}@${sha} …`);

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
    const up = await client.exec(`cd ${remoteDir} && docker compose -p ${project}${overrideArg} up -d`);
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
