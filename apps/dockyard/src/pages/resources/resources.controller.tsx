import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import type { Server } from "../../shared/schema";
import type { ServerService } from "../servers/servers.service";
import type { ResourceService } from "./resources.service";
import { ResourceListBody, SharedResourcesModal } from "./resources.ui";

const DB_TYPES = [t.Literal("postgres"), t.Literal("mysql"), t.Literal("redis"), t.Literal("mongo")] as const;

async function model(svc: ResourceService, servers: ServerService, serverId: number) {
  const server = (await servers.byId(serverId)) as Server;
  const resources = await svc.ofServer(serverId);
  const withUrl = await Promise.all(resources.map(async (r) => ({ resource: r, url: await svc.urlOf(r.id) })));
  return { server, resources: withUrl };
}

export const resourcesController = defineController({ prefix: "/resources" })
  // 共享资源弹窗（挂 #modal-root）
  .get("/ui/:serverId", { params: t.Object({ serverId: t.Number() }) }, async ({ di, params }) => {
    const { server, resources } = await model(di.get("resourceService"), di.get("serverService"), params.serverId);
    return <SharedResourcesModal server={server} resources={resources} />;
  })
  // 创建共享资源（视角 B：单独预部署中间件；创建后需点「部署」）
  .post(
    "/",
    {
      body: t.Object({
        serverId: t.Numeric(),
        name: t.String({ minLength: 1 }),
        dbType: t.Union([...DB_TYPES]),
        envKey: t.Optional(t.String()),
      }),
    },
    async ({ di, body }) => {
      const svc = di.get("resourceService");
      let message: string | undefined;
      try {
        await svc.create({ serverId: body.serverId, name: body.name.trim(), dbType: body.dbType, envKey: body.envKey });
      } catch (e) {
        message = (e as Error).message;
      }
      const { server, resources } = await model(svc, di.get("serverService"), body.serverId);
      return <ResourceListBody server={server} resources={resources} message={message} />;
    },
  )
  // 部署中间件到服务器，成功后生成连接串写入共享清单
  .post("/:id/deploy", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("resourceService");
    const target = await svc.byId(params.id);
    if (!target) return "";
    let message: string | undefined;
    try {
      await svc.deploy(params.id);
    } catch (e) {
      message = (e as Error).message;
    }
    const { server, resources } = await model(svc, di.get("serverService"), target.serverId);
    return <ResourceListBody server={server} resources={resources} message={message} />;
  })
  // 删除记录（远端容器/数据卷保留）
  .delete("/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("resourceService");
    const target = await svc.byId(params.id);
    if (!target) return "";
    await svc.remove(params.id);
    const { server, resources } = await model(svc, di.get("serverService"), target.serverId);
    return <ResourceListBody server={server} resources={resources} />;
  });
