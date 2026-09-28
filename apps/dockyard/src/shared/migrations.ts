import type { MigrationsJournal } from "drizzle-orm/migrator";

/**
 * 迁移日志以纯 TS 内嵌，而非运行时读 drizzle/ 目录——
 * `bun --compile` 后没有文件系统里的 migrationsFolder 可读。
 * 变更 schema 后跑 `bunx drizzle-kit generate`，把生成的 SQL 同步到这里。
 * 注意：drizzle rc 默认 camelCase 列名，SQL 以 generate 输出为准，勿手写。
 */
export const migrationsJournal: MigrationsJournal = [
  {
    name: "0000_init",
    timestamp: 1,
    sql: "CREATE TABLE `canvas_nodes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`projectId` integer NOT NULL,\n\t`serverId` integer NOT NULL,\n\t`x` integer DEFAULT 40 NOT NULL,\n\t`y` integer DEFAULT 40 NOT NULL,\n\t`w` integer DEFAULT 320 NOT NULL,\n\t`h` integer DEFAULT 240 NOT NULL,\n\tCONSTRAINT `fk_canvas_nodes_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_canvas_nodes_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE CASCADE\n);\n--> statement-breakpoint\nCREATE TABLE `deploy_targets` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`repoUrl` text,\n\t`branch` text DEFAULT 'main',\n\t`composePath` text DEFAULT 'docker-compose.yml',\n\t`serviceName` text,\n\t`dbType` text,\n\t`remoteDir` text,\n\t`envJson` text,\n\t`lastKnownSha` text,\n\t`updateAvailable` integer DEFAULT false NOT NULL,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE\n);\n--> statement-breakpoint\nCREATE TABLE `deployments` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`targetId` integer NOT NULL,\n\t`status` text DEFAULT 'queued' NOT NULL,\n\t`commitSha` text,\n\t`logText` text DEFAULT '' NOT NULL,\n\t`startedAt` integer NOT NULL,\n\t`finishedAt` integer,\n\tCONSTRAINT `fk_deployments_targetId_deploy_targets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `deploy_targets`(`id`) ON DELETE CASCADE\n);\n--> statement-breakpoint\nCREATE TABLE `projects` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`name` text NOT NULL,\n\t`slug` text NOT NULL UNIQUE,\n\t`createdAt` integer NOT NULL\n);\n--> statement-breakpoint\nCREATE TABLE `servers` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`name` text NOT NULL,\n\t`host` text NOT NULL,\n\t`port` integer DEFAULT 22 NOT NULL,\n\t`user` text NOT NULL,\n\t`authType` text DEFAULT 'key' NOT NULL,\n\t`keyPath` text,\n\t`password` text,\n\t`dockerStatus` text DEFAULT 'unknown' NOT NULL,\n\t`dockerVersion` text,\n\t`hostKeyFingerprint` text,\n\t`lastCheckedAt` integer,\n\t`createdAt` integer NOT NULL\n);",
  },
  {
    name: "0001_target_etag",
    timestamp: 2,
    sql: "ALTER TABLE `deploy_targets` ADD `etag` text;",
  },
  {
    name: "0002_instance_logical_db",
    timestamp: 3,
    sql: "ALTER TABLE `deploy_targets` ADD `instanceOf` integer REFERENCES deploy_targets(id);--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `containerName` text;--> statement-breakpoint\nALTER TABLE `servers` ADD `machineId` text;--> statement-breakpoint\nALTER TABLE `servers` ADD `dockerId` text;--> statement-breakpoint\nPRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_deploy_targets` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`instanceOf` integer,\n\t`containerName` text,\n\t`repoUrl` text,\n\t`branch` text DEFAULT 'main',\n\t`composePath` text DEFAULT 'docker-compose.yml',\n\t`serviceName` text,\n\t`dbType` text,\n\t`remoteDir` text,\n\t`envJson` text,\n\t`lastKnownSha` text,\n\t`etag` text,\n\t`updateAvailable` integer DEFAULT false NOT NULL,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_deploy_targets_instanceOf_deploy_targets_id_fk` FOREIGN KEY (`instanceOf`) REFERENCES `deploy_targets`(`id`),\n\tCONSTRAINT `deploy_targets_nodeId_kind_name_unique` UNIQUE(`nodeId`,`kind`,`name`)\n);\n--> statement-breakpoint\nINSERT INTO `__new_deploy_targets`(`id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt`) SELECT `id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt` FROM `deploy_targets`;--> statement-breakpoint\nDROP TABLE `deploy_targets`;--> statement-breakpoint\nALTER TABLE `__new_deploy_targets` RENAME TO `deploy_targets`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;",
  },
  {
    name: "0003_domains",
    timestamp: 4,
    sql: "CREATE TABLE `domains` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`targetId` integer NOT NULL,\n\t`hostname` text NOT NULL,\n\t`serviceName` text,\n\t`targetPort` integer NOT NULL,\n\t`dnsStatus` text DEFAULT 'unknown' NOT NULL,\n\t`sslStatus` text DEFAULT 'none' NOT NULL,\n\t`sslError` text,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_domains_targetId_deploy_targets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `deploy_targets`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `domains_targetId_hostname_unique` UNIQUE(`targetId`,`hostname`)\n);",
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
];
