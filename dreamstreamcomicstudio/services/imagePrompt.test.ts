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

  it("adds a distinct-character instruction when a panel has 2+ required entities", () => {
    const prompt = buildImagePrompt({
      stage: "panel",
      stylePrompt: "clean line art",
      sceneAction: "Maya haggles with Arjun at the market",
      requiredEntityNames: "Maya, Arjun"
    });

    expect(prompt).toContain("Multiple DISTINCT characters appear");
    expect(prompt.toLowerCase()).toContain("never merge two characters");
    expect(prompt).toContain("one per named character");
  });

  it("does NOT add the distinct-character instruction for a single character", () => {
    const prompt = buildImagePrompt({
      stage: "panel",
      stylePrompt: "clean line art",
      sceneAction: "Maya opens the notebook",
      requiredEntityNames: "Maya"
    });

    expect(prompt).not.toContain("Multiple DISTINCT characters");
  });

  it("detects multiple entities from the visual-reference block when names are absent", () => {
    const prompt = buildImagePrompt({
      stage: "panel",
      stylePrompt: "clean line art",
      sceneAction: "Two figures meet",
      entityVisualRef: "[Maya]: a young chef\n[Arjun]: an older vendor"
    });

    expect(prompt).toContain("Multiple DISTINCT characters appear");
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
