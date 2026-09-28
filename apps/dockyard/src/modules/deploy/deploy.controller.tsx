import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import { AppDetectStep, DeployLog, DomainsModal, EnvDrawer, InstanceOptions, NewAppDrawer, NewDbModal } from "./deploy.ui";
import { LOGICAL_DB_SUPPORT, type DbType } from "./db-templates";
import type { RepoBrief } from "../github/github.service";
import { detectToEnvText, detectToOverrideCompose, textToEnvMap, type DetectResult, type DetectedService } from "./detect";

/** 向导 step2 的动态行（svcPort_xxx / svcDomain_xxx / svcCpu_xxx / svcMem_xxx）还原成服务列表 */
function servicesFromBody(body: Record<string, unknown>): DetectedService[] {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const services: DetectedService[] = [];
  for (const key of Object.keys(body)) {
    const m = key.match(/^svcPort_(.+)$/);
    if (!m) continue;
    const name = m[1]!;
    const port = num(body[key]);
    services.push({
      name,
      exposed: port !== undefined,
      port,
      domain: str(body[`svcDomain_${name}`]),
      cpuCores: num(body[`svcCpu_${name}`]),
      memoryMb: num(body[`svcMem_${name}`]),
      env: textToEnvMap(str(body[`svcEnv_${name}`]) ?? ""),
    });
  }
  return services;
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
    return <NewAppDrawer nodeId={params.nodeId} repos={repos} error={ghError} />;
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
        return <AppDetectStep carry={body} detect={detect} envText={detectToEnvText(detect)} dbRefs={dbRefs} />;
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
        repoUrl: t.String({ minLength: 1 }),
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
      const services = servicesFromBody(body as unknown as Record<string, unknown>);
      let target;
      try {
        target = await svc.createAppTarget({
          nodeId: body.nodeId,
          name: body.name,
          repoUrl: body.repoUrl,
          branch: body.branch,
          composePath: body.composePath,
          remoteDir: body.remoteDir,
          envText: body.envText,
          overrideCompose: detectToOverrideCompose({ services }),
          dependsOn: depIdsFromBody(body as unknown as Record<string, unknown>),
          domains: domainsFromServices(services),
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
    void di.get("deployService").deploy(params.id); // 后台跑，画布轮询看状态
    set.status = 204;
  })
  .get("/ui/targets/:id/log", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("deployService");
    const target = await svc.targetById(params.id);
    if (!target) throw new Error("部署目标不存在");
    return <DeployLog target={target} dep={await svc.latestDeployment(target.id)} />;
  })
  .get("/ui/targets/:id/log-body", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const dep = await di.get("deployService").latestDeployment(params.id);
    return dep?.logText ?? "";
  })
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
