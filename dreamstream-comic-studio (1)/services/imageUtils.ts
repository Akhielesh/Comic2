import { AspectRatio, ComicState } from "../types";

const SUPPORTED_ASPECT_RATIOS: AspectRatio[] = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9"
];

export const parseRatio = (ratio: string): number | null => {
  const parts = ratio.split(":").map((p) => Number(p.trim()));
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1]) || parts[0] <= 0 || parts[1] <= 0) {
    return null;
  }
  return parts[0] / parts[1];
};

export const getNearestAspectRatio = (ratio: string): AspectRatio => {
  const target = parseRatio(ratio);
  if (!target) return "1:1";
  let closest = SUPPORTED_ASPECT_RATIOS[0];
  let smallestDelta = Infinity;
  SUPPORTED_ASPECT_RATIOS.forEach((candidate) => {
    const value = parseRatio(candidate) || 1;
    const delta = Math.abs(value - target);
    if (delta < smallestDelta) {
      smallestDelta = delta;
      closest = candidate;
    }
  });
  return closest;
};

export const resolveAspectRatio = (
  state: ComicState,
  fallback: AspectRatio
): { modelRatio: AspectRatio; cropRatio?: string } => {
  if (state.customAspectRatioEnabled && state.customAspectRatio) {
    const parsed = parseRatio(state.customAspectRatio);
    if (parsed) {
      return {
        modelRatio: getNearestAspectRatio(state.customAspectRatio),
        cropRatio: state.customAspectRatio
      };
    }
  }
  return { modelRatio: fallback };
};

export const cropImageToRatio = async (dataUrl: string, targetRatio: string): Promise<string> => {
  if (typeof window === "undefined") return dataUrl;
  const ratio = parseRatio(targetRatio);
  if (!ratio) return dataUrl;

  const image = new Image();
  image.crossOrigin = "anonymous";

  const loadImage = () =>
    new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to load image for crop."));
    });

  image.src = dataUrl;
  await loadImage();

  const imgRatio = image.width / image.height;
  if (Math.abs(imgRatio - ratio) < 0.01) return dataUrl;

  let cropWidth = image.width;
  let cropHeight = image.height;

  if (imgRatio > ratio) {
    cropWidth = Math.round(image.height * ratio);
  } else {
    cropHeight = Math.round(image.width / ratio);
  }

  const sx = Math.round((image.width - cropWidth) / 2);
  const sy = Math.round((image.height - cropHeight) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(image, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return canvas.toDataURL("image/png");
};

export const formatRatio = (ratio?: string) => {
  if (!ratio) return "";
  const parsed = parseRatio(ratio);
  if (!parsed) return ratio;
  const [w, h] = ratio.split(":");
  return `${w.trim()}:${h.trim()}`;
};
