ALTER TABLE `members` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
-- Every org's earliest member (by created_at, then user id) becomes its owner, so no org is left without one.
UPDATE `members` SET `role` = 'owner' WHERE `user_id` = (SELECT m.`user_id` FROM `members` m WHERE m.`org_id` = `members`.`org_id` ORDER BY m.`created_at`, m.`user_id` LIMIT 1);
