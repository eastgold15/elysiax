import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import ProjectList from "./projects.ui";

export const projectsController = defineController({ prefix: "/projects" })
  .get("/ui", async ({ di }) => <ProjectList projects={await di.get("projectService").list()} />)
  .post(
    "/",
    { body: t.Object({ name: t.String({ minLength: 1 }) }) },
    async ({ di, body }) => {
      await di.get("projectService").create(body.name);
      return <ProjectList projects={await di.get("projectService").list()} />;
    },
  )
  .delete("/:id", async ({ di, params }) => {
    await di.get("projectService").remove(Number(params.id));
    return <ProjectList projects={await di.get("projectService").list()} />;
  });
