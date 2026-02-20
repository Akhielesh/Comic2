import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../types";
import { ComicReader } from "./ComicReader";

vi.mock("./layout/StaticSiteHeader", () => ({
  StaticSiteHeader: () => <div data-testid="static-header" />
}));

vi.mock("./layout/LegalMicroLinks", () => ({
  LegalMicroLinks: () => <div data-testid="legal-links" />
}));

vi.mock("./PanelDialogue", () => ({
  PanelDialogue: () => <div data-testid="panel-dialogue" />
}));

vi.mock("./CommentSection", () => ({
  CommentSection: () => <div data-testid="comments" />
}));

vi.mock("./modals/ReviewModal", () => ({
  ReviewModal: () => null
}));

vi.mock("../services/db", () => ({
  loadReaderState: vi.fn(async () => null),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));

vi.mock("../contexts/AuthContext", () => ({
  useAuth: () => ({ user: null })
}));

const makeProject = (): Project => ({
  id: "project-1",
  name: "Reader Test",
  createdAt: Date.now(),
  updatedAt: Date.now(),
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
    panels: [
      {
        id: "panel-1",
        sceneId: 1,
        description: "A missing art panel",
        dialogue: "Caption",
        imageIdHistory: []
      }
    ]
  }
});

describe("ComicReader missing image handling", () => {
  it("renders missing image card and never outputs empty img src", () => {
    render(
      <ComicReader
        project={makeProject()}
        onClose={() => undefined}
        onUpdateProject={() => undefined}
        onOpenPrivacy={() => undefined}
        onOpenTerms={() => undefined}
        onOpenFaq={() => undefined}
      />
    );

    expect(screen.getByText("Image missing for this panel")).toBeInTheDocument();
    const emptySrcImages = Array.from(document.querySelectorAll("img")).filter(
      (img) => img.getAttribute("src") === ""
    );
    expect(emptySrcImages.length).toBe(0);
  });
});
