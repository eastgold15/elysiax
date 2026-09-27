import { defineModule } from "@elysiax/core";
import { GithubService } from "./github.service";

export default defineModule({
  provides: {
    githubService: { class: GithubService, deps: [] },
  },
});
