import { extname } from "node:path";
import { UsageError } from "./errors.ts";

/** A config as written, unchecked: a JSON file's object, or a JS/TS one's default export. `loadConfig` checks it. */
export async function loadRawConfig(path: string): Promise<unknown> {
  if (extname(path) === ".json") {
    try {
      return JSON.parse(await Bun.file(path).text());
    } catch (e) {
      throw new UsageError(
        `config: ${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const mod: unknown = await import(path);
  return typeof mod === "object" && mod !== null && "default" in mod ? mod.default : undefined;
}
