import { defineModule } from "@elysiax/core";
import { DeployRepository } from "./deploy.repository";
import { DeployService } from "./deploy.service";

export default defineModule({
  provides: {
    deployRepository: { class: DeployRepository, deps: ["db"] },
    deployService: {
      class: DeployService,
      deps: ["deployRepository", "serverService", "githubService", "canvasRepository", "appPaths", "edgeService"],
    },
  },
});
