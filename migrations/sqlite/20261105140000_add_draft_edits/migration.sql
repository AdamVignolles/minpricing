ALTER TABLE `dealabs_drafts` ADD `edited_at` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `edited_by` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `template_version` text;