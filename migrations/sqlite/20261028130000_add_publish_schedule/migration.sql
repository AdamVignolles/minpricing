CREATE TABLE `publish_schedule` (
	`id` text PRIMARY KEY,
	`date` text NOT NULL,
	`planned_at` integer NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`result` text,
	`deal_id` text,
	`title` text,
	`dealabs_url` text,
	`note` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`prepared_by` text NOT NULL,
	`executed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE INDEX `publish_schedule_date_idx` ON `publish_schedule` (`date`);
--> statement-breakpoint
CREATE INDEX `publish_schedule_status_idx` ON `publish_schedule` (`status`);