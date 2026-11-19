// Guided View's camera numbers (reader.md §5), shared so every surface that judges how big a panel reads uses the same
// ones: components/comicstudio/immersive/guidedModel.ts frames panels with them, and the free review
// (review/rules.ts readPxPerPageWidth) reads them to judge text size on a phone. Constants only: no imports.

/** Padding around a framed panel, a fraction of the panel on each side. */
export const GUIDED_PAD = 0.05;

/** The largest zoom over the page fitted to the view. */
export const GUIDED_MAX_ZOOM = 4;
