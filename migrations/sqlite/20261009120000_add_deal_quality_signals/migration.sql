ALTER TABLE `deals` ADD `seller_name` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `sold_by_merchant` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `shipped_by_merchant` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `seller_rating` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `seller_sales_count` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `offers_count` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `best_other_offer_price` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `product_rating` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `product_review_count` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `recent_purchases` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `condition` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `ean` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `lowest_recent_price` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `list_price_kind` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `market_price` real;
--> statement-breakpoint
ALTER TABLE `deals` ADD `market_price_source` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `market_price_url` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `market_checked_at` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `details_checked_at` integer;
