// Units for the inspector's typed position and size (master plan §2.4: "% of the page by default; mm/in once a print
// trim is set"). Every exported page is lettered on the US comic trim the PDF uses (export/pdfExport.ts
// COMIC_TRIM_WIDTH_PT = 6.625 in wide; its height follows the page's aspect), so mm and in are always real numbers on
// paper. Kept here, not imported from the export chunk, so the editor never loads the PDF code; a test pins the two.

/** A length unit the inspector shows. */
export type LengthUnit = '%' | 'mm' | 'in';
export const LENGTH_UNITS: readonly LengthUnit[] = ['%', 'mm', 'in'];

/** The printed page width (in): COMIC_TRIM_WIDTH_PT / 72. */
export const TRIM_WIDTH_IN = 6.625;
const MM_PER_IN = 25.4;

/** Page fraction × this = the shown length, along the page's width (x) or height (y), for a page of `aspect` (w / h). */
export const unitScale = (unit: LengthUnit, axis: 'x' | 'y', aspect: number): number => {
  if (unit === '%') return 100;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 2 / 3;
  const inches = axis === 'x' ? TRIM_WIDTH_IN : TRIM_WIDTH_IN / a;
  return unit === 'in' ? inches : inches * MM_PER_IN;
};

/** The typed field's step and decimals for a unit. */
export const unitStep = (unit: LengthUnit): { step: number; decimals: number } =>
  unit === 'in' ? { step: 0.05, decimals: 2 } : { step: 0.5, decimals: 1 };

/** Where the inspector remembers the viewer's unit (this device only; try/catch: private windows refuse storage). */
export const UNITS_KEY = 'comicstudio.inspector.units';

export const readUnits = (): LengthUnit => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(UNITS_KEY) : null;
    return (LENGTH_UNITS as readonly string[]).includes(v ?? '') ? (v as LengthUnit) : '%';
  } catch {
    return '%';
  }
};

export const writeUnits = (unit: LengthUnit): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(UNITS_KEY, unit);
  } catch {
    /* storage refused: the choice lasts this session only */
  }
};
