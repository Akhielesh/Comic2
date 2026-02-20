import { describe, expect, it } from "vitest";
import type { Character, Item, Scene, ContinuityState } from "../types";
import { buildContinuityFromWorld } from "./continuity";

const baseState = (lockLevel: ContinuityState["lockLevel"]): ContinuityState => ({
  bible: {
    version: 1,
    entities: [],
    sceneBindings: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  },
  lockLevel,
  fallbackPolicy: "auto"
});

describe("continuity grounding", () => {
  it("uses scene rawText first in strict mode", () => {
    const scenes: Scene[] = [
      {
        id: 1,
        rawText: "Arjun braces the Zenith Spear as the attic floor rattles.",
        synopsis: "Batman ignites a lightsaber in the attic.",
        characters: [],
        setting: "Dusty attic"
      }
    ];

    const characters: Character[] = [
      { id: "char-arjun", name: "Arjun", bio: "Teen inventor", description: "Teen inventor", referenceImageIds: [] },
      { id: "char-batman", name: "Batman", bio: "Caped hero", description: "Caped hero", referenceImageIds: [] }
    ];
    const items: Item[] = [
      { id: "item-spear", name: "Zenith Spear", description: "Ancient spear", referenceImageIds: [] },
      { id: "item-lightsaber", name: "Lightsaber", description: "Energy blade", referenceImageIds: [] }
    ];

    const continuity = buildContinuityFromWorld(scenes, characters, items, [], baseState("strict"));
    const binding = continuity.bible.sceneBindings[0];

    expect(binding.characterIds).toEqual(["char-arjun"]);
    expect(binding.itemIds).toEqual(["item-spear"]);
  });

  it("falls back to synopsis matching only when lock level is non-strict", () => {
    const scenes: Scene[] = [
      {
        id: 1,
        rawText: "A quiet attic with scattered tools.",
        synopsis: "Sana finds the hidden compass under the floorboards.",
        characters: [],
        setting: "Dusty attic"
      }
    ];

    const characters: Character[] = [
      { id: "char-sana", name: "Sana", bio: "Curious scout", description: "Curious scout", referenceImageIds: [] }
    ];

    const strictContinuity = buildContinuityFromWorld(scenes, characters, [], [], baseState("strict"));
    expect(strictContinuity.bible.sceneBindings[0].characterIds).toEqual([]);

    const flexibleContinuity = buildContinuityFromWorld(scenes, characters, [], [], baseState("flexible"));
    expect(flexibleContinuity.bible.sceneBindings[0].characterIds).toEqual(["char-sana"]);
  });
});
