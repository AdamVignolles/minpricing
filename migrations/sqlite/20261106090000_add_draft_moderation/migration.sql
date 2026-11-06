ALTER TABLE `dealabs_drafts` ADD `moderation_status` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `moderation_reason` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `moderation_message` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `moderation_at` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `moderation_checked_at` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `moderation_dismissed_at` integer;