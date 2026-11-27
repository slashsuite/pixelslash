import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

/**
 * The engine's `diff-module.bun.ts` for a DOM test that diffs. happy-dom puts its own `URL` on the
 * global, which resolves a file URL against its page, so the engine cannot find `diff.wasm` by
 * `import.meta.url` there. This finds it with node's URL. In the test file:
 *
 * vi.mock("../../../../packages/engine/src/diff-module.bun.ts", () => import("#/test/diff-module"));
 */
const wasm = new NodeURL("../../../../packages/engine/wasm/diff.wasm", import.meta.url);

let compiled: WebAssembly.Module | null = null;

export function diffModule(): WebAssembly.Module {
  compiled ??= new WebAssembly.Module(readFileSync(fileURLToPath(wasm)));
  return compiled;
}
