// Classic reader preloading (reader.md §8.8, RD-7; PROGRAM3 B17): scroll mode used to preload EVERY image up
// front (37 for a 36-panel comic with a cover), defeating the lazy <img>s. It now warms only the next 3 images
// after the one in view; flip mode keeps its −1 / +3 window.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types";
import { ComicReader } from "./ComicReader";

vi.mock("./layout/StaticSiteHeader", () => ({ StaticSiteHeader: () => <div data-testid="static-header" /> }));
vi.mock("./layout/LegalMicroLinks", () => ({ LegalMicroLinks: () => <div data-testid="legal-links" /> }));
vi.mock("./PanelDialogue", () => ({ PanelDialogue: () => <div data-testid="panel-dialogue" /> }));
vi.mock("./CommentSection", () => ({ CommentSection: () => <div data-testid="comments" /> }));
vi.mock("./modals/ReviewModal", () => ({ ReviewModal: () => null }));
vi.mock("../services/db", () => ({
  loadReaderState: vi.fn(async () => null),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));
vi.mock("../contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));

const PANELS = 36;
const project = (): Project => ({
  id: "project-36",
  name: "Thirty-six panels",
  createdAt: 0,
  updatedAt: 0,
  state: {
    step: 0,
    maxStepReached: 0,
    script: "",
    scenes: [],
    styleVariants: [],
    stylePrompt: "",
    styleCategory: "",
    styleAspectRatio: "1:1",
    imageResolution: "1K",
    characters: [],
    items: [],
    locations: [],
    layoutType: "grid",
    coverImageUrl: "https://cdn.test/cover.png",
    panels: Array.from({ length: PANELS }, (_, i) => ({
      id: `panel-${i + 1}`,
      sceneId: 1,
      description: `Panel ${i + 1}`,
      dialogue: "",
      imageUrl: `https://cdn.test/panel-${i + 1}.png`,
      imageIdHistory: []
    }))
  }
} as unknown as Project);

/** Every `new Image()` preload, by the URL it was given. */
let preloads: string[] = [];
const RealImage = globalThis.Image;
beforeEach(() => {
  preloads = [];
  class CountingImage {
    set src(v: string) {
      preloads.push(v);
    }
  }
  vi.stubGlobal("Image", CountingImage);
});
afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.Image = RealImage;
});

const mount = () =>
  render(
    <ComicReader
      project={project()}
      onClose={() => undefined}
      onUpdateProject={() => undefined}
      onOpenPrivacy={() => undefined}
      onOpenTerms={() => undefined}
      onOpenFaq={() => undefined}
    />
  );

describe("classic reader preloading", () => {
  it("scroll mode makes at most 4 preloads for a 36-panel comic (it made 37), and they are the images right after the first", () => {
    mount();
    expect(preloads.length).toBeLessThanOrEqual(4);
    expect(preloads.length).toBeGreaterThan(0);
    expect(preloads).toEqual(["https://cdn.test/panel-1.png", "https://cdn.test/panel-2.png", "https://cdn.test/panel-3.png"]);
    // The scroll list still renders every panel lazily (the browser fetches what comes into view).
    const lazy = Array.from(document.querySelectorAll('img[loading="lazy"]'));
    expect(lazy.length).toBe(PANELS);
  });

  it("flip mode keeps its window: the page before and the 3 after", () => {
    mount();
    preloads = [];
    fireEvent.click(screen.getAllByRole("button", { name: /Page Flip/i })[0]);
    expect(preloads.length).toBeLessThanOrEqual(4);
    expect(preloads).toEqual(expect.arrayContaining(["https://cdn.test/panel-1.png"]));
  });
});
