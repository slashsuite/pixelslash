ALTER TABLE `members` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
-- Every org's earliest member (by created_at, then user id) becomes its owner, so no org is left without one.
UPDATE `members` SET `role` = 'owner' WHERE `user_id` = (SELECT m.`user_id` FROM `members` m WHERE m.`org_id` = `members`.`org_id` ORDER BY m.`created_at`, m.`user_id` LIMIT 1);--> statement-breakpoint
-- An org with no owner makes the member it gains its owner: a membership row written without a role
-- (as the Worker before this migration writes one, while a deploy runs) cannot leave an org ownerless.
CREATE TRIGGER `members_ownerless_org` AFTER INSERT ON `members`
WHEN NOT EXISTS (SELECT 1 FROM `members` o WHERE o.`org_id` = NEW.`org_id` AND o.`role` = 'owner')
BEGIN
  UPDATE `members` SET `role` = 'owner' WHERE `org_id` = NEW.`org_id` AND `user_id` = NEW.`user_id`;
END;
