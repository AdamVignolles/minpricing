ALTER TABLE `dealabs_drafts` ADD `verified_at` integer;
--> statement-breakpoint
ALTER TABLE `tracked_products` ADD `idealo_reference_price` real;
--> statement-breakpoint
ALTER TABLE `tracked_products` ADD `idealo_checked_at` integer;
