ALTER TABLE `dealabs_drafts` ADD `publish_attempts` real;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `last_publish_attempt_at` integer;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `last_publish_result` text;
--> statement-breakpoint
ALTER TABLE `dealabs_drafts` ADD `last_publish_error` text;
