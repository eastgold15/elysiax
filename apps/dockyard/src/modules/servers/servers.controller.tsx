import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import ServerList, { ServerRow, TrustPrompt } from "./servers.ui";

const serverForm = t.Object({
  name: t.String({ minLength: 1 }),
  host: t.String({ minLength: 1 }),
  port: t.Numeric({ default: 22 }),
  user: t.String({ minLength: 1 }),
  authType: t.Union([t.Literal("key"), t.Literal("password"), t.Literal("agent")]),
  keyPath: t.Optional(t.String()),
  password: t.Optional(t.String()),
});

export const serversController = defineController({ prefix: "/servers" })
  .get("/ui", async ({ di }) => <ServerList servers={await di.get("serverService").list()} />)
  .get("/:id/card", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const server = await di.get("serverService").byId(params.id);
    return <ServerRow server={server!} />;
  })
  .post("/", { body: serverForm }, async ({ di, body }) => {
    await di.get("serverService").create({
      ...body,
      keyPath: body.keyPath || undefined,
      password: body.password || undefined,
    });
    return <ServerList servers={await di.get("serverService").list()} />;
  })
  .delete("/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    await di.get("serverService").remove(params.id);
    return <ServerList servers={await di.get("serverService").list()} />;
  })
  .post("/:id/check", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("serverService");
    const id = params.id;
    const result = await svc.check(id);
    const server = (await svc.byId(id))!;
    if (result.ok) return <ServerRow server={server} message={`连接成功，docker ${result.dockerVersion}${result.warning ? `\n⚠️ ${result.warning}` : ""}`} />;
    if (result.reason === "need-trust")
      return <TrustPrompt server={server} fingerprint={result.fingerprint} algorithm={result.algorithm} />;
    return <ServerRow server={server} message={result.message} />;
  })
  .post(
    "/:id/trust",
    { params: t.Object({ id: t.Number() }), body: t.Object({ fingerprint: t.String() }) },
    async ({ di, params, body }) => {
    const svc = di.get("serverService");
    const id = params.id;
    const result = await svc.trust(id, body.fingerprint);
    const server = (await svc.byId(id))!;
    if (result.ok) return <ServerRow server={server} message={`已信任主机，docker ${result.dockerVersion}${result.warning ? `\n⚠️ ${result.warning}` : ""}`} />;
    return <ServerRow server={server} message={"message" in result ? result.message : "信任后检测失败"} />;
  })
  .post("/:id/install-docker", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("serverService");
    const id = params.id;
    const { code, output } = await svc.installDocker(id);
    const server = (await svc.byId(id))!;
    return (
      <ServerRow
        server={server}
        message={code === 0 ? `docker 安装完成\n${output.slice(-500)}` : `安装失败（exit ${code}）\n${output.slice(-1000)}`}
      />
    );
  });
