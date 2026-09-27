import type { ProjectRepository } from "./projects.repository";

export class ProjectService {
  constructor(private readonly repo: ProjectRepository) {}

  list() {
    return this.repo.list();
  }

  byId(id: number) {
    return this.repo.byId(id);
  }

  create(name: string) {
    return this.repo.create(name);
  }

  remove(id: number) {
    return this.repo.remove(id);
  }
}
