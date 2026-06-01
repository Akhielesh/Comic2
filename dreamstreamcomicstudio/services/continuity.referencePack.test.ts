import { describe, expect, it } from "vitest";
import type { ComicPanel, ComicState } from "../types";
import { buildPanelReferencePack } from "./continuity";

const makeState = (): ComicState => ({
  step: 0,
  maxStepReached: 0,
  script: "",
  scenes: [{ id: 1, rawText: "", synopsis: "Hero retrieves relic", characters: ["Hero"], setting: "Temple" }],
  styleVariants: [],
  stylePrompt: "",
  styleCategory: "",
  styleAspectRatio: "1:1",
  imageResolution: "1K",
  characters: [
    { id: "char-1", name: "Hero", bio: "", description: "Main hero", imageId: "char-img-1", referenceImageIds: [] }
  ],
  items: [
    { id: "item-1", name: "Relic", description: "Ancient relic", referenceImageIds: ["item-ref-1"] }
  ],
  locations: [
    { id: "loc-1", name: "Temple", description: "Ruins", imageId: "loc-img-1", referenceImageIds: [] }
  ],
  continuity: {
    lockLevel: "strict",
    fallbackPolicy: "auto",
    bible: {
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      entities: [],
      sceneBindings: [{
        sceneId: 1,
        characterIds: ["char-1"],
        itemIds: ["item-1"],
        locationId: "loc-1",
        requiredEntityIds: ["char-1", "item-1"]
      }]
    }
  },
  layoutType: "grid",
  panels: []
});

describe("buildPanelReferencePack", () => {
  it("leads with story refs and drops the style image when entity refs exist", () => {
    const state = makeState();
    const panel: ComicPanel = {
      id: "panel-1",
      sceneId: 1,
      description: "Hero grabs relic",
      dialogue: "",
      imageIdHistory: []
    };

    const pack = buildPanelReferencePack(state, panel, {
      styleImageId: "style-img-1",
      lastPanelImageId: "prior-panel-img",
      maxReferences: 8
    });

    // Concrete story references lead (image models weight the first reference most), and the
    // style preview is intentionally excluded here so it can't override the panel's subject.
    expect(pack.imageIds).toEqual([
      "char-img-1",
      "loc-img-1",
      "prior-panel-img",
      "item-ref-1"
    ]);
    expect(pack.imageIds).not.toContain("style-img-1");
  });

  it("falls back to the style image only when there are no entity references", () => {
    const state = makeState();
    // Strip the scene binding so no entities resolve for this panel.
    state.continuity!.bible.sceneBindings[0].requiredEntityIds = [];
    const panel: ComicPanel = {
      id: "panel-no-entities",
      sceneId: 1,
      description: "Empty establishing shot",
      dialogue: "",
      imageIdHistory: []
    };

    const pack = buildPanelReferencePack(state, panel, {
      styleImageId: "style-img-1",
      maxReferences: 8
    });

    expect(pack.imageIds).toContain("style-img-1");
  });

  it("caps references at 8", () => {
    const state = makeState();
    state.characters.push(
      { id: "char-2", name: "Sidekick", bio: "", description: "", imageId: "char-img-2", referenceImageIds: [] },
      { id: "char-3", name: "Mage", bio: "", description: "", imageId: "char-img-3", referenceImageIds: [] },
      { id: "char-4", name: "Guard", bio: "", description: "", imageId: "char-img-4", referenceImageIds: [] },
      { id: "char-5", name: "Scout", bio: "", description: "", imageId: "char-img-5", referenceImageIds: [] }
    );
    state.continuity!.bible.sceneBindings[0].requiredEntityIds = ["char-1", "char-2", "char-3", "char-4", "char-5", "item-1"];

    const panel: ComicPanel = {
      id: "panel-2",
      sceneId: 1,
      description: "Wide battle shot",
      dialogue: "",
      imageIdHistory: []
    };

    const pack = buildPanelReferencePack(state, panel, {
      styleImageId: "style-img",
      lastPanelImageId: "prior-img",
      maxReferences: 8
    });

    expect(pack.imageIds.length).toBeLessThanOrEqual(8);
  });
});
