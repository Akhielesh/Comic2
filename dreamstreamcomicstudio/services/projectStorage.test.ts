import { describe, expect, it } from "vitest";
import { Project } from "../types";
import {
  MAX_IMAGE_HISTORY,
  appendCappedHistory,
  prependCappedHistory,
  sanitizeProjectForStorage,
} from "./projectStorage";
import { AGENT_EVENT_LIMIT, makeDefaultComicAgentRun } from "./comicAgentRun";

const buildProject = (): Project => ({
  id: "project-1",
  name: "Storage Test",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  state: {
    step: 7,
    maxStepReached: 7,
    flowVersion: 3,
    script: "test",
    scenes: [],
    continuitySummary: "",
    overview: "overview",
    comments: [],
    isFeatured: false,
    coverImageId: "cover-id",
    coverImageUrl: "https://cdn.example/cover.webp",
    coverPrompt: "",
    coverTemplateId: "template",
    coverTemplateImageId: "template-image-id",
    coverTemplateImageUrl: "https://cdn.example/template.webp",
    styleVariants: [{
      id: "variant-1",
      imageId: "variant-image",
      imageUrl: "https://cdn.example/variant.webp",
      prompt: "p",
      category: "c",
      aspectRatio: "1:1",
      resolution: "1K"
    }],
    selectedStyleId: "variant-1",
    stylePrompt: "",
    styleCategory: "",
    styleAspectRatio: "1:1",
    customAspectRatioEnabled: false,
    customAspectRatio: undefined,
    imageResolution: "1K",
    characters: [{
      id: "character-1",
      name: "Hero",
      bio: "bio",
      description: "desc",
      imageId: "character-image",
      imageUrl: "https://cdn.example/character.webp",
      referenceImageIds: ["ref-1"]
    }],
    items: [{
      id: "item-1",
      name: "Item",
      description: "desc",
      imageId: "item-image",
      imageUrl: "https://cdn.example/item.webp",
      referenceImageIds: ["item-ref-1"]
    }],
    locations: [{
      id: "location-1",
      name: "Location",
      description: "desc",
      imageId: "location-image",
      imageUrl: "https://cdn.example/location.webp",
      referenceImageIds: ["location-ref-1"]
    }],
    layoutType: "grid",
    customLayoutPrompt: undefined,
    panels: [{
      id: "panel-1",
      sceneId: 1,
      description: "desc",
      dialogue: "dialogue",
      imageId: "panel-image",
      imageUrl: "https://cdn.example/panel.webp",
      imageIdHistory: ["panel-image-1", "panel-image-2"],
      imageUrlHistory: ["https://cdn.example/panel1.webp", "https://cdn.example/panel2.webp"]
    }],
    pageStudio: {
      brief: "A one-page comic.",
      style: { source: "text", prompt: "clean ink" },
      layout: { source: "auto" },
      aspectRatio: "3:4",
      resolution: "2K",
      activePageId: "page-1",
      stage: "edit",
      pages: [{
        id: "page-1",
        prompt: "Generate a complete page.",
        imageId: "page-current-image",
        imageUrl: "https://cdn.example/page-current.webp",
        baseImageId: "page-base-image",
        baseImageUrl: "https://cdn.example/page-base.webp",
        createdAt: Date.now(),
        edits: [{
          id: "edit-1",
          instruction: "make the sky brighter",
          imageId: "page-edit-image",
          imageUrl: "https://cdn.example/page-edit.webp",
          createdAt: Date.now()
        }]
      }]
    },
    textLayout: "caption",
    pricingConfig: {
      currency: "USD",
      models: {}
    },
    imageTags: {},
    imageTagCounters: {}
  }
});

describe("projectStorage", () => {
  it("sanitizes transient urls before persistence", () => {
    const original = buildProject();
    const sanitized = sanitizeProjectForStorage(original);

    expect(sanitized.state.coverImageId).toBe("cover-id");
    expect((sanitized.state as any).coverImageUrl).toBeUndefined();
    expect((sanitized.state as any).coverTemplateImageUrl).toBeUndefined();
    expect((sanitized.state.characters[0] as any).imageUrl).toBeUndefined();
    expect((sanitized.state.items[0] as any).imageUrl).toBeUndefined();
    expect((sanitized.state.locations[0] as any).imageUrl).toBeUndefined();
    expect((sanitized.state.styleVariants[0] as any).imageUrl).toBeUndefined();
    expect((sanitized.state.panels[0] as any).imageUrl).toBeUndefined();
    expect((sanitized.state.panels[0] as any).imageUrlHistory).toBeUndefined();
    expect((sanitized.state.pageStudio?.pages[0] as any).imageUrl).toBeUndefined();
    expect((sanitized.state.pageStudio?.pages[0] as any).baseImageUrl).toBeUndefined();
    expect((sanitized.state.pageStudio?.pages[0].edits[0] as any).imageUrl).toBeUndefined();
    expect(sanitized.state.pageStudio?.pages[0].imageId).toBe("page-current-image");
    expect(sanitized.state.pageStudio?.pages[0].baseImageId).toBe("page-base-image");
    expect(sanitized.state.pageStudio?.pages[0].edits[0].imageId).toBe("page-edit-image");
    expect(original.state.panels[0].imageUrl).toBeDefined();
    expect(original.state.pageStudio?.pages[0].imageUrl).toBeDefined();
  });

  it("caps prepended image history", () => {
    const longHistory = Array.from({ length: 20 }).map((_, i) => `image-${i}`);
    const next = prependCappedHistory(longHistory, "new-image");
    expect(next.length).toBe(MAX_IMAGE_HISTORY);
    expect(next[0]).toBe("new-image");
  });

  it("caps appended image history", () => {
    const longHistory = Array.from({ length: 20 }).map((_, i) => `image-${i}`);
    const next = appendCappedHistory(longHistory, "new-image");
    expect(next.length).toBe(MAX_IMAGE_HISTORY);
    expect(next[next.length - 1]).toBe("new-image");
  });

  it("caps persisted agent events without stripping the durable run", () => {
    const project = buildProject();
    project.state.agentRun = {
      ...makeDefaultComicAgentRun(),
      events: Array.from({ length: AGENT_EVENT_LIMIT + 5 }).map((_, index) => ({
        id: `event-${index}`,
        kind: "build",
        status: "info",
        message: `event-${index}`,
        timestamp: index + 1
      }))
    };

    const sanitized = sanitizeProjectForStorage(project);

    expect(sanitized.state.agentRun?.events).toHaveLength(AGENT_EVENT_LIMIT);
    expect(sanitized.state.agentRun?.events[0].message).toBe("event-5");
    expect(sanitized.state.agentRun?.cards.length).toBeGreaterThan(0);
  });
});
