import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, orgs } from "./schema";

/* PR comments. Beside `schema.ts`, which `drizzle.config.ts` reads with it; `schema.ts` is at its line cap. */

/**
 * The one PixelSlash comment on a pull request (PS-82), edited in place by each new build of the
 * PR, with a section for every one of the org's projects on that repo. Keyed by org, repo and PR
 * number, so the projects of one repo share it and another org linking the same repo keeps its own.
 */
export const prComments = sqliteTable(
  "pr_comments",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** `owner/name` in lower case: GitHub ignores case in both. */
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    /** GitHub's id of the comment. */
    commentId: integer("comment_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.repo, t.prNumber] })],
);
