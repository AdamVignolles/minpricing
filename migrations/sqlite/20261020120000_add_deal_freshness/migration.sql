ALTER TABLE `deals` ADD `fresh_at` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `fresh_reason` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `dropped_from` real;
--> statement-breakpoint
UPDATE `deals` SET `fresh_at` = `first_seen_at`, `fresh_reason` = 'new' WHERE `fresh_at` IS NULL;