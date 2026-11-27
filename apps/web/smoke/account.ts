// Makes the deployed smoke's account (src/db/smoke-account.ts), from apps/web:
//
//   bun smoke/account.ts token                 a new personal token on stdout: store it as a secret
//   SMOKE_TOKEN_FILE=<file> bun smoke/account.ts sql > smoke.sql   (or SMOKE_TOKEN=...)
//   bunx wrangler d1 execute pixelslash --remote --env production --file smoke.sql
//
// The SQL holds only the token's hash. Apply it again to rotate the token; it adds no row.
import { readFile } from "node:fs/promises";
import { randomToken } from "#/lib/crypto";
import { smokeAccountSql } from "#/db/smoke-account";
import { USER_PREFIX } from "#/db/tokens";

const command = process.argv[2];
if (command === "token") {
  process.stdout.write(`${randomToken(USER_PREFIX)}\n`);
} else if (command === "sql") {
  const file = process.env["SMOKE_TOKEN_FILE"];
  const token = (file ? await readFile(file, "utf8") : (process.env["SMOKE_TOKEN"] ?? "")).trim();
  if (!token) throw new Error("set SMOKE_TOKEN or SMOKE_TOKEN_FILE to the smoke account's token");
  process.stdout.write(await smokeAccountSql(token));
} else {
  throw new Error("usage: bun smoke/account.ts token | sql");
}
