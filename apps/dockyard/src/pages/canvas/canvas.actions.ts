import { status, t } from "elysia";
import { defineRoutes } from "../../../.elysiax";
import { decryptSecret } from "../../shared/crypto";
import { events } from "../../shared/events";
import { containerStatesOf } from "../deploy/container-poller";
import type { DeployTarget } from "../../shared/schema";
import { LOGICAL_DB_SUPPORT, type DbType } from "../deploy/db-templates";
import type { RepoBrief } from "../github/github.service";
import type { SharedEnv } from "../resources/resources.service";
import { detectToEnvText, detectToOverrideCompose, guessDbType, type DetectResult, type DetectedService } from "../deploy/detect";
import type { BoardModel, CardModel } from "./canvas.model";
import type { ProjectService } from "../projects/projects.service";
import type { ServerService } from "../servers/servers.service";
import type { DeployService } from "../deploy/deploy.service";
import type { CanvasService } from "./canvas.service";

/** 共享资源匹配（部署前置检查）：识别出的中间件服务 vs 目标服务器的共享资源清单 */
export type SharedMatch = { service: string; displayUrl: string } & SharedEnv;

async function sharedMatchesOf(
  di: { get(name: string): any },
  nodeId: number,
  services: DetectedService[],
): Promise<SharedMatch[]> {
  const node = await di.get("canvasService").byId(nodeId);
  if (!node) return [];
  const shared: SharedEnv[] = await di.get("resourceService").sharedEnvOf(node.serverId);
  return services.flatMap((s) => {
    const dbType = guessDbType(s);
    const hit = dbType ? shared.find((sh) => sh.dbType === dbType) : undefined;
    return hit
      ? [{ service: s.name, ...hit, displayUrl: hit.url.replace(/(\/\/[^:/@]+:)[^@]+(@)/, "$1•••$2") }]
      : [];
  });
}

/** Console 会话：ws 连接 → docker exec TTY 流（close 时必须 end，否则远端 sh 残留） */
const consoleSessions = new Map<unknown, { exec: { resize(dims: { h: number; w: number }): Promise<unknown> }; stream: { write(d: string): unknown; end(): unknown; on(ev: string, fn: (c: Buffer) => void): unknown } }>();

interface Ctx {
  project: ProjectService;
  server: ServerService;
  canvas: CanvasService;
  deploy: DeployService;
}

