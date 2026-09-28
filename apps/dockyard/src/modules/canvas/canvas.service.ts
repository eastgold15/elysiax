import type { CanvasRepository } from "./canvas.repository";

export class CanvasService {
  constructor(private readonly repo: CanvasRepository) {}

  nodesOf(projectId: number) {
    return this.repo.nodesOf(projectId);
  }

  byId(id: number) {
    return this.repo.byId(id);
  }

  addNode(projectId: number, serverId: number, x = 40, y = 40) {
    return this.repo.add(projectId, serverId, x, y);
  }

  moveNode(id: number, patch: { x?: number; y?: number; w?: number; h?: number }) {
    return this.repo.move(id, patch);
  }

  removeNode(id: number) {
    return this.repo.remove(id);
  }
}
