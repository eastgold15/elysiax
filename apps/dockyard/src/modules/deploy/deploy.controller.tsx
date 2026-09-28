import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import { AppDetectStep, DeployLog, DomainsModal, EnvDrawer, InstanceOptions, MetricsPanel, NewAppDrawer, NewDbModal, ServiceDrawer, type ServiceTab } from "./deploy.ui";
import type { DeployService } from "./deploy.service";

/** 服务抽屉各 Tab 按需取数（deployments/env/domains/backups/metrics 只在对应 Tab 拉） */
async function renderServiceDrawer(
  svc: DeployService,
  targetId: number,
  opts: { svc?: string; tab?: string; notice?: string; error?: string },
) {
  const target = await svc.targetById(targetId);
  if (!target) throw new Error("部署目标不存在");
  const tab = (["deployments", "source", "hardware", "network", "env", "monitor", "console", "backups"].includes(opts.tab ?? "")
    ? opts.tab
    : "deployments") as ServiceTab;
  return (
    <ServiceDrawer
      target={target}
      svc={opts.svc || undefined}
      tab={tab}
      notice={opts.notice}
      error={opts.error}
      deployments={tab === "deployments" ? await svc.deploymentsOfTarget(targetId) : undefined}
      envText={tab === "env" && opts.svc ? await svc.serviceEnvText(targetId, opts.svc) : undefined}
      dbRefs={tab === "env" && opts.svc ? await svc.dbRefsOfNode(target.nodeId) : undefined}
      sharedEnv={tab === "env" ? await svc.sharedEnvOfTarget(targetId) : undefined}
      selectedDeps={tab === "env" && opts.svc
        ? svc.edgesOfTarget(target).filter((e) => e.service === opts.svc).map((e) => e.db)
        : undefined}
      domains={tab === "network" ? await svc.domainsOfTarget(targetId) : undefined}
      resources={tab === "hardware" && opts.svc ? await svc.serviceResources(targetId, opts.svc) : undefined}
      backups={tab === "backups" ? await svc.backupsOf(targetId) : undefined}
      metrics={tab === "monitor" ? await svc.serviceStats(targetId, opts.svc || undefined) : undefined}
    />
  );
}
import { LOGICAL_DB_SUPPORT, type DbType } from "./db-templates";
import type { RepoBrief } from "../github/github.service";
import type { SharedEnv } from "../resources/resources.service";
import { detectToEnvText, detectToOverrideCompose, guessDbType, textToEnvMap, type DetectResult, type DetectedService } from "./detect";

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

/** 向导 step2 的动态行（svcName 隐藏字段枚举 + svcExpose_/svcPort_/…_<服务名>）还原成服务列表。
 *  未勾「对外」时端口输入被禁用、不随表单提交 → port=undefined = 内部服务 */
function servicesFromBody(body: Record<string, unknown>): DetectedService[] {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const rawNames = body.svcName;
  const names = (Array.isArray(rawNames) ? rawNames : rawNames !== undefined ? [rawNames] : [])
    .map(String).filter(Boolean);
  return names.map((name) => {
    const port = num(body[`svcPort_${name}`]);
    return {
      name,
      exposed: body[`svcExpose_${name}`] !== undefined && port !== undefined,
      port,
      domain: str(body[`svcDomain_${name}`]),
      cpuCores: num(body[`svcCpu_${name}`]),
      memoryMb: num(body[`svcMem_${name}`]),
      env: textToEnvMap(str(body[`svcEnv_${name}`]) ?? ""),
    };
  });
}

