import { defineModule } from "@elysiax/core";
import { LocalService } from "./local.service";
import { ProjectRepository } from "./projects.repository";
import { ProjectService } from "./projects.service";

export default defineModule({
  provides: {
    projectRepository: { class: ProjectRepository, deps: ["db"] },
    projectService: { class: ProjectService, deps: ["projectRepository"] },
    localService: { class: LocalService, deps: [] },
  },
});
