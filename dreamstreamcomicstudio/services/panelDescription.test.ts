import { describe, expect, it } from "vitest";
import { hasMultiFrameLanguage, sanitizePanelDescription, derivePanelTitle } from "./panelDescription";

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

describe("derivePanelTitle", () => {
  it("prefers an explicit title", () => {
    expect(derivePanelTitle({ title: "The Boat Departs", description: "a long prose prompt..." })).toBe("The Boat Departs");
  });

  it("derives a short label from the focal subject, dropping a leading article", () => {
    expect(derivePanelTitle({ focalSubject: "the weathered fishing trawler at dawn" })).toBe("Weathered fishing trawler at dawn");
  });

  it("caps a long description to a few words", () => {
    const title = derivePanelTitle({ description: "A hero stands on a cliff overlooking the vast burning city below at night" });
    expect(title.split(" ").length).toBeLessThanOrEqual(6);
  });

  it("falls back to a numbered panel label", () => {
    expect(derivePanelTitle({}, 2)).toBe("Panel 3");
  });
});
