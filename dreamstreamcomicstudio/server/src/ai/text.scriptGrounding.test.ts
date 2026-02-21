import { describe, expect, it } from "vitest";
import { normalizeAnalyzedScenes } from "./text.js";

describe("analyze script grounding normalization", () => {
  it("drops ungrounded scene characters and falls back to script excerpts", () => {
    const script = `
Scene 1: Arjun and Sana enter the attic workshop, carrying the Zenith Spear fragments.

Scene 2: Leo calibrates the signal device near the window.
    `.trim();

    const normalized = normalizeAnalyzedScenes(
      [
        {
          id: 1,
          rawText: "This excerpt is not in the script.",
          synopsis: "Arjun and Sana enter the attic workshop with spear fragments.",
          characters: ["Arjun", "Batman", "Sana"],
          setting: "Dusty attic workshop"
        }
      ],
      script
    );

    expect(normalized.scenes).toHaveLength(1);
    expect(normalized.scenes[0].rawText.toLowerCase()).toContain("arjun");
    expect(normalized.scenes[0].characters).toEqual(["Arjun", "Sana"]);
    expect(normalized.diagnostics.ungroundedCharactersDropped).toBe(1);
    expect(normalized.diagnostics.rawExcerptFallbackCount).toBe(1);
    expect(normalized.diagnostics.coreEntityDrops).toBe(1);
    expect(normalized.diagnostics.segmentCount).toBeGreaterThanOrEqual(1);
    expect(normalized.diagnostics.fallbackSceneCount).toBeGreaterThanOrEqual(1);
  });

  it("repairs synopsis and setting drift with literal grounded fallbacks", () => {
    const script = `
Scene 1: SALTY and PIP creep through the flooded tunnel at dusk.
    `.trim();

    const normalized = normalizeAnalyzedScenes(
      [
        {
          id: 1,
          segmentId: 1,
          rawText: "SALTY and PIP creep through the flooded tunnel at dusk.",
          synopsis: "A dragon army storms a floating palace above a crystal sea.",
          characters: ["SALTY", "PIP"],
          setting: "Sky citadel above the clouds"
        }
      ],
      script
    );

    expect(normalized.scenes).toHaveLength(1);
    expect(normalized.scenes[0].synopsis.toLowerCase()).toContain("salty");
    expect(normalized.scenes[0].setting.toLowerCase()).toContain("scene");
    expect(normalized.diagnostics.plotDriftCorrections).toBeGreaterThan(0);
  });
});
