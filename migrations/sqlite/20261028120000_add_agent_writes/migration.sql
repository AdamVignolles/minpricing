CREATE TABLE `agent_writes` (
	`id` text PRIMARY KEY,
	`agent` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`reason` text,
	`summary` text,
	`before` text,
	`after` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE INDEX `agent_writes_created_at_idx` ON `agent_writes` (`created_at`);
--> statement-breakpoint
CREATE INDEX `agent_writes_target_idx` ON `agent_writes` (`target`);