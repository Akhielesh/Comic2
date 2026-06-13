import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StyleSelection } from "./StyleSelection";
import type { Scene, StyleVariant } from "../../types";

const firstScene: Scene = {
  id: 1,
  rawText: "Maya finds a glowing door in the attic.",
  synopsis: "Maya discovers a glowing attic door.",
  characters: ["Maya"],
  setting: "Dusty attic"
};

const generatedVariant: StyleVariant = {
  id: "style-1",
  styleId: "ligne-claire",
  imageId: "image-1",
  imageUrl: "data:image/png;base64,AA==",
  prompt: "clean line art",
  category: "Ligne Claire",
  aspectRatio: "1:1",
  resolution: "1K"
};

const renderStyleSelection = (
  overrides: Partial<React.ComponentProps<typeof StyleSelection>> = {}
) => {
  const onStyleConfirmed = vi.fn();
  const props: React.ComponentProps<typeof StyleSelection> = {
    firstScene,
    script: "Maya finds a glowing door in the attic.",
    projectId: "project-1",
    initialVariants: [generatedVariant],
    selectedStyleId: undefined,
    onScenesGenerated: vi.fn(),
    onStyleConfirmed,
    onVariantsChange: vi.fn(),
    ...overrides
  };

  render(<StyleSelection {...props} />);
  return { onStyleConfirmed };
};

describe("StyleSelection autopilot", () => {
  it("auto-confirms the first generated style only when auto-spend is enabled", async () => {
    const { onStyleConfirmed } = renderStyleSelection({
      agentSettings: {
        confirmPolicy: "never",
        outputTargets: ["comic", "book", "html"],
        autoPageCount: true
      }
    });

    await waitFor(() => {
      expect(onStyleConfirmed).toHaveBeenCalledWith(generatedVariant);
    });
  });

  it("does not auto-confirm generated styles in the default guided mode", async () => {
    const { onStyleConfirmed } = renderStyleSelection({
      agentSettings: {
        confirmPolicy: "big_spends",
        outputTargets: ["comic", "book", "html"],
        autoPageCount: true
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onStyleConfirmed).not.toHaveBeenCalled();
  });
});
