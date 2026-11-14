CREATE TABLE `catalog_offers` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`brand` text,
	`reference` text,
	`sku` text,
	`ean` text,
	`image_url` text,
	`description` text,
	`price` real,
	`list_price` real,
	`currency` text,
	`availability` text DEFAULT 'unknown' NOT NULL,
	`rating` real,
	`review_count` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_read_at` integer,
	`read_failures` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `catalog_price_history` (
	`id` text PRIMARY KEY,
	`offer_id` text NOT NULL,
	`price` real NOT NULL,
	`observed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);

--> statement-breakpoint
CREATE INDEX `catalog_offers_status_idx` ON `catalog_offers` (`status`);
--> statement-breakpoint
CREATE INDEX `catalog_offers_updated_at_idx` ON `catalog_offers` (`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_offers_source_id_external_id_idx` ON `catalog_offers` (`source_id`,`external_id`);
--> statement-breakpoint
CREATE INDEX `catalog_price_history_offer_id_idx` ON `catalog_price_history` (`offer_id`);
--> statement-breakpoint
CREATE INDEX `catalog_price_history_created_at_idx` ON `catalog_price_history` (`created_at`);
