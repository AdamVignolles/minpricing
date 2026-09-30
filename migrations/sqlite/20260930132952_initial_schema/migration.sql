-- nonce:20260930134100 (forces a fresh D1 import etag; see DEPLOY.md)
CREATE TABLE `alepha_sequences` (
	`id` text PRIMARY KEY,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'default' NOT NULL,
	`value` integer NOT NULL
);

--> statement-breakpoint
CREATE TABLE `job_executions` (
	`id` text PRIMARY KEY,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`job_name` text NOT NULL,
	`key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 1 NOT NULL,
	`redispatch_count` integer DEFAULT 0 NOT NULL,
	`payload` text,
	`scheduled_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error` text,
	`logs` text,
	`triggered_by` text,
	`triggered_by_name` text,
	`cancelled_by` text,
	`cancelled_by_name` text
);

--> statement-breakpoint
CREATE TABLE `deals` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`image_url` text,
	`merchant_id` text,
	`category_id` text,
	`current_price` real NOT NULL,
	`old_price` real,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`discount_percentage` real,
	`availability` text DEFAULT 'unknown' NOT NULL,
	`start_date` integer,
	`end_date` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` text PRIMARY KEY,
	`deal_id` text NOT NULL,
	`price` real NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`observed_at` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`domain` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_error_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `tracked_products` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`merchant_id` text,
	`category_id` text,
	`steam_app_id` real,
	`manual_price` real,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `dealabs_drafts` (
	`id` text PRIMARY KEY,
	`deal_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`generated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `alepha_sequences_name_scope_idx` ON `alepha_sequences` (`name`,`scope`);
--> statement-breakpoint
CREATE INDEX `job_executions_status_scheduled_at_idx` ON `job_executions` (`status`,`scheduled_at`);
--> statement-breakpoint
CREATE INDEX `job_executions_status_updated_at_idx` ON `job_executions` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `job_executions_job_name_status_scheduled_at_idx` ON `job_executions` (`job_name`,`status`,`scheduled_at`);
--> statement-breakpoint
CREATE INDEX `job_executions_job_name_status_created_at_idx` ON `job_executions` (`job_name`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `job_executions_job_name_started_at_idx` ON `job_executions` (`job_name`,`started_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_executions_job_name_key_idx` ON `job_executions` (`job_name`,`key`);
--> statement-breakpoint
CREATE INDEX `deals_source_id_idx` ON `deals` (`source_id`);
--> statement-breakpoint
CREATE INDEX `deals_status_idx` ON `deals` (`status`);
--> statement-breakpoint
CREATE INDEX `deals_score_idx` ON `deals` (`score`);
--> statement-breakpoint
CREATE UNIQUE INDEX `deals_source_id_external_id_idx` ON `deals` (`source_id`,`external_id`);
--> statement-breakpoint
CREATE INDEX `price_history_deal_id_idx` ON `price_history` (`deal_id`);
--> statement-breakpoint
CREATE INDEX `price_history_observed_at_idx` ON `price_history` (`observed_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_idx` ON `categories` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_name_idx` ON `merchants` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_name_idx` ON `sources` (`name`);
--> statement-breakpoint
CREATE INDEX `tracked_products_source_id_idx` ON `tracked_products` (`source_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dealabs_drafts_deal_id_idx` ON `dealabs_drafts` (`deal_id`);
--> statement-breakpoint
CREATE INDEX `dealabs_drafts_status_idx` ON `dealabs_drafts` (`status`);