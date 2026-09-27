import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { projects, type Project } from "../../shared/schema";

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<Project[]> {
    return this.db.select().from(projects).orderBy(projects.id);
  }

  byId(id: number): Promise<Project | undefined> {
    return this.db.select().from(projects).where(eq(projects.id, id)).limit(1).then((r) => r[0]);
  }

  async create(name: string): Promise<Project> {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-|-$/g, "") || `project-${Date.now()}`;
    const [row] = await this.db.insert(projects).values({ name, slug }).returning();
    return row!;
  }

  remove(id: number) {
    return this.db.delete(projects).where(eq(projects.id, id));
  }
}
