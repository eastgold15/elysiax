import { defineModule } from "@elysiax/core";
import { SshPool } from "./ssh-pool";
import { DockerRelay } from "./docker-relay";
import { ServerRepository } from "./servers.repository";
import { ServerService } from "./servers.service";

export default defineModule({
  provides: {
    sshPool: { class: SshPool, deps: [] },
    dockerRelay: { class: DockerRelay, deps: [] },
    serverRepository: { class: ServerRepository, deps: ["db"] },
    serverService: { class: ServerService, deps: ["serverRepository", "sshPool", "dockerRelay"] },
  },
});
