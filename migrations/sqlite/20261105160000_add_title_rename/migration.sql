ALTER TABLE `deals` ADD `short_title` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `title_trimmed` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `title_trimmed` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `title_approved_at` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `title_approved_by` text;