import { describe, expect, it } from "vitest";
import type { ComicState, StyleVariant } from "../types";
import { AppStep } from "../types";
import {
  resetFromLayoutConfirm,
  resetFromScriptAnalysis,
  resetFromStyleConfirm,
  resetFromWorldConfirm
} from "./pipelineReset";

const makeState = (): ComicState => ({
  step: AppStep.REVIEW_EXPORT,
  maxStepReached: AppStep.REVIEW_EXPORT,
  flowVersion: 3,
  script: "Old script",
  scenes: [
    {
      id: 1,
      rawText: "Arjun runs through the attic with the Zenith Spear.",
      synopsis: "Arjun runs through the attic.",
      characters: ["Arjun"],
      setting: "Attic"
    }
  ],
  continuitySummary: "old continuity",
  continuity: undefined,
  styleVariants: [
    {
      id: "style-old",
      prompt: "old style",
      category: "Old",
      aspectRatio: "1:1",
      resolution: "1K",
      imageId: "style-old-image",
      imageUrl: "https://example.com/style-old.png"
    }
  ],
  selectedStyleId: "style-old",
  stylePrompt: "old style",
  styleImageId: "style-old-image",
  styleImageUrl: "https://example.com/style-old.png",
  styleCategory: "Old",
  styleAspectRatio: "1:1",
  imageResolution: "1K",
  characters: [
    {
      id: "char-1",
      name: "Arjun",
      bio: "Teen inventor",
      description: "Teen inventor",
      imageId: "char-image",
      imageUrl: "https://example.com/char.png",
      referenceImageIds: ["char-ref-1"]
    }
  ],
  items: [
    {
      id: "item-1",
      name: "Zenith Spear",
      description: "Ancient spear",
      imageId: "item-image",
      imageUrl: "https://example.com/item.png",
      referenceImageIds: ["item-ref-1"]
    }
  ],
  locations: [
    {
      id: "loc-1",
      name: "Attic",
      description: "Dusty attic",
      imageId: "loc-image",
      imageUrl: "https://example.com/loc.png",
      referenceImageIds: ["loc-ref-1"]
    }
  ],
  coverImageId: "cover-image",
  coverImageUrl: "https://example.com/cover.png",
  coverPrompt: "old cover",
  coverTemplateId: "cover-template",
  coverTemplateImageId: "cover-template-image",
  coverTemplateImageUrl: "https://example.com/cover-template.png",
  layoutType: "cinematic",
  gridTemplateId: "cinematic-template",
  customLayoutPrompt: "old layout",
  panels: [
    {
      id: "panel-1",
      sceneId: 1,
      description: "Old panel",
      dialogue: "Old line",
      imageId: "panel-image",
      imageUrl: "https://example.com/panel.png",
      imageIdHistory: [],
      imageUrlHistory: []
    }
  ],
  panelPlanVersion: 123,
  generationStatus: {
    isActive: false,
    progress: 100,
    startTime: Date.now(),
    estimatedTimeRemaining: "Done",
    currentStepDescription: "Complete",
    logs: [],
    completedPanels: 1,
    totalPanels: 1
  }
});

describe("pipeline reset matrix", () => {
  it("script analysis hard-resets downstream stages", () => {
    const state = makeState();
    const nextScenes = [
      {
        id: 1,
        rawText: "Sana opens the hidden vault in the attic.",
        synopsis: "Sana opens the vault.",
        characters: ["Sana"],
        setting: "Attic vault"
      }
    ];
    const reset = resetFromScriptAnalysis(state, "New script", nextScenes);

    expect(reset.step).toBe(AppStep.STYLE_SELECTION);
    expect(reset.maxStepReached).toBe(AppStep.STYLE_SELECTION);
    expect(reset.styleVariants).toEqual([]);
    expect(reset.characters).toEqual([]);
    expect(reset.items).toEqual([]);
    expect(reset.locations).toEqual([]);
    expect(reset.panels).toEqual([]);
    expect(reset.layoutType).toBe("grid");
    expect(reset.lastResetSourceStage).toBe("script_analysis");
    expect(reset.scriptHash).toBeDefined();
    expect(reset.sceneHash).toBeDefined();
    expect(reset.worldHash).toBeUndefined();
  });

  it("style confirm clears world generated images and downstream outputs", () => {
    const state = makeState();
    const selectedStyle: StyleVariant = {
      id: "style-new",
      prompt: "new style",
      category: "New",
      aspectRatio: "4:3",
      resolution: "2K",
      imageId: "style-new-image",
      imageUrl: "https://example.com/style-new.png"
    };

    const reset = resetFromStyleConfirm(state, selectedStyle);

    expect(reset.step).toBe(AppStep.REFERENCE_BUILDER);
    expect(reset.maxStepReached).toBe(AppStep.REFERENCE_BUILDER);
    expect(reset.panels).toEqual([]);
    expect(reset.coverImageId).toBeUndefined();
    expect(reset.layoutType).toBe("grid");
    expect(reset.selectedStyleId).toBe("style-new");
    expect(reset.styleImageId).toBe("style-new-image");
    expect(reset.lastResetSourceStage).toBe("style_confirm");
    expect(reset.characters?.[0].imageId).toBeUndefined();
    expect(reset.items?.[0].imageId).toBeUndefined();
    expect(reset.locations?.[0].imageId).toBeUndefined();
    expect(reset.characters?.[0].referenceImageIds).toEqual(["char-ref-1"]);
    expect(reset.worldHash).toBeDefined();
  });

  it("world confirm clears cover and panel outputs", () => {
    const state = makeState();
    const reset = resetFromWorldConfirm(state);

    expect(reset.step).toBe(AppStep.COVER);
    expect(reset.maxStepReached).toBe(AppStep.COVER);
    expect(reset.coverImageId).toBeUndefined();
    expect(reset.coverTemplateImageId).toBeUndefined();
    expect(reset.panels).toEqual([]);
    expect(reset.panelPlanVersion).toBeUndefined();
    expect(reset.lastResetSourceStage).toBe("world_confirm");
    expect(reset.worldHash).toBeDefined();
  });

  it("layout confirm clears panel plan and generated panels only", () => {
    const state = makeState();
    const reset = resetFromLayoutConfirm(state, "manga", undefined, "manga-template");

    expect(reset.step).toBe(AppStep.COMBINED_PREVIEW);
    expect(reset.maxStepReached).toBe(AppStep.COMBINED_PREVIEW);
    expect(reset.layoutType).toBe("manga");
    expect(reset.gridTemplateId).toBe("manga-template");
    expect(reset.panels).toEqual([]);
    expect(reset.panelPlanVersion).toBeUndefined();
    expect(reset.lastResetSourceStage).toBe("layout_confirm");
  });
});
