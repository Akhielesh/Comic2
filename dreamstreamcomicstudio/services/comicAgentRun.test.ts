import { describe, expect, it } from "vitest";
import { AppStep, ComicState } from "../types";
import {
  AGENT_EVENT_LIMIT,
  appendAgentEvent,
  makeDefaultComicAgentRun,
  syncAgentRunWithState,
  transitionAgentRun
} from "./comicAgentRun";

const makeState = (overrides: Partial<ComicState> = {}): ComicState => ({
  step: AppStep.SCRIPT_INPUT,
  maxStepReached: AppStep.SCRIPT_INPUT,
  flowVersion: 4,
  script: "A child finds a hidden door.",
  scenes: [],
  continuitySummary: "",
  overview: "",
  comments: [],
  isFeatured: false,
  coverPrompt: "",
  styleVariants: [],
  selectedStyleId: undefined,
  stylePrompt: "",
  styleCategory: "",
  styleAspectRatio: "1:1",
  customAspectRatioEnabled: false,
  customAspectRatio: undefined,
  imageResolution: "1K",
  characters: [],
  items: [],
  locations: [],
  layoutType: "grid",
  customLayoutPrompt: undefined,
  panels: [],
  ...overrides
});

describe("comicAgentRun", () => {
  it("syncs cards from a partially completed comic state", () => {
    const state = makeState({
      step: AppStep.LAYOUT_SELECTION,
      maxStepReached: AppStep.LAYOUT_SELECTION,
      scenes: [{ id: 1, rawText: "Door opens.", synopsis: "Door opens.", characters: ["Maya"], setting: "Attic" }],
      selectedStyleId: "style-1",
      stylePrompt: "clean comic line art",
      characters: [{
        id: "char-1",
        name: "Maya",
        bio: "Curious child",
        description: "Curious child in a yellow jacket",
        referenceImageIds: []
      }],
      coverImageId: "cover-1",
      pageCount: 4
    });

    const run = syncAgentRunWithState(state);

    expect(run.activeCard).toBe("layout");
    expect(run.cards.find((card) => card.kind === "prompt")?.status).toBe("done");
    expect(run.cards.find((card) => card.kind === "style")?.status).toBe("done");
    expect(run.cards.find((card) => card.kind === "cover")?.status).toBe("done");
    expect(run.cards.find((card) => card.kind === "layout")?.status).toBe("active");
    expect(run.cards.find((card) => card.kind === "build")?.status).toBe("pending");
  });

  it("records explicit transitions without dropping earlier cards", () => {
    const state = makeState({ agentRun: makeDefaultComicAgentRun() });

    const run = transitionAgentRun(
      state,
      [
        { kind: "prompt", status: "done", summary: "1 scene analyzed.", progress: 100 },
        { kind: "style", status: "active", summary: "Pick a style." }
      ],
      { kind: "prompt", status: "info", message: "Analyzed the story." }
    );

    expect(run.activeCard).toBe("style");
    expect(run.cards.find((card) => card.kind === "prompt")?.summary).toBe("1 scene analyzed.");
    expect(run.cards.find((card) => card.kind === "style")?.status).toBe("active");
    expect(run.events.at(-1)?.message).toBe("Analyzed the story.");
  });

  it("caps persisted events", () => {
    let run = makeDefaultComicAgentRun();
    for (let index = 0; index < AGENT_EVENT_LIMIT + 10; index += 1) {
      run = appendAgentEvent(run, {
        kind: "build",
        status: "info",
        message: `event-${index}`,
        timestamp: index + 1
      });
    }

    expect(run.events).toHaveLength(AGENT_EVENT_LIMIT);
    expect(run.events[0].message).toBe("event-10");
    expect(run.events.at(-1)?.message).toBe(`event-${AGENT_EVENT_LIMIT + 9}`);
  });

  it("keeps the build card active while a run is still rendering", () => {
    const state = makeState({
      step: AppStep.FULL_GENERATION,
      maxStepReached: AppStep.FULL_GENERATION,
      panels: [{
        id: "panel-1",
        sceneId: 1,
        description: "Maya opens the door.",
        dialogue: "",
        imageId: "image-1",
        imageUrl: "https://example.com/panel.png",
        imageIdHistory: ["image-1"]
      }],
      generationStatus: {
        isActive: true,
        progress: 25,
        startTime: 1,
        estimatedTimeRemaining: "1m 00s",
        currentStepDescription: "Scene 1 — panels 1–4 of 12",
        logs: [],
        completedPanels: 1,
        totalPanels: 12
      }
    });

    const run = syncAgentRunWithState(state);

    // First panel has rendered, but the run is still active — the build card must not
    // claim "done" while it is mid-render.
    expect(run.cards.find((card) => card.kind === "build")?.status).toBe("active");
    expect(run.cards.find((card) => card.kind === "build")?.summary).toBe("1 of 12 panels rendered.");
  });

  it("summarizes prepared review outputs on the export card", () => {
    const state = makeState({
      step: AppStep.REVIEW_EXPORT,
      maxStepReached: AppStep.REVIEW_EXPORT,
      panels: [{
        id: "panel-1",
        sceneId: 1,
        description: "Maya opens the door.",
        dialogue: "",
        imageId: "image-1",
        imageUrl: "https://example.com/panel.png",
        imageIdHistory: ["image-1"]
      }],
      exportedOutputs: {
        html: 123,
        book: 456
      }
    });

    const run = syncAgentRunWithState(state);

    expect(run.cards.find((card) => card.kind === "build")?.status).toBe("done");
    expect(run.cards.find((card) => card.kind === "export")?.summary).toBe("2 outputs prepared from review.");
  });

  it("completes the export card once every selected output target is delivered", () => {
    const state = makeState({
      step: AppStep.REVIEW_EXPORT,
      maxStepReached: AppStep.REVIEW_EXPORT,
      panels: [{
        id: "panel-1",
        sceneId: 1,
        description: "Maya opens the door.",
        dialogue: "",
        imageId: "image-1",
        imageUrl: "https://example.com/panel.png",
        imageIdHistory: ["image-1"]
      }],
      agentSettings: {
        confirmPolicy: "big_spends",
        outputTargets: ["comic", "html"],
        autoPageCount: true,
        updatedAt: 1
      },
      exportedOutputs: { comic: 111, html: 222 }
    });

    const run = syncAgentRunWithState(state);

    expect(run.cards.find((card) => card.kind === "export")?.status).toBe("done");
    expect(run.status).toBe("done");
  });

  it("leaves the export card active when a selected output target is still missing", () => {
    const state = makeState({
      step: AppStep.REVIEW_EXPORT,
      maxStepReached: AppStep.REVIEW_EXPORT,
      panels: [{
        id: "panel-1",
        sceneId: 1,
        description: "Maya opens the door.",
        dialogue: "",
        imageId: "image-1",
        imageUrl: "https://example.com/panel.png",
        imageIdHistory: ["image-1"]
      }],
      agentSettings: {
        confirmPolicy: "big_spends",
        outputTargets: ["comic", "book", "html"],
        autoPageCount: true,
        updatedAt: 1
      },
      exportedOutputs: { comic: 111, html: 222 }
    });

    const run = syncAgentRunWithState(state);

    expect(run.cards.find((card) => card.kind === "export")?.status).toBe("active");
  });

  it("does not crash deriving the layout summary when layoutType is missing", () => {
    const state = makeState({
      step: AppStep.LAYOUT_SELECTION,
      maxStepReached: AppStep.LAYOUT_SELECTION,
      pageCount: 3,
      layoutType: undefined as unknown as ComicState["layoutType"]
    });

    const run = syncAgentRunWithState(state);

    expect(run.cards.find((card) => card.kind === "layout")?.summary).toBe("3 pages planned with grid layout.");
  });
});
