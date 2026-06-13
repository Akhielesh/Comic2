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
});
