CREATE TABLE `watched_links` (
	`id` text PRIMARY KEY,
	`url` text NOT NULL,
	`canonical_url` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`added_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verdict` text,
	`steps` text,
	`last_checked_at` integer,
	`deal_id` text,
	`watch_until` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE INDEX `watched_links_source_id_idx` ON `watched_links` (`source_id`);
--> statement-breakpoint
CREATE INDEX `watched_links_status_idx` ON `watched_links` (`status`);