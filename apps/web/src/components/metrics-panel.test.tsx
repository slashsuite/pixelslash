// @vitest-environment happy-dom
import type { Metrics } from "@slashsuite/pixelslash-engine/metrics-entry";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import { MetricsPanel } from "./metrics-panel";

/**
 * A shot's layout metrics (PS-294) in the side panel: each named part with what it measured and was
 * styled with, and no panel at all for a shot without a metrics file. The import, the upload and the
 * API read of those files are `api/metrics.test.ts` and `local-build/upload.local-build.test.ts`.
 */

const BUTTON: Metrics = {
  version: "1.0",
  root: "button",
  parts: {
    button: {
      box: { x: 0, y: 0, w: 96, h: 40 },
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      gap: 8,
      color: { bg: "#2563eb", border: "#1d4ed8" },
    },
    "button.label": {
      box: { x: 40, y: 10, w: 40, h: 20 },
      font: { size: 14, weight: 600, lineHeight: 20 },
      color: { fg: "#ffffff" },
    },
  },
};
const CARD: Metrics = {
  version: "1.0",
  root: "card",
  parts: {
    card: {
      box: { x: 0, y: 0, w: 320, h: 180 },
      padding: { top: 12, right: 12, bottom: 12, left: 12 },
    },
  },
};

afterEach(cleanup);

/** Renders the panel and opens it, as a reviewer does: the parts are folded under the summary. */
async function opened(metrics: Metrics) {
  render(<MetricsPanel metrics={metrics} />);
  await userEvent.setup().click(screen.getByTestId("metrics-summary"));
}

const parts = () =>
  within(screen.getByRole("list", { name: "Layout metrics per part" })).getAllByRole("listitem");

describe("the layout metrics panel", () => {
  test("lists each part with its box, padding, gap, font and colours", async () => {
    await opened(BUTTON);
    expect(screen.getByTestId("metrics-summary").textContent).toBe("Layout metrics (2 parts)");
    const [button, label] = parts();
    expect(button?.textContent).toContain("button");
    expect(button?.textContent).toContain("box 0, 0 · 96×40");
    expect(button?.textContent).toContain("padding 8 16 8 16");
    expect(button?.textContent).toContain("gap 8");
    expect(button?.textContent).toContain("bg #2563eb");
    expect(button?.textContent).toContain("border #1d4ed8");
    expect(label?.textContent).toContain("font 14/20 · 600");
    expect(label?.textContent).toContain("fg #ffffff");
  });

  test("one part is counted as one", async () => {
    await opened(CARD);
    expect(screen.getByTestId("metrics-summary").textContent).toBe("Layout metrics (1 part)");
    expect(parts()).toHaveLength(1);
    expect(parts()[0]?.textContent).toContain("320×180");
  });

  test("a shot without a metrics file has no panel", () => {
    const { container } = render(<MetricsPanel metrics={null} />);
    expect(container.innerHTML).toBe("");
  });
});
