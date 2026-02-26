import { describe, expect, it } from "vitest";
import { buildImagePrompt } from "./imagePrompt";

describe("buildImagePrompt panel contract", () => {
  it("enforces single-frame constraints for panel stage", () => {
    const prompt = buildImagePrompt({
      stage: "panel",
      stylePrompt: "clean line art",
      layoutType: "grid",
      sceneAction: "Hero runs toward the relic"
    });

    expect(prompt).toContain("Single frame only");
    expect(prompt.toLowerCase()).toContain("no split panels");
    expect(prompt).not.toContain("Layout: grid");
  });

  it("enforces single-frame constraints for panel regeneration stage", () => {
    const prompt = buildImagePrompt({
      stage: "panel_regen",
      stylePrompt: "clean line art",
      layoutType: "grid",
      sceneAction: "Hero runs toward the relic"
    });

    expect(prompt).toContain("Single frame only");
    expect(prompt.toLowerCase()).toContain("no montage");
    expect(prompt).not.toContain("Layout: grid");
  });

  it("keeps style prompts entity-free", () => {
    const prompt = buildImagePrompt({
      stage: "style",
      stylePrompt: "ink wash noir",
      sceneAction: "Milo and Pepper chase a yellow ball",
      setting: "Rooftop at dusk",
      characters: "Milo, Pepper",
      extraNotes: "No story spoilers."
    });

    expect(prompt.toLowerCase()).toContain("no named characters");
    expect(prompt).not.toContain("Milo");
    expect(prompt).not.toContain("Pepper");
    expect(prompt).not.toContain("Rooftop");
  });
});
