import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import { loadConfig, saveConfig } from "../../shared/config";
import type { RepoBrief } from "../github/github.service";
import type { LocalService } from "./local.service";
import type { ProjectService } from "./projects.service";
import ProjectList, { ConfigModal, NewProjectModal, type ProjectListModel } from "./projects.ui";

interface Ctx {
  project: ProjectService;
  local: LocalService;
}

/** 列表视图模型：本地扫描结果（磁盘为准）+ 未检出的 GitHub 项目空间 */
async function listModel(ctx: Ctx): Promise<ProjectListModel> {
  const [projects, toolchain] = await Promise.all([ctx.project.list(), ctx.local.toolchain()]);
  const local = await ctx.local.scan(projects);
  const localPaths = new Set(local.map((p) => p.path));
  return {
    local,
    remote: projects.filter((p) => !p.localPath || !localPaths.has(p.localPath)),
    ...toolchain,
  };
}

export const projectsController = defineController({ prefix: "/projects" })
  .ui("/ui", ProjectList, ({ di }) =>
    listModel({ project: di.get("projectService"), local: di.get("localService") }),
  )
  // 扫描目录配置弹窗
  .get("/ui/config", async () => <ConfigModal scanDirs={(await loadConfig()).scanDirs} />)
  .post("/config", { body: t.Object({ scanDirs: t.String() }) }, async ({ di, body }) => {
    const cfg = await loadConfig();
    await saveConfig({
      ...cfg,
      scanDirs: body.scanDirs.split("\n").map((s) => s.trim()).filter(Boolean),
    });
    return (
      <>
        <ProjectList {...await listModel({ project: di.get("projectService"), local: di.get("localService") })} />
        <div id="modal-root" hx-swap-oob="innerHTML" />
      </>
    );
  })
  // 用编辑器 / lazygit 打开本地目录（编辑器用过即设为默认）
  .post(
    "/open",
    { body: t.Object({ path: t.String({ minLength: 1 }), tool: t.String({ minLength: 1 }) }) },
    async ({ di, body, set }) => {
      const local = di.get("localService") as LocalService;
      try {
        if (body.tool === "lazygit") await local.openLazygit(body.path);
        else await local.openEditor(body.path, body.tool);
      } catch (e) {
        set.status = 400;
        return (e as Error).message;
      }
      set.status = 204;
    },
  )
  // 新建项目弹窗：gh CLI 列仓库（未登录时降级为空列表，仍可手填/跳过）
  .get("/ui/new", async ({ di }) => {
    let repos: RepoBrief[] = [];
    let ghError: string | undefined;
    try {
      repos = await di.get("githubService").listRepos();
    } catch (e) {
      ghError = `仓库列表拉取失败（${(e as Error).message}），可跳过绑定`;
    }
    return <NewProjectModal repos={repos} error={ghError} />;
  })
  .post(
    "/",
    { body: t.Object({ name: t.String({ minLength: 1 }), repoUrl: t.Optional(t.String()) }) },
    async ({ di, body, set }) => {
      try {
        await di.get("projectService").create(body.name, body.repoUrl);
      } catch (e) {
        set.status = 400;
        return (e as Error).message;
      }
      // OOB 清空 #modal-root 关弹窗，主体刷新项目列表
      return (
        <>
          <ProjectList {...await listModel({ project: di.get("projectService"), local: di.get("localService") })} />
          <div id="modal-root" hx-swap-oob="innerHTML" />
        </>
      );
    },
  )
  .delete("/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    await di.get("projectService").remove(params.id);
    return <ProjectList {...await listModel({ project: di.get("projectService"), local: di.get("localService") })} />;
  });
