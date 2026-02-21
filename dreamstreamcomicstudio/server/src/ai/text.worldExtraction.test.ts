import { describe, expect, it } from "vitest";
import type { Character, Item, Location, Scene } from "../../../types.js";
import { buildWorldExtractionPrompt, filterExtractedWorldData } from "./text.js";

describe("world extraction grounding", () => {
  const scenes: Scene[] = [
    {
      id: 1,
      rawText: "Arjun studies the Zenith Spear in the attic workshop while Sana watches.",
      synopsis: "Arjun studies the Zenith Spear in the attic.",
      characters: ["Arjun", "Sana"],
      setting: "Dusty attic workshop"
    }
  ];

  it("builds prompt from scene context", () => {
    const sceneContext = scenes
      .map((scene) => `Scene ${scene.id}: ${scene.synopsis}`)
      .join("\n");
    const prompt = buildWorldExtractionPrompt(sceneContext);

    expect(prompt).toContain("Use ONLY the provided source excerpts");
    expect(prompt).toContain("Scene 1: Arjun studies the Zenith Spear in the attic.");
  });

  it("filters unrelated entities after extraction", () => {
    const characters: Character[] = [
      { id: "1", name: "Arjun", bio: "", description: "Teen inventor with curly hair", referenceImageIds: [] },
      { id: "2", name: "Batman", bio: "", description: "Caped vigilante from Gotham", referenceImageIds: [] }
    ];
    const items: Item[] = [
      { id: "3", name: "Zenith Spear", description: "A glowing relic weapon in pieces", referenceImageIds: [] },
      { id: "4", name: "Lightsaber", description: "A plasma blade from another universe", referenceImageIds: [] }
    ];
    const locations: Location[] = [
      { id: "5", name: "Attic workshop", description: "Wooden room with dust and tools", referenceImageIds: [] },
      { id: "6", name: "Mars Colony", description: "A red-planet megacity dome", referenceImageIds: [] }
    ];

    const filtered = filterExtractedWorldData(scenes, { characters, items, locations }, {
      script: "Arjun studies the Zenith Spear in the attic workshop while Sana watches."
    });

    expect(filtered.characters.map((entry) => entry.name)).toEqual(["Arjun"]);
    expect(filtered.items.map((entry) => entry.name)).toEqual(["Zenith Spear"]);
    expect(filtered.locations.map((entry) => entry.name)).toEqual(["Attic workshop"]);
    expect(filtered.diagnostics.input_scene_count).toBe(1);
    expect(filtered.diagnostics.filtered_entity_count).toBeGreaterThan(0);
    expect(filtered.diagnostics.ungrounded_characters_dropped).toBeGreaterThanOrEqual(1);
    expect(filtered.diagnostics.dropped_entities.length).toBeGreaterThan(0);
  });
});
