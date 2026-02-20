import { describe, expect, it } from "vitest";
import type { ComicState, StyleVariant } from "../types";
import { applyStyleLockResolution, resolveStyleLock } from "./styleLock";

const makeState = (variants: StyleVariant[], selectedStyleId?: string): ComicState => ({
  step: 0,
  maxStepReached: 0,
  script: "",
  scenes: [],
  styleVariants: variants,
  selectedStyleId,
  stylePrompt: "",
  styleImageId: undefined,
  styleImageUrl: undefined,
  styleCategory: "",
  styleAspectRatio: "1:1",
  imageResolution: "1K",
  characters: [],
  items: [],
  locations: [],
  layoutType: "grid",
  panels: []
});

describe("resolveStyleLock", () => {
  it("prefers selected variant when it has an image", () => {
    const variants: StyleVariant[] = [
      { id: "a", prompt: "A", category: "x", aspectRatio: "1:1", resolution: "1K", imageId: "img-a", generatedAt: 10 },
      { id: "b", prompt: "B", category: "x", aspectRatio: "1:1", resolution: "1K", imageId: "img-b", generatedAt: 20 }
    ];

    const result = resolveStyleLock(makeState(variants, "a"));
    expect(result.resolved).toBe(true);
    expect(result.source).toBe("selected");
    expect(result.styleImageId).toBe("img-a");
  });

  it("falls back to latest generated variant with image", () => {
    const variants: StyleVariant[] = [
      { id: "a", prompt: "A", category: "x", aspectRatio: "1:1", resolution: "1K", imageId: "img-a", generatedAt: 10 },
      { id: "b", prompt: "B", category: "x", aspectRatio: "1:1", resolution: "1K", imageId: "img-b", generatedAt: 50 }
    ];

    const result = resolveStyleLock(makeState(variants, "missing"));
    expect(result.resolved).toBe(true);
    expect(result.source).toBe("latest_generated");
    expect(result.selectedStyleId).toBe("b");
  });

  it("falls back to first imaged variant when generatedAt is missing", () => {
    const variants: StyleVariant[] = [
      { id: "a", prompt: "A", category: "x", aspectRatio: "1:1", resolution: "1K", imageId: "img-a" },
      { id: "b", prompt: "B", category: "x", aspectRatio: "1:1", resolution: "1K" }
    ];

    const result = resolveStyleLock(makeState(variants, "missing"));
    expect(result.resolved).toBe(true);
    expect(result.source).toBe("first_generated");
    expect(result.selectedStyleId).toBe("a");
  });

  it("returns unresolved when no variant has an image", () => {
    const variants: StyleVariant[] = [
      { id: "a", prompt: "A", category: "x", aspectRatio: "1:1", resolution: "1K" }
    ];
    const result = resolveStyleLock(makeState(variants, "a"));
    expect(result.resolved).toBe(false);
    expect(result.source).toBe("unresolved");
  });
});

describe("applyStyleLockResolution", () => {
  it("backfills style lock fields into comic state", () => {
    const variants: StyleVariant[] = [
      { id: "v1", prompt: "Painterly", category: "fantasy", aspectRatio: "4:5", resolution: "2K", imageId: "style-1", generatedAt: 100 }
    ];
    const state = makeState(variants);

    const result = applyStyleLockResolution(state, 1234);
    expect(result.resolution.resolved).toBe(true);
    expect(result.state.selectedStyleId).toBe("v1");
    expect(result.state.stylePrompt).toBe("Painterly");
    expect(result.state.styleImageId).toBe("style-1");
    expect(result.state.styleLockStatus).toBe("resolved");
    expect(result.state.styleLockResolvedAt).toBe(1234);
    expect(result.changed).toBe(true);
  });
});
