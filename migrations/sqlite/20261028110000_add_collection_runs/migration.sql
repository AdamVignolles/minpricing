CREATE TABLE `collection_runs` (
	`id` text PRIMARY KEY,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`skip_reason` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`results` text,
	`switched_off` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE INDEX `collection_runs_started_at_idx` ON `collection_runs` (`started_at`);