/** 跨上下文组合：canvas 只存节点，服务器/部署信息在此拼装 */
async function canvasData(ctx: Ctx, projectId: number) {
  const [nodes, servers] = await Promise.all([ctx.canvas.nodesOf(projectId), ctx.server.list()]);
  const byId = new Map(servers.map((s) => [s.id, s]));
  const cards: CardModel[] = [];
  const rawTargets = new Map<number, DeployTarget>(); // 依赖边派生用（edgesOfTarget 要原始行）
  for (const node of nodes) {
    const server = byId.get(node.serverId);
    if (!server) continue;
    const targets = [];
    for (const target of await ctx.deploy.targetsOfNode(node.id)) {
      rawTargets.set(target.id, target);
      // 逻辑库（instanceOf 非空）：把连接串带给前端复制按钮；本地控制面，落库已 enc1: 加密
      let url: string | undefined;
      if (target.kind === "db" && target.instanceOf && target.envJson) {
        try {
          url = (JSON.parse(decryptSecret(target.envJson)) as { url?: string }).url;
        } catch {}
      }
      // app 的域名绑定（edge 反代 + 证书状态徽章）；serviceName 用于下沉到 compose 服务行
      const domains = target.kind === "app"
        ? (await ctx.deploy.domainsOfTarget(target.id)).map((d) => ({
          hostname: d.hostname,
          sslStatus: d.sslStatus,
          dnsStatus: d.dnsStatus,
          serviceName: d.serviceName,
          targetPort: d.targetPort,
        }))
        : [];
      // compose 服务清单（创建落库/存量惰性补全）；容器状态在下方按服务器聚合后填入
      const svcDoc = target.kind === "app"
        ? await ctx.deploy.servicesOfTarget(target)
        : { project: null, services: [] };
      targets.push({
        id: target.id,
        kind: target.kind,
        name: target.name,
        logical: Boolean(target.instanceOf),
        url,
        // 归属到具体服务的域名下沉到服务行；无归属的留 target 顶部
        domains: domains.filter((d) => !d.serviceName || !svcDoc.services.some((s) => s.name === d.serviceName)),
        services: svcDoc.services.map((s) => ({
          ...s,
          domains: domains.filter((d) => d.serviceName === s.name),
          ...(target.serviceLayout?.[s.name] ?? {}),
        })),
        edges: [], // 下方知道全部 target 名字后回填
        groupId: target.groupId,
        x: target.x,
        y: target.y,
        w: target.w,
        h: target.h,
        updateAvailable: target.updateAvailable,
      });
    }
    const { id, name, user, host, port, dockerStatus, dockerVersion } = server;
    const groups = (await ctx.canvas.groupsOf(node.id)).map((g) => ({
      id: g.id, name: g.name, x: g.x, y: g.y, w: g.w, h: g.h,
    }));
    cards.push({
      node: { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h },
      server: { id, name, user, host, port, dockerStatus, dockerVersion },
      targets,
      groups,
    });
  }
  // 服务级依赖边（client 派生 React Flow 边）；存量 dependsOn 由门面惰性派生为 service=null 的边
  const nameOfTarget = new Map<number, string>();
  for (const c of cards)
    for (const t of c.targets) nameOfTarget.set(t.id, t.name);
  for (const c of cards)
    for (const t of c.targets) {
      const raw = rawTargets.get(t.id);
      if (!raw) continue;
      t.edges = ctx.deploy.edgesOfTarget(raw).map((e) => ({
        service: e.service,
        db: e.db,
        dbName: nameOfTarget.get(e.db) ?? `#${e.db}`,
      }));
    }
  return {
    servers: servers.map(({ id, name }) => ({ id, name })),
    cards,
  };
}

const ctxOf = (di: {
  get(k: "projectService"): ProjectService;
  get(k: "serverService"): ServerService;
  get(k: "canvasService"): CanvasService;
  get(k: "deployService"): DeployService;
}): Ctx => ({
  project: di.get("projectService"),
  server: di.get("serverService"),
  canvas: di.get("canvasService"),
  deploy: di.get("deployService"),
});

const TABS = ["deployments", "source", "hardware", "network", "env", "monitor", "console", "backups"] as const;

const svcEditSchema = t.Object({
  name: t.String(),
  exposed: t.Boolean(),
  port: t.Optional(t.Number()),
  domain: t.Optional(t.String()),
  cpuCores: t.Optional(t.Number()),
  memoryMb: t.Optional(t.Number()),
  env: t.Record(t.String(), t.String()),
});

