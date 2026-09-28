import { t, sse } from "elysia";
import { defineController } from "../../../.elysiax";
import { decryptSecret } from "../../shared/crypto";
import { events, type CanvasEvent } from "../../shared/events";
import { containerStatesOf } from "../deploy/container-poller";
import type { DeployTarget } from "../../shared/schema";
import CanvasShell from "./canvas.ui";
import type { BoardModel, CardModel } from "./canvas.model";
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
        x: target.x,
        y: target.y,
        w: target.w,
        h: target.h,
        updateAvailable: target.updateAvailable,
      });
    }
    const { id, name, user, host, port, dockerStatus, dockerVersion } = server;
    cards.push({
      node: { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h },
      server: { id, name, user, host, port, dockerStatus, dockerVersion },
      targets,
    });
  }
  // 服务级依赖边（岛端派生 React Flow 边）；存量 dependsOn 由门面惰性派生为 service=null 的边
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

export const canvasController = defineController({ prefix: "/canvas" })
  // 侧边栏「画布」：进入最近的项目；没有则提示先建项目
  .get("/ui", async ({ di }) => {
    const projects = await di.get("projectService").list();
    const latest = projects.at(-1);
    if (!latest) return <Empty text="先创建一个项目空间（左侧「项目」）" />;
    return <CanvasShell project={latest} projects={projects} />;
  })
  // 本地项目行点击：按路径幂等落库后进入画布
  .get("/ui/local", { query: t.Object({ path: t.String({ minLength: 1 }) }) }, async ({ di, query }) => {
    const svc = di.get("projectService");
    const project = await svc.ensureLocal(query.path);
    return <CanvasShell project={project} projects={await svc.list()} />;
  })
  .get("/ui/:projectId", { params: t.Object({ projectId: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("projectService");
    const project = await svc.byId(params.projectId);
    if (!project) return <Empty text="项目不存在" />;
    return <CanvasShell project={project} projects={await svc.list()} />;
  })
  // 画布数据：结构 + 布局（无实时；视图模型见 canvas.model.ts）。
  // 岛端只在挂载和 HX-Trigger: refresh（结构变更）时拉取，不轮询
  .get("/ui/:projectId/board", { params: t.Object({ projectId: t.Number() }) }, async ({ di, params }): Promise<BoardModel> => {
    return canvasData(ctxOf(di), params.projectId);
  })
  // 实时状态 SSE：部署 status/running（deploy.service 推）+ 容器 state（container-poller 推）。
  // 推送式队列 + 25s 心跳；首帧重发该 project 的容器状态快照（订阅即齐，不等下轮 diff）
  .get("/ui/:projectId/events", { params: t.Object({ projectId: t.Number() }) }, async function* ({ params }) {
    const ch = `project:${params.projectId}`;
    const queue: (CanvasEvent | "ping")[] = containerStatesOf(params.projectId);
    let wake: (() => void) | null = null;
    const push = (d: CanvasEvent | "ping") => {
      queue.push(d);
      wake?.();
    };
    const unsub = events.subscribe(ch, push);
    const hb = setInterval(() => push("ping"), 25_000);
    try {
      while (true) {
        while (queue.length) {
          const item = queue.shift()!;
          yield item === "ping"
            ? sse({ event: "ping", data: "{}" })
            : sse({ event: "message", data: JSON.stringify(item) });
        }
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
      }
    } finally {
      clearInterval(hb);
      unsub();
    }
  })
  .post(
    "/projects/:projectId/nodes",
    {
      params: t.Object({ projectId: t.Number() }),
      body: t.Object({ serverId: t.Number(), x: t.Number(), y: t.Number() }),
    },
    async ({ di, params, body, set }) => {
      await ctxOf(di).canvas.addNode(params.projectId, body.serverId, body.x, body.y);
      set.headers["HX-Trigger"] = "refresh";
      return "";
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
    set.headers["HX-Trigger"] = "refresh";
    return "";
  });
