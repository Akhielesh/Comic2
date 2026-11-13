// Where quality lives on screen (PROGRAM3 D22, declutter F2, DC-1 #3 / lead D10). One leaf module, so the studio
// header (ComicStudio) and the composer (conversation/StudioComposer) read the same cut without importing each other.

/**
 * The header's quality chip shows only below this width: from here the composer's quality chip is on screen beside it,
 * the same setting twice. Phones keep their ⋯ Quality row.
 */
export const HEADER_QUALITY_CHIP_BELOW = 1024;

/** The header draws its quality chip (tablets below 1024 px). */
export const headerShowsQualityChip = (phone: boolean, width: number): boolean => !phone && width < HEADER_QUALITY_CHIP_BELOW;

/**
 * The composer's quality chip is quality's on-screen home (from 1024 px, not on phones): it never hides, whatever width
 * the composer gets, and it leads the chip row so the row's scroller cannot clip it.
 */
export const composerIsQualityHome = (phone: boolean, width: number): boolean => !phone && width >= HEADER_QUALITY_CHIP_BELOW;