/** 依赖勾选（depIds 复选框，单个时是 string、多个是数组）→ target id 列表 */
function depIdsFromBody(body: Record<string, unknown>): number[] {
  const raw = body.depIds;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** step2 表单 → 创建参数（域名行 + 资源 override） */
function domainsFromServices(services: DetectedService[]) {
  return services
    .filter((s) => s.domain && s.port)
    .map((s) => ({ hostname: s.domain!, targetPort: s.port!, serviceName: s.name }));
}

/** Console 会话：ws 连接 → docker exec TTY 流（close 时必须 end，否则远端 sh 残留） */
const consoleSessions = new Map<unknown, { exec: { resize(dims: { h: number; w: number }): Promise<unknown> }; stream: { write(d: string): unknown; end(): unknown; on(ev: string, fn: (c: Buffer) => void): unknown } }>();

export const deployController = defineController({ prefix: "/deploy" })
  // 向导 step1：gh CLI 列出账号仓库做选择器（gh 未登录时降级为空列表手填）
  .get("/ui/new-app/:nodeId", { params: t.Object({ nodeId: t.Number() }) }, async ({ di, params }) => {
    let repos: RepoBrief[] = [];
    let ghError: string | undefined;
    try {
      repos = await di.get("githubService").listRepos();
    } catch (e) {
      ghError = `仓库列表拉取失败（${(e as Error).message}），可手动输入 owner/repo`;
    }
    // 项目 = 仓库：预填项目绑定的 repoUrl（仍可改——同一仓库可以多方式部署）
    const node = await di.get("canvasService").byId(params.nodeId);
    const project = node ? await di.get("projectService").byId(node.projectId) : undefined;
    // 本地文件夹导入：不需要 Git，跳过仓库选择，直接识别本地目录
    const isLocal = project?.sourceType === "local" || (!!project?.localPath && !project?.repoUrl);
    if (isLocal && project?.localPath) {
      const svc = di.get("deployService");
      const detect = await svc.detectLocal({ localPath: project.localPath, rootDir: project.rootDir ?? undefined });
      const dbRefs = await svc.dbRefsOfNode(params.nodeId);
      const sharedMatches = await sharedMatchesOf(di, params.nodeId, detect.services);
      const carry = {
        nodeId: params.nodeId,
        name: project.slug,
        repoUrl: project.repoUrl ?? "",
        branch: project.branch ?? "main",
        remoteDir: `~/dockyard/${project.slug}`,
      };
      return <AppDetectStep carry={carry} detect={detect} envText={detectToEnvText(detect)} dbRefs={dbRefs} sharedMatches={sharedMatches} />;
    }
    return <NewAppDrawer nodeId={params.nodeId} repos={repos} error={ghError} prefillRepo={project?.repoUrl ?? undefined} />;
  })
  // 向导 step1 → step2：克隆仓库，读 openship.json / compose 自动识别
  .post(
    "/ui/detect",
    {
      body: t.Object({
        nodeId: t.Numeric(),
        name: t.String({ minLength: 1 }),
        repoUrl: t.String({ minLength: 1 }),
        branch: t.String({ default: "main" }),
        remoteDir: t.String({ minLength: 1 }),
      }),
    },
    async ({ di, body }) => {
      try {
        const detect = await di.get("deployService").detectRepo(body);
        const dbRefs = await di.get("deployService").dbRefsOfNode(body.nodeId);
        const sharedMatches = await sharedMatchesOf(di, body.nodeId, detect.services);
        return <AppDetectStep carry={body} detect={detect} envText={detectToEnvText(detect)} dbRefs={dbRefs} sharedMatches={sharedMatches} />;
      } catch (e) {
        let repos: RepoBrief[] = [];
        try {
          repos = await di.get("githubService").listRepos();
        } catch {}
        return <NewAppDrawer nodeId={body.nodeId} repos={repos} error={`识别失败：${(e as Error).message}`} />;
      }
    },
  )
  .get("/ui/new-db/:nodeId", { params: t.Object({ nodeId: t.Number() }) }, async ({ di, params }) => (
    <NewDbModal
      nodeId={params.nodeId}
      instances={await di.get("deployService").instancesOfNode(params.nodeId, "postgres")}
    />
  ))
  // dbType 切换时拉取该服务器上可托管的同类型实例（redis 不支持逻辑库）
  .get("/ui/instances", async ({ di, query }) => {
    const dbType = (query.dbType ?? "postgres") as DbType;
    const instances = LOGICAL_DB_SUPPORT[dbType]
      ? await di.get("deployService").instancesOfNode(Number(query.nodeId), dbType)
      : [];
    return <InstanceOptions nodeId={Number(query.nodeId)} instances={instances} />;
  })
  .post(
    "/targets/app",
    {
      body: t.Object({
        nodeId: t.Numeric(),
        name: t.String({ minLength: 1 }),
        // 本地文件夹导入无仓库，repoUrl 可空
        repoUrl: t.Optional(t.String()),
        branch: t.String({ default: "main" }),
        composePath: t.String({ default: "docker-compose.yml" }),
        remoteDir: t.String({ minLength: 1 }),
        envText: t.Optional(t.String()),
        // 向导 step2 的动态行 svcPort_/svcDomain_/svcCpu_/svcMem_/svcEnv_<服务名>：
        // additionalProperties 声明为 Unknown 才会被保留（Elysia 默认 clean 掉 schema 外的键）
      }, { additionalProperties: t.Unknown() }),
    },
    async ({ di, body, set }) => {
      const svc = di.get("deployService");
      const rawBody = body as unknown as Record<string, unknown>;
      const services = servicesFromBody(rawBody);
      // 共享资源复用：勾了 reuse_<服务> 的中间件不部署，只注入共享变量
      const reused = new Set(services.filter((s) => rawBody[`reuse_${s.name}`] !== undefined).map((s) => s.name));
      if (reused.size > 0 && reused.size === services.length) {
        const dbRefs = await svc.dbRefsOfNode(body.nodeId);
        const detect: DetectResult = { source: "openship.json", composePath: body.composePath, services, rootEnv: {}, errors: [], warnings: [] };
        return <AppDetectStep carry={body} detect={detect} envText={body.envText ?? ""} dbRefs={dbRefs} error="所有服务都选择了复用共享资源——至少保留一个业务服务需要部署" />;
      }
      const upServices = reused.size > 0
        ? services.map((s) => s.name).filter((n) => !reused.has(n))
        : undefined;
      let target;
      try {
        target = await svc.createAppTarget({
          nodeId: body.nodeId,
          name: body.name,
          repoUrl: body.repoUrl?.trim() || undefined,
          branch: body.branch,
          composePath: body.composePath,
          remoteDir: body.remoteDir,
          envText: body.envText,
          overrideCompose: detectToOverrideCompose({ services }),
          dependsOn: depIdsFromBody(rawBody),
          domains: domainsFromServices(services),
          services,
          upServices,
        });
      } catch (e) {
        // 创建失败回到 step2，保留已填内容
        const detect: DetectResult = {
          source: "openship.json",
          composePath: body.composePath,
          services,
          rootEnv: {},
          errors: [],
          warnings: [],
        };
        const dbRefs = await svc.dbRefsOfNode(body.nodeId);
        return <AppDetectStep carry={body} detect={detect} envText={body.envText ?? ""} dbRefs={dbRefs} error={(e as Error).message} />;
      }
      // Railway 式：创建即部署，直接换出日志面板盯进度（无 dep 行也轮询）
      void svc.deploy(target.id);
      set.headers["HX-Trigger"] = "refresh";
      return <DeployLog target={target} dep={undefined} />;
    },
  )
  .post(
    "/targets/db",
    {
      body: t.Object({
        nodeId: t.Numeric(),
        name: t.String({ minLength: 1 }),
        dbType: t.Union([t.Literal("postgres"), t.Literal("mysql"), t.Literal("redis"), t.Literal("mongo")]),
        instanceId: t.Optional(t.String()),
        remoteDir: t.Optional(t.String()),
      }),
    },
    async ({ di, body, set }) => {
      const svc = di.get("deployService");
      const instanceId = body.instanceId ? Number(body.instanceId) : 0;
      try {
        const target = instanceId
          ? await svc.createLogicalDbTarget({ nodeId: body.nodeId, name: body.name, instanceId })
          : await svc.createDbTarget({
            nodeId: body.nodeId,
            name: body.name,
            dbType: body.dbType,
            remoteDir: body.remoteDir ?? "",
          });
        void svc.deploy(target.id); // 创建即部署
      } catch (e) {
        const instances = LOGICAL_DB_SUPPORT[body.dbType as DbType]
          ? await svc.instancesOfNode(body.nodeId, body.dbType as DbType)
          : [];
        return <NewDbModal nodeId={body.nodeId} instances={instances} error={(e as Error).message} />;
      }
      set.headers["HX-Trigger"] = "refresh";
      return "";
    },
  )
  .post("/targets/:id/deploy", {
    params: t.Object({
      id: t.Number()
    })
  }, ({ di, params, set }) => {
    void di.get("deployService").deploy(params.id); // 后台跑，状态迁移走 SSE 推到画布
    set.status = 204;
  })
  .get(
    "/ui/targets/:id/log",
    { params: t.Object({ id: t.Number() }), query: t.Object({ dep: t.Optional(t.Numeric()) }) },
    async ({ di, params, query }) => {
      const svc = di.get("deployService");
      const target = await svc.targetById(params.id);
      if (!target) throw new Error("部署目标不存在");
      const dep = query.dep ? await svc.deploymentById(query.dep) : await svc.latestDeployment(target.id);
      return <DeployLog target={target} dep={dep} />;
    },
  )
  .get(
    "/ui/targets/:id/log-body",
    { params: t.Object({ id: t.Number() }), query: t.Object({ dep: t.Optional(t.Numeric()) }) },
    async ({ di, params, query }) => {
      const svc = di.get("deployService");
      const dep = query.dep ? await svc.deploymentById(query.dep) : await svc.latestDeployment(params.id);
      return dep?.logText ?? "";
    },
  )
  // ── 服务抽屉（Railway Service View）：点画布服务卡/db 卡弹出 ──
  .get(
    "/ui/targets/:id/service",
    {
      params: t.Object({ id: t.Number() }),
      query: t.Object({ svc: t.Optional(t.String()), tab: t.Optional(t.String()) }),
    },
    async ({ di, params, query }) => renderServiceDrawer(di.get("deployService"), params.id, query),
  )
  .get(
    "/ui/targets/:id/service/metrics",
    { params: t.Object({ id: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, query }) => (
      <MetricsPanel targetId={params.id} svc={query.svc} stats={await di.get("deployService").serviceStats(params.id, query.svc)} />
    ),
  )
  .post(
    "/targets/:id/service/restart",
    { params: t.Object({ id: t.Number() }), body: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      let error: string | undefined;
      try {
        await svc.restartService(params.id, body.svc || undefined);
      } catch (e) {
        error = (e as Error).message;
      }
      // 结构不变（容器状态走 SSE），不 refresh 画布
      return renderServiceDrawer(svc, params.id, { svc: body.svc, tab: "deployments", notice: error ? undefined : "已发送重启", error });
    },
  )
  .get(
    "/ui/targets/:id/service/logs",
    { params: t.Object({ id: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, query }) => di.get("deployService").serviceLogs(params.id, query.svc),
  )
  .post(
    "/targets/:id/service/env",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      const b = body as Record<string, unknown>;
      const svcName = String(b.svc ?? "");
      await svc.setServiceEnv(params.id, svcName, String(b.envText ?? ""));
      // 依赖勾选同步服务级连线：整组替换该服务的边，app 级/其他服务的边不动
      const target = await svc.targetById(params.id);
      if (target) {
        const kept = svc.edgesOfTarget(target).filter((e) => e.service !== svcName);
        const added = depIdsFromBody(b).map((db) => ({ service: svcName, db }));
        await svc.setDependsOn(params.id, [...kept, ...added]);
      }
      set.headers["HX-Trigger"] = "refresh";
      return renderServiceDrawer(svc, params.id, { svc: svcName, tab: "env", notice: "已保存，重新部署后生效" });
    },
  )
  .post(
    "/targets/:id/service/resources",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.String({ minLength: 1 }), cpuCores: t.Optional(t.String()), memoryMb: t.Optional(t.String()) }),
    },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      const num = (v?: string) => {
        const n = Number(v);
        return v && Number.isFinite(n) && n > 0 ? n : undefined;
      };
      await svc.setServiceResources(params.id, body.svc, num(body.cpuCores), num(body.memoryMb));
      // 资源限制只写 override compose，画布结构不变，不 refresh
      return renderServiceDrawer(svc, params.id, { svc: body.svc, tab: "hardware", notice: "已保存，重新部署后生效" });
    },
  )
  .post(
    "/targets/:id/service/domains",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.Optional(t.String()), hostname: t.String({ minLength: 1 }), targetPort: t.Numeric() }),
    },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      let error: string | undefined;
      try {
        await svc.addDomain(params.id, { hostname: body.hostname, targetPort: body.targetPort, serviceName: body.svc || undefined });
        await svc.syncEdge(params.id);
      } catch (e) {
        error = (e as Error).message;
      }
      set.headers["HX-Trigger"] = "refresh";
      return renderServiceDrawer(svc, params.id, { svc: body.svc, tab: "network", notice: error ? undefined : "已绑定", error });
    },
  )
  .delete(
    "/targets/:id/service/domains/:domainId",
    { params: t.Object({ id: t.Number(), domainId: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, query, set }) => {
      const svc = di.get("deployService");
      await svc.removeDomain(params.domainId);
      set.headers["HX-Trigger"] = "refresh";
      return renderServiceDrawer(svc, params.id, { svc: query.svc, tab: "network", notice: "已解绑" });
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
      const svc = di.get("deployService");
      let error: string | undefined;
      try {
        await svc.updateSource(params.id, body);
      } catch (e) {
        error = (e as Error).message;
      }
      return renderServiceDrawer(svc, params.id, { tab: "source", notice: error ? undefined : "已保存，下次部署生效", error });
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
    const svc = di.get("deployService");
    let file: string | undefined;
    let error: string | undefined;
    try {
      file = await svc.backupNow(params.id);
    } catch (e) {
      error = (e as Error).message;
    }
    return renderServiceDrawer(svc, params.id, { tab: "backups", notice: file ? `已备份：${file}` : undefined, error });
  })
  .get(
    "/backups/:id/:file",
    { params: t.Object({ id: t.Number(), file: t.String() }) },
    async ({ di, params, set }) => {
      const path = di.get("deployService").backupFilePath(params.id, params.file);
      if (!path) {
        set.status = 404;
        return "备份不存在";
      }
      set.headers["content-disposition"] = `attachment; filename="${params.file}"`;
      set.headers["content-type"] = "application/gzip";
      return Bun.file(path);
    },
  )
  // ── 变量抽屉：已有 app 改 .env + 数据库依赖 ──
  .get("/ui/targets/:id/env", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("deployService");
    const target = await svc.targetById(params.id);
    if (!target || target.kind !== "app") throw new Error("部署目标不存在");
    return <EnvDrawer target={target} envText={svc.envTextOf(target)} dbRefs={await svc.dbRefsOfNode(target.nodeId)} />;
  })
  .post(
    "/targets/:id/env",
    {
      params: t.Object({ id: t.Number() }),
      // depIds 复选框是动态键，additionalProperties 声明了才会保留
      body: t.Object({ envText: t.Optional(t.String()) }, { additionalProperties: t.Unknown() }),
    },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      const target = await svc.targetById(params.id);
      if (!target || target.kind !== "app") throw new Error("部署目标不存在");
      try {
        await svc.updateAppEnv(
          params.id,
          body.envText ?? "",
          depIdsFromBody(body as unknown as Record<string, unknown>),
        );
      } catch (e) {
        return <EnvDrawer
          target={target}
          envText={body.envText ?? ""}
          dbRefs={await svc.dbRefsOfNode(target.nodeId)}
          error={(e as Error).message}
        />;
      }
      set.headers["HX-Trigger"] = "refresh";
      return "";
    },
  )
  // ── 画布拖线建/删依赖：整组覆盖服务级边（React 岛 fetch，非 htmx）──
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
  .get("/ui/targets/:id/domains", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("deployService");
    const target = await svc.targetById(params.id);
    if (!target) throw new Error("部署目标不存在");
    return <DomainsModal target={target} domains={await svc.domainsOfTarget(target.id)} />;
  })
  .post(
    "/targets/:id/domains",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ hostname: t.String({ minLength: 1 }), targetPort: t.Numeric() }),
    },
    async ({ di, params, body, set }) => {
      const svc = di.get("deployService");
      const target = await svc.targetById(params.id);
      if (!target) throw new Error("部署目标不存在");
      let error: string | undefined;
      try {
        await svc.addDomain(params.id, body);
        await svc.syncEdge(params.id); // 立即对账（DNS/证书状态回写），失败回显不吞
      } catch (e) {
        error = (e as Error).message;
      }
      set.headers["HX-Trigger"] = "refresh";
      return <DomainsModal target={target} domains={await svc.domainsOfTarget(params.id)} error={error} />;
    },
  )
  .delete("/domains/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    const svc = di.get("deployService");
    const domain = await svc.domainById(params.id);
    if (!domain) {
      set.status = 404;
      return "域名不存在";
    }
    await svc.removeDomain(params.id);
    let error: string | undefined;
    try {
      await svc.syncEdge(domain.targetId);
    } catch (e) {
      error = (e as Error).message;
    }
    const target = await svc.targetById(domain.targetId);
    set.headers["HX-Trigger"] = "refresh";
    return <DomainsModal target={target!} domains={await svc.domainsOfTarget(domain.targetId)} error={error} />;
  })
  .delete("/targets/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    try {
      await di.get("deployService").removeTarget(params.id);
    } catch (e) {
      set.status = 409;
      return (e as Error).message;
    }
    set.headers["HX-Trigger"] = "refresh";
    return "";
  });
