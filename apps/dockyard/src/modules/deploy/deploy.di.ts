import { defineModule, provide } from "@elysiax/core";
import { CanvasRepository } from "../canvas/canvas.repository";
import { GithubService } from "../github/github.service";
import { ServerService } from "../servers/servers.service";
import { EdgeService } from "../edge/edge.service";
import { DeployRepository } from "./deploy.repository";
import { DeployService } from "./deploy.service";

export default defineModule({
  route: "/deploy",
  provides: {
    deployRepository: provide(DeployRepository, ["db"]),
    deployService: provide(DeployService, [
      DeployRepository,
      ServerService,
      GithubService,
      CanvasRepository,
      "appPaths",
      EdgeService,
    ]),
  },
});
