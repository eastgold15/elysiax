import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import { NewAppModal, NewDbModal, DeployLog, InstanceOptions } from "./deploy.ui";
import { LOGICAL_DB_SUPPORT, type DbType } from "./db-templates";

export const deployController = defineController({ prefix: "/deploy" })
  .get("/ui/new-app/:nodeId", ({ params }) => <NewAppModal nodeId={Number(params.nodeId)} />)
  .get("/ui/new-db/:nodeId", async ({ di, params }) => (
    <NewDbModal
      nodeId={Number(params.nodeId)}
      instances={await di.get("deployService").instancesOfNode(Number(params.nodeId), "postgres")}
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
        serviceName: t.Optional(t.String()),
        remoteDir: t.String({ minLength: 1 }),
      }),
    },
    async ({ di, body, set }) => {
      try {
        await di.get("deployService").createAppTarget({
          ...body,
          serviceName: body.serviceName || undefined,
        });
      } catch (e) {
        return <NewAppModal nodeId={body.nodeId} error={(e as Error).message} />;
      }
      set.headers["HX-Trigger"] = "refresh"; // 关 modal（空响应）+ 画布孤岛监听此事件刷新
      return "";
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
    query: t.Object({
      id: t.Number()
    })
  }, ({ di, query: { id }, set }) => {
    void di.get("deployService").deploy(id); // 后台跑，画布轮询看状态
    set.status = 204;
  })
  .get("/ui/targets/:id/log", async ({ di, params }) => {
    const svc = di.get("deployService");
    const target = await svc.targetById(Number(params.id));
    if (!target) throw new Error("部署目标不存在");
    return <DeployLog target={target} dep={await svc.latestDeployment(target.id)} />;
  })
  .get("/ui/targets/:id/log-body", async ({ di, params }) => {
    const dep = await di.get("deployService").latestDeployment(Number(params.id));
    return dep?.logText ?? "";
  })
  .delete("/targets/:id", async ({ di, params, set }) => {
    try {
      await di.get("deployService").removeTarget(Number(params.id));
    } catch (e) {
      set.status = 409;
      return (e as Error).message;
    }
    set.status = 204;
  });