export default defineRoutes()
  // ── client 壳的项目解析 ──
  .get("/projects", async ({ di }) =>
    (await di.get("projectService").list()).map((p) => ({ id: p.id, name: p.name })))
  // 缺省项目：最近一个（无 → 404，client 显示「先建项目」）
  .get("/latest", async ({ di, set }) => {
    const latest = (await di.get("projectService").list()).at(-1);
    if (!latest) {
      return status(404, { error: "还没有项目" });
    }
    return { projectId: latest.id };
  })
  // 本地项目行点击：按路径幂等落库
  .get("/resolve-local", { query: t.Object({ path: t.String({ minLength: 1 }) }) }, async ({ di, query }) => ({
    projectId: (await di.get("projectService").ensureLocal(query.path)).id,
  }))
  // 画布数据：结构 + 布局（无实时；视图模型见 canvas.model.ts）。
  // client 只在挂载和 refresh（结构变更）时拉取，不轮询
  .get("/projects/:projectId/board", { params: t.Object({ projectId: t.Number() }) }, async ({ di, params }): Promise<BoardModel> => {
    return canvasData(ctxOf(di), params.projectId);
  })
  // 实时状态 SSE：部署 status/running（deploy.service 推）+ 容器 state（container-poller 推）。
  // 首帧发该 project 的容器状态快照（订阅即齐，不等下轮 diff）
  .get("/projects/:projectId/events", { params: t.Object({ projectId: t.Number() }) }, ({ params }) =>
    events.stream(`project:${params.projectId}`, () => containerStatesOf(params.projectId)))
  .post(
    "/projects/:projectId/nodes",
    {
      params: t.Object({ projectId: t.Number() }),
      body: t.Object({ serverId: t.Number(), x: t.Number(), y: t.Number() }),
    },
    async ({ di, params, body, set }) => {
      await ctxOf(di).canvas.addNode(params.projectId, body.serverId, body.x, body.y);
      set.status = 204;
    },
  )
  // 拖拽/resize 持久化
  .patch(
    "/nodes/:id",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        w: t.Optional(t.Number()),
        h: t.Optional(t.Number()),
      }),
    },
    async ({ di, params, body, set }) => {
      await ctxOf(di).canvas.moveNode(params.id, body);
      set.status = 204;
    },
  )
  .delete("/nodes/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    await ctxOf(di).canvas.removeNode(params.id);
    set.status = 204;
  })
  // ── 服务分组：服务器卡内的命名容器（Railway Service Group）──
  .post(
    "/nodes/:id/groups",
    { params: t.Object({ id: t.Number() }), body: t.Object({ name: t.String({ minLength: 1 }) }) },
    async ({ di, params, body, set }) => {
      await ctxOf(di).canvas.addGroup(params.id, body.name);
      set.status = 204;
    },
  )
  .patch(
    "/groups/:id",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        name: t.Optional(t.String()),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        w: t.Optional(t.Number()),
        h: t.Optional(t.Number()),
      }),
    },
    async ({ di, params, body, set }) => {
      await ctxOf(di).canvas.updateGroup(params.id, body);
      set.status = 204;
    },
  )
  // 删除分组：组内目标回落到服务器卡（deploy 上下文清 groupId）
  .delete("/groups/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    await di.get("deployService").clearGroup(params.id);
    await ctxOf(di).canvas.removeGroup(params.id);
    set.status = 204;
  })
  // 向导数据：gh CLI 列出账号仓库做选择器（gh 未登录时降级为空列表手填）；
  // 本地文件夹导入的项目直接给出识别结果（跳过仓库选择步）
  .get("/new-app/:nodeId", { params: t.Object({ nodeId: t.Number() }) }, async ({ di, params }) => {
    const node = await di.get("canvasService").byId(params.nodeId);
    const project = node ? await di.get("projectService").byId(node.projectId) : undefined;
    const isLocal = project?.sourceType === "local" || (!!project?.localPath && !project?.repoUrl);
    if (isLocal && project?.localPath) {
      const svc = di.get("deployService");
      const detect = await svc.detectLocal({ localPath: project.localPath, rootDir: project.rootDir ?? undefined });
      const dbRefs = await svc.dbRefsOfNode(params.nodeId);
      const sharedMatches = await sharedMatchesOf(di, params.nodeId, detect.services);
      return {
        mode: "local" as const,
        carry: {
          nodeId: params.nodeId,
          name: project.slug,
          repoUrl: project.repoUrl ?? "",
          branch: project.branch ?? "main",
          remoteDir: `~/dockyard/${project.slug}`,
        },
        detect,
        envText: detectToEnvText(detect),
        dbRefs,
        sharedMatches,
      };
    }
    let repos: RepoBrief[] = [];
    let ghError: string | undefined;
    try {
      repos = await di.get("githubService").listRepos();
    } catch (e) {
      ghError = `仓库列表拉取失败（${(e as Error).message}），可手动输入 owner/repo`;
    }
    // 项目 = 仓库：预填项目绑定的 repoUrl（仍可改——同一仓库可以多方式部署）
    return { mode: "github" as const, repos, error: ghError, prefillRepo: project?.repoUrl ?? undefined };
  })
  // 向导 step1 → step2：克隆仓库，读 openship.json / compose 自动识别
  .post(
    "/detect",
    {
      body: t.Object({
        nodeId: t.Number(),
        name: t.String({ minLength: 1 }),
        repoUrl: t.String({ minLength: 1 }),
        branch: t.String({ default: "main" }),
        remoteDir: t.String({ minLength: 1 }),
      }),
    },
    async ({ di, body }) => {
      // 识别失败：deployService 抛 ServiceError，框架统一映射（controller 不写 try/catch 回显）
      const detect = await di.get("deployService").detectRepo(body);
      const dbRefs = await di.get("deployService").dbRefsOfNode(body.nodeId);
      const sharedMatches = await sharedMatchesOf(di, body.nodeId, detect.services);
      return { carry: body, detect, envText: detectToEnvText(detect), dbRefs, sharedMatches };
    },
  )
  .get("/new-db/:nodeId", { params: t.Object({ nodeId: t.Number() }) }, async ({ di, params }) => ({
    instances: await di.get("deployService").instancesOfNode(params.nodeId, "postgres"),
  }))
  // dbType 切换时拉取该服务器上可托管的同类型实例（redis 不支持逻辑库）
  .get("/instances", async ({ di, query }) => {
    const dbType = (query.dbType ?? "postgres") as DbType;
    const instances = LOGICAL_DB_SUPPORT[dbType]
      ? await di.get("deployService").instancesOfNode(Number(query.nodeId), dbType)
      : [];
    return { instances };
  })
  .post(
    "/targets/app",
    {
      body: t.Object({
        nodeId: t.Number(),
        name: t.String({ minLength: 1 }),
        repoUrl: t.Optional(t.String()),
        branch: t.String({ default: "main" }),
        composePath: t.String({ default: "docker-compose.yml" }),
        remoteDir: t.String({ minLength: 1 }),
        envText: t.Optional(t.String()),
        services: t.Array(svcEditSchema),
        depIds: t.Array(t.Number()),
        reuse: t.Array(t.String()),
      }),
    },
    async ({ di, body, set }) => {
      const svc = di.get("deployService");
      const services: DetectedService[] = body.services.map((s) => ({
        name: s.name,
        exposed: s.exposed && s.port !== undefined,
        port: s.exposed ? s.port : undefined,
        domain: s.domain,
        cpuCores: s.cpuCores,
        memoryMb: s.memoryMb,
        env: s.env as unknown as DetectedService["env"],
      }));
      // 共享资源复用：reuse 里的中间件不部署，只注入共享变量
      const reused = new Set(body.reuse);
      if (reused.size > 0 && reused.size === services.length) {
        return status(422, { error: "所有服务都选择了复用共享资源——至少保留一个业务服务需要部署" });
      }
      const upServices = reused.size > 0
        ? services.map((s) => s.name).filter((n) => !reused.has(n))
        : undefined;
      const target = await svc.createAppTarget({
        nodeId: body.nodeId,
        name: body.name,
        repoUrl: body.repoUrl?.trim() || undefined,
        branch: body.branch,
        composePath: body.composePath,
        remoteDir: body.remoteDir,
        envText: body.envText,
        overrideCompose: detectToOverrideCompose({ services }),
        dependsOn: body.depIds,
        domains: services
          .filter((s) => s.domain && s.port)
          .map((s) => ({ hostname: s.domain!, targetPort: s.port!, serviceName: s.name })),
        services,
        upServices,
      });
      // Railway 式：创建即部署，client 直接换日志面板盯进度
      void svc.deploy(target.id);
      return { targetId: target.id };
    },
  )
  .post(
    "/targets/db",
    {
      body: t.Object({
        nodeId: t.Number(),
        name: t.String({ minLength: 1 }),
        dbType: t.Union([t.Literal("postgres"), t.Literal("mysql"), t.Literal("redis"), t.Literal("mongo")]),
        instanceId: t.Optional(t.String()),
        remoteDir: t.Optional(t.String()),
      }),
    },
    async ({ di, body }) => {
      const svc = di.get("deployService");
      const instanceId = body.instanceId ? Number(body.instanceId) : 0;
      const target = instanceId
        ? await svc.createLogicalDbTarget({ nodeId: body.nodeId, name: body.name, instanceId })
        : await svc.createDbTarget({
          nodeId: body.nodeId,
          name: body.name,
          dbType: body.dbType,
          remoteDir: body.remoteDir ?? "",
        });
      void svc.deploy(target.id); // 创建即部署
      return { ok: true as const };
    },
  )
  .post("/targets/:id/deploy", { params: t.Object({ id: t.Number() }) }, ({ di, params, set }) => {
    void di.get("deployService").deploy(params.id); // 后台跑，状态迁移走 SSE 推到画布
    set.status = 204;
  })
  .get(
    "/targets/:id/log",
    { params: t.Object({ id: t.Number() }), query: t.Object({ dep: t.Optional(t.Numeric()) }) },
    async ({ di, params, query, set }) => {
      const svc = di.get("deployService");
      const target = await svc.targetById(params.id);
      if (!target) {
        return status(404, { error: "部署目标不存在" });
      }
      const dep = query.dep ? await svc.deploymentById(query.dep) : await svc.latestDeployment(target.id);
      return { target, dep };
    },
  )
  .get(
    "/targets/:id/log-body",
    { params: t.Object({ id: t.Number() }), query: t.Object({ dep: t.Optional(t.Numeric()) }) },
    async ({ di, params, query }) => {
      const svc = di.get("deployService");
      const dep = query.dep ? await svc.deploymentById(query.dep) : await svc.latestDeployment(params.id);
      return dep?.logText ?? "";
    },
  )
  // ── 服务抽屉（Railway Service View）数据：各 Tab 按需取数 ──
  .get(
    "/targets/:id/service",
    {
      params: t.Object({ id: t.Number() }),
      query: t.Object({ svc: t.Optional(t.String()), tab: t.Optional(t.String()) }),
    },
    async ({ di, params, query, set }) => {
      const svc = di.get("deployService");
      const target = await svc.targetById(params.id);
      if (!target) {
        return status(404, { error: "部署目标不存在" });
      }
      const tab = (TABS.includes(query.tab as (typeof TABS)[number]) ? query.tab : "deployments") as (typeof TABS)[number];
      return {
        target,
        svc: query.svc || undefined,
        tab,
        deployments: tab === "deployments" ? await svc.deploymentsOfTarget(params.id) : undefined,
        envText: tab === "env" && query.svc ? await svc.serviceEnvText(params.id, query.svc) : undefined,
        dbRefs: tab === "env" && query.svc ? await svc.dbRefsOfNode(target.nodeId) : undefined,
        sharedEnv: tab === "env" ? await svc.sharedEnvOfTarget(params.id) : undefined,
        selectedDeps: tab === "env" && query.svc
          ? svc.edgesOfTarget(target).filter((e) => e.service === query.svc).map((e) => e.db)
          : undefined,
        domains: tab === "network" ? await svc.domainsOfTarget(params.id) : undefined,
        resources: tab === "hardware" && query.svc ? await svc.serviceResources(params.id, query.svc) : undefined,
        backups: tab === "backups" ? await svc.backupsOf(params.id) : undefined,
        metrics: tab === "monitor" ? await svc.serviceStats(params.id, query.svc || undefined) : undefined,
      };
    },
  )
  .get(
    "/targets/:id/service/metrics",
    { params: t.Object({ id: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, query }) => di.get("deployService").serviceStats(params.id, query.svc),
  )
  .post(
    "/targets/:id/service/restart",
    { params: t.Object({ id: t.Number() }), body: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, body }) => {
      await di.get("deployService").restartService(params.id, body.svc || undefined);
      // 结构不变（容器状态走 SSE），不刷新画布
      return { notice: "已发送重启" };
    },
  )
  .get(
    "/targets/:id/service/logs",
    { params: t.Object({ id: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, query }) => di.get("deployService").serviceLogs(params.id, query.svc),
  )
  .post(
    "/targets/:id/service/env",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.String({ minLength: 1 }), envText: t.Optional(t.String()), depIds: t.Array(t.Number()) }),
    },
    async ({ di, params, body }) => {
      const svc = di.get("deployService");
      await svc.setServiceEnv(params.id, body.svc, body.envText ?? "");
      // 依赖勾选同步服务级连线：整组替换该服务的边，app 级/其他服务的边不动
      const target = await svc.targetById(params.id);
      if (target) {
        const kept = svc.edgesOfTarget(target).filter((e) => e.service !== body.svc);
        const added = body.depIds.map((db) => ({ service: body.svc, db }));
        await svc.setDependsOn(params.id, [...kept, ...added]);
      }
      return { notice: "已保存，重新部署后生效" };
    },
  )
  .post(
    "/targets/:id/service/resources",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.String({ minLength: 1 }), cpuCores: t.Optional(t.Number()), memoryMb: t.Optional(t.Number()) }),
    },
    async ({ di, params, body }) => {
      await di.get("deployService").setServiceResources(params.id, body.svc, body.cpuCores, body.memoryMb);
      // 资源限制只写 override compose，画布结构不变
      return { notice: "已保存，重新部署后生效" };
    },
  )
  .post(
    "/targets/:id/service/domains",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.Optional(t.String()), hostname: t.String({ minLength: 1 }), targetPort: t.Number() }),
    },
    async ({ di, params, body }) => {
      const svc = di.get("deployService");
      await svc.addDomain(params.id, { hostname: body.hostname, targetPort: body.targetPort, serviceName: body.svc || undefined });
      await svc.syncEdge(params.id);
      return { notice: "已绑定" };
    },
  )
  .delete(
    "/targets/:id/service/domains/:domainId",
    { params: t.Object({ id: t.Number(), domainId: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params }) => {
      await di.get("deployService").removeDomain(params.domainId);
      return { notice: "已解绑" };
    },
  )
  // Source Tab：来源配置（GitHub 仓库/分支/compose 路径；本地导入显示本地路径）
  .post(
    "/targets/:id/source",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        repoUrl: t.Optional(t.String()),
        branch: t.Optional(t.String()),
        composePath: t.Optional(t.String()),
        remoteDir: t.Optional(t.String()),
      }),
    },
    async ({ di, params, body }) => {
      await di.get("deployService").updateSource(params.id, body);
      return { notice: "已保存，下次部署生效" };
    },
  )
  // Console Tab：容器交互式终端（xterm ←→ WS ←→ docker exec TTY）
  .ws("/console/:id", {
    query: t.Object({ svc: t.Optional(t.String()) }),
    async open(ws) {
      // Elysia 2.0：ws handler 收到的是上下文与 socket 方法的合并对象（无 .data 层）
      const ctx = ws as unknown as {
        di: { get(name: string): any };
        params: { id: string };
        query: { svc?: string };
        send(d: string): unknown;
        close(): unknown;
      };
      try {
        const session = await ctx.di.get("deployService").openConsole(Number(ctx.params.id), ctx.query.svc || undefined);
        consoleSessions.set(ws, session);
        session.stream.on("data", (chunk: Buffer) => ctx.send(chunk.toString("utf8")));
        session.stream.on("end", () => ctx.close());
        session.stream.on("error", () => ctx.close());
      } catch (e) {
        ctx.send(`\r\n\x1b[31m连接失败：${(e as Error).message}\x1b[0m\r\n`);
        ctx.close();
      }
    },
    message(ws, raw) {
      const session = consoleSessions.get(ws);
      if (!session) return;
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : String(raw)) as
          | { type: "input"; data: string }
          | { type: "resize"; cols: number; rows: number };
        if (msg.type === "input") session.stream.write(msg.data);
        else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0)
          session.exec.resize({ h: msg.rows, w: msg.cols }).catch(() => {});
      } catch { /* 坏帧忽略 */ }
    },
    close(ws) {
      const session = consoleSessions.get(ws);
      consoleSessions.delete(ws);
      session?.stream.end();
    },
  })
  .post("/targets/:id/backup", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const file = await di.get("deployService").backupNow(params.id);
    return { notice: `已备份：${file}` };
  })
  .get(
    "/backups/:id/:file",
    { params: t.Object({ id: t.Number(), file: t.String() }) },
    async ({ di, params, set }) => {
      const path = di.get("deployService").backupFilePath(params.id, params.file);
      if (!path) return status(404, "备份不存在");
      set.headers["content-disposition"] = `attachment; filename="${params.file}"`;
      set.headers["content-type"] = "application/gzip";
      return Bun.file(path);
    },
  )
  // ── 变量抽屉数据：已有 app 改 .env + 数据库依赖 ──
  .get("/targets/:id/env", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    const svc = di.get("deployService");
    const target = await svc.targetById(params.id);
    if (!target || target.kind !== "app") {
      return status(404, { error: "部署目标不存在" });
    }
    return {
      target,
      envText: svc.envTextOf(target),
      dbRefs: await svc.dbRefsOfNode(target.nodeId),
      selectedDeps: target.dependsOn ?? [],
    };
  })
  .post(
    "/targets/:id/env",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ envText: t.Optional(t.String()), depIds: t.Array(t.Number()) }),
    },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      const target = await svc.targetById(params.id);
      if (!target || target.kind !== "app") {
        return status(404, { error: "部署目标不存在" });
      }
      await svc.updateAppEnv(params.id, body.envText ?? "", body.depIds);
      return { ok: true as const };
    },
  )
  // ── 画布拖线建/删依赖：整组覆盖服务级边 ──
  .put(
    "/targets/:id/deps",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        edges: t.Array(t.Object({ service: t.Union([t.String(), t.Null()]), db: t.Number() })),
      }),
    },
    async ({ di, params, body, set }) => {
      await di.get("deployService").setDependsOn(params.id, body.edges);
      set.status = 204;
    },
  )
  // ── 画布布局：app/db 卡位置 + 服务卡位置 ──
  .patch(
    "/targets/:id/layout",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        w: t.Optional(t.Number()),
        h: t.Optional(t.Number()),
        groupId: t.Optional(t.Union([t.Number(), t.Null()])),
        serviceLayout: t.Optional(t.Record(t.String(), t.Object({ x: t.Number(), y: t.Number() }))),
      }),
    },
    async ({ di, params, body, set }) => {
      await di.get("deployService").setLayout(params.id, body);
      set.status = 204;
    },
  )
  // ── 域名绑定 ──
  .get("/targets/:id/domains", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    const svc = di.get("deployService");
    const target = await svc.targetById(params.id);
    if (!target) {
      return status(404, { error: "部署目标不存在" });
    }
    return { target, domains: await svc.domainsOfTarget(target.id) };
  })
  .post(
    "/targets/:id/domains",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ hostname: t.String({ minLength: 1 }), targetPort: t.Number() }),
    },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      const target = await svc.targetById(params.id);
      if (!target) {
        return status(404, { error: "部署目标不存在" });
      }
      await svc.addDomain(params.id, body);
      await svc.syncEdge(params.id); // 立即对账（DNS/证书状态回写），失败由 ServiceError 映射
      return { ok: true as const };
    },
  )
  .delete("/domains/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    const svc = di.get("deployService");
    const domain = await svc.domainById(params.id);
    if (!domain) {
      return status(404, { error: "域名不存在" });
    }
    await svc.removeDomain(params.id);
    await svc.syncEdge(domain.targetId);
    return { ok: true as const };
  })
  .delete("/targets/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    // 例如「实例下还有逻辑库」时 removeTarget 抛 ServiceError（409 语义由 ServiceError 子类化再细化）
    await di.get("deployService").removeTarget(params.id);
    set.status = 204;
  });
