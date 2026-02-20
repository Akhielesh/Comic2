import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiClient";
import { generateImage } from "./imageService";
import { GEMINI_IMAGE_MODEL_ID } from "./imageModels";
import { generateFluxImage } from "./fluxService";
import { generateImage as generateGeminiImage } from "./geminiService";

vi.mock("./appSettings", () => ({
  getModelForTask: () => "pixazo/flux-1-schnell"
}));

vi.mock("./db", () => ({
  createSystemNotification: vi.fn(async () => undefined)
}));

vi.mock("./billing", () => ({
  emitBillingSummaryRefresh: vi.fn()
}));

vi.mock("./fluxService", () => ({
  generateFluxImage: vi.fn()
}));

vi.mock("./geminiService", () => ({
  generateImage: vi.fn()
}));

describe("imageService continuity fallback", () => {
  const fluxMock = vi.mocked(generateFluxImage);
  const geminiMock = vi.mocked(generateGeminiImage);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces reference-capable model when continuity-sensitive refs are required", async () => {
    geminiMock.mockResolvedValueOnce({
      imageId: "img-1",
      imageUrl: "https://example.com/1.webp"
    } as any);

    const result = await generateImage(
      "Prompt",
      "1:1",
      "1K",
      ["ref-1"],
      "project-1",
      {
        continuitySensitive: true,
        requiredReferences: true,
        lockedModelId: "pixazo/flux-1-schnell",
        stage: "panel"
      }
    );

    expect(result?.modelId).toBe(GEMINI_IMAGE_MODEL_ID);
    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(fluxMock).not.toHaveBeenCalled();
  });

  it("does not fallback to flux when references are present", async () => {
    geminiMock
      .mockRejectedValueOnce(new ApiError("server", 500))
      .mockResolvedValueOnce({
        imageId: "img-2",
        imageUrl: "https://example.com/2.webp"
      } as any);

    const result = await generateImage(
      "Prompt",
      "1:1",
      "1K",
      ["ref-1"],
      "project-1",
      {
        continuitySensitive: true,
        requiredReferences: true,
        lockedModelId: GEMINI_IMAGE_MODEL_ID,
        stage: "panel"
      }
    );

    expect(result?.fallbackOccurred).toBe(true);
    expect(geminiMock).toHaveBeenCalledTimes(2);
    expect(fluxMock).not.toHaveBeenCalled();
  });
});
