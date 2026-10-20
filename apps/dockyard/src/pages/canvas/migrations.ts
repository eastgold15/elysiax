import type { MigrationsJournal } from "drizzle-orm/migrator";

/** canvas 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0000_init",
    timestamp: 1,
    sql: "CREATE TABLE `canvas_nodes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`projectId` integer NOT NULL,\n\t`serverId` integer NOT NULL,\n\t`x` integer DEFAULT 40 NOT NULL,\n\t`y` integer DEFAULT 40 NOT NULL,\n\t`w` integer DEFAULT 320 NOT NULL,\n\t`h` integer DEFAULT 240 NOT NULL,\n\tCONSTRAINT `fk_canvas_nodes_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_canvas_nodes_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE CASCADE\n);",
  },
  {
    name: "0010_openship_shared",
    timestamp: 11,
    sql: "CREATE TABLE `service_groups` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`name` text NOT NULL,\n\t`x` integer DEFAULT 24 NOT NULL,\n\t`y` integer DEFAULT 24 NOT NULL,\n\t`w` integer DEFAULT 360 NOT NULL,\n\t`h` integer DEFAULT 280 NOT NULL,\n\tCONSTRAINT `fk_service_groups_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `service_groups_nodeId_name_unique` UNIQUE(`nodeId`,`name`)\n);",
  },
];
