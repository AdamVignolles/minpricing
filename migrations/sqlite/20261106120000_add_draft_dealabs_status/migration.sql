ALTER TABLE `dealabs_drafts` ADD `dealabs_status` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `dealabs_status_at` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `dealabs_checked_at` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `dealabs_status_source` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `posted_by` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `dealabs_temperature` real;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `dealabs_post_price` real;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `dealabs_status_history` text;
--> statement-breakpoint
UPDATE `dealabs_drafts` SET `dealabs_status` = 'live' WHERE `status` = 'posted' AND `dealabs_status` IS NULL;