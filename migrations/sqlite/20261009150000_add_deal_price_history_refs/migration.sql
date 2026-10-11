ALTER TABLE `deals` ADD `dealabs_lowest_price` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `dealabs_lowest_at` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `dealabs_deals_count` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `dealabs_best_temperature` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `dealabs_history` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `dealabs_checked_at` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `historical_low_price` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `historical_low_at` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `historical_low_source` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `itad_id` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `itad_checked_at` integer;
