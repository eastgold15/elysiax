import { defineModule } from "@elysiax/core";
import { EdgeRepository } from "./edge.repository";
import { EdgeService } from "./edge.service";

export default defineModule({
  provides: {
    edgeRepository: { class: EdgeRepository, deps: ["db"] },
    edgeService: {
      class: EdgeService,
      deps: ["edgeRepository", "serverService"],
    },
  },
});
