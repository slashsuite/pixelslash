-- One PR comment per pull request for all of an org's projects on the repo: the key moves from
-- (project, PR) to (org, repo in lower case, PR). Of the comments a PR already has, the oldest is
-- kept and edited from now on; the rest are no longer tracked and stay on GitHub as they are.
-- Nothing references pr_comments, so a plain rebuild drops nothing else.
CREATE TABLE `__new_pr_comments` (
	`org_id` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`comment_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `pr_number`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `__new_pr_comments`("org_id", "repo", "pr_number", "comment_id", "created_at")
SELECT p.`org_id`, lower(p.`github_repo`), c.`pr_number`, c.`comment_id`, c.`created_at`
FROM `pr_comments` c JOIN `projects` p ON p.`id` = c.`project_id`
WHERE p.`github_repo` IS NOT NULL
ORDER BY c.`created_at`, c.`rowid`;--> statement-breakpoint
DROP TABLE `pr_comments`;--> statement-breakpoint
ALTER TABLE `__new_pr_comments` RENAME TO `pr_comments`;
