import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import { decryptSecret } from "../../shared/crypto";
import CanvasShell from "./canvas.ui";
import { Empty } from "../ui-kit/ui-kit.ui";
import type { ProjectService } from "../projects/projects.service";
import type { ServerService } from "../servers/servers.service";
import type { DeployService } from "../deploy/deploy.service";
import type { CanvasService } from "./canvas.service";

interface Ctx {
  project: ProjectService;
  server: ServerService;
  canvas: CanvasService;
  deploy: DeployService;
}

/** 跨上下文组合上移 controller：canvas 只存节点，服务器/部署信息在此拼装 */
async function canvasData(ctx: Ctx, projectId: number) {
  const [nodes, servers] = await Promise.all([ctx.canvas.nodesOf(projectId), ctx.server.list()]);
  const byId = new Map(servers.map((s) => [s.id, s]));
  const cards = [];
  for (const node of nodes) {
    const server = byId.get(node.serverId);
    if (!server) continue;
    const targets = [];
    for (const target of await ctx.deploy.targetsOfNode(node.id)) {
      const dep = await ctx.deploy.latestDeployment(target.id);
      // 逻辑库（instanceOf 非空）：把连接串带给前端复制按钮；本地控制面，落库已 enc1: 加密
      let url: string | undefined;
      if (target.kind === "db" && target.instanceOf && target.envJson) {
        try {
          url = (JSON.parse(decryptSecret(target.envJson)) as { url?: string }).url;
        } catch {}
      }
      targets.push({
        id: target.id,
        kind: target.kind,
        name: target.name,
        dbType: target.dbType,
        logical: Boolean(target.instanceOf),
        url,
        updateAvailable: target.updateAvailable,
        status: dep?.status ?? null,
        running: ctx.deploy.isRunning(target.id),
      });
    }
    const { id, name, user, host, port, dockerStatus, dockerVersion } = server;
    cards.push({
      node: { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h },
      server: { id, name, user, host, port, dockerStatus, dockerVersion },
      targets,
    });
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

export const canvasController = defineController({ prefix: "/canvas" })
  // 侧边栏「画布」：进入最近的项目；没有则提示先建项目
  .get("/ui", async ({ di }) => {
    const projects = await di.get("projectService").list();
    const latest = projects.at(-1);
    if (!latest) return <Empty text="先创建一个项目空间（左侧「项目」）" />;
    return <CanvasShell project={latest} projects={projects} />;
  })
  .get("/ui/:projectId", { params: t.Object({ projectId: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("projectService");
    const project = await svc.byId(params.projectId);
    if (!project) return <Empty text="项目不存在" />;
    return <CanvasShell project={project} projects={await svc.list()} />;
  })
  // 画布数据（canvas.ts 孤岛轮询）
  .get("/data/:projectId", { params: t.Object({ projectId: t.Number() }) }, async ({ di, params }) =>
    canvasData(ctxOf(di), params.projectId),
  )
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
  });
