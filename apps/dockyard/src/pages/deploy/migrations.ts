import type { MigrationsJournal } from "drizzle-orm/migrator";

/** deploy 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0000_init",
    timestamp: 1,
    sql: "CREATE TABLE `deploy_targets` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`repoUrl` text,\n\t`branch` text DEFAULT 'main',\n\t`composePath` text DEFAULT 'docker-compose.yml',\n\t`serviceName` text,\n\t`dbType` text,\n\t`remoteDir` text,\n\t`envJson` text,\n\t`lastKnownSha` text,\n\t`updateAvailable` integer DEFAULT false NOT NULL,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE\n);\n--> statement-breakpoint\nCREATE TABLE `deploy_runs` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`targetId` integer NOT NULL,\n\t`status` text DEFAULT 'queued' NOT NULL,\n\t`commitSha` text,\n\t`logText` text DEFAULT '' NOT NULL,\n\t`startedAt` integer NOT NULL,\n\t`finishedAt` integer,\n\tCONSTRAINT `fk_deployments_targetId_deploy_targets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `deploy_targets`(`id`) ON DELETE CASCADE\n);",
  },
  {
    name: "0001_target_etag",
    timestamp: 2,
    sql: "ALTER TABLE `deploy_targets` ADD `etag` text;",
  },
  {
    name: "0002_instance_logical_db",
    timestamp: 3,
    sql: "ALTER TABLE `deploy_targets` ADD `instanceOf` integer REFERENCES deploy_targets(id);--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `containerName` text;--> statement-breakpoint\nPRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_deploy_targets` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`instanceOf` integer,\n\t`containerName` text,\n\t`repoUrl` text,\n\t`branch` text DEFAULT 'main',\n\t`composePath` text DEFAULT 'docker-compose.yml',\n\t`serviceName` text,\n\t`dbType` text,\n\t`remoteDir` text,\n\t`envJson` text,\n\t`lastKnownSha` text,\n\t`etag` text,\n\t`updateAvailable` integer DEFAULT false NOT NULL,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_deploy_targets_instanceOf_deploy_targets_id_fk` FOREIGN KEY (`instanceOf`) REFERENCES `deploy_targets`(`id`),\n\tCONSTRAINT `deploy_targets_nodeId_kind_name_unique` UNIQUE(`nodeId`,`kind`,`name`)\n);\n--> statement-breakpoint\nINSERT INTO `__new_deploy_targets`(`id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt`) SELECT `id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt` FROM `deploy_targets`;--> statement-breakpoint\nDROP TABLE `deploy_targets`;--> statement-breakpoint\nALTER TABLE `__new_deploy_targets` RENAME TO `deploy_targets`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;",
  },
  {
    name: "0004_override_compose",
    timestamp: 5,
    sql: "ALTER TABLE `deploy_targets` ADD `overrideCompose` text;",
  },
  {
    name: "0005_depends_on",
    timestamp: 6,
    sql: "ALTER TABLE `deploy_targets` ADD `dependsOn` text;",
  },
  {
    name: "0006_target_services",
    timestamp: 7,
    sql: "ALTER TABLE `deploy_targets` ADD `servicesJson` text;",
  },
  {
    name: "0007_nested_canvas",
    timestamp: 8,
    sql: "ALTER TABLE `deploy_targets` ADD `x` integer;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `y` integer;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `serviceLayout` text;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `depEdges` text;",
  },
  {
    name: "0008_card_size",
    timestamp: 9,
    sql: "ALTER TABLE `deploy_targets` ADD `w` integer;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `h` integer;",
  },
  {
    name: "0010_openship_shared",
    timestamp: 11,
    sql: "ALTER TABLE `deploy_targets` ADD `groupId` integer REFERENCES service_groups(id);",
  },
  {
    name: "0011_up_services",
    timestamp: 12,
    sql: "ALTER TABLE `deploy_targets` ADD `upServices` text;",
  },
];
