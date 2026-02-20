import { describe, expect, it } from "vitest";
import { hasMultiFrameLanguage, sanitizePanelDescription } from "./panelDescription";

describe("panel description sanitization", () => {
  it("detects banned multi-frame language", () => {
    expect(hasMultiFrameLanguage("Split panel: top half shows dawn, bottom half shows battle.")).toBe(true);
    expect(hasMultiFrameLanguage("Single character close-up in one frame.")).toBe(false);
  });

  it("rewrites multi-frame directives into single-frame language", () => {
    const sanitized = sanitizePanelDescription("Panel 1 split panel, top half city, bottom half cave montage");
    expect(sanitized.flagged).toBe(true);
    expect(sanitized.text.toLowerCase()).not.toContain("panel 1");
    expect(sanitized.text.toLowerCase()).not.toContain("split panel");
    expect(sanitized.text.toLowerCase()).not.toContain("montage");
  });
});
