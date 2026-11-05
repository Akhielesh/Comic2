/**
 * The mobile sheets, re-exported as design-system primitives. They stay where they live
 * (components/comicstudio/mobile/sheets: BottomSheet with detents and the iOS-style drag, SideSheet,
 * AdaptiveSheet choosing popover / bottom / side by the room it has) — richer than Atlas's own sheet —
 * and are layered at the documented Z.scrim / Z.sheet steps (85 / 86).
 *
 * Import them from here (`components/ds/sheet`), not from the `components/ds` barrel: the sheets bring
 * the back-stack and form-factor hooks, so the barrel stays light for screens that only need controls.
 */
export { BottomSheet, type BottomSheetProps } from '../comicstudio/mobile/sheets/BottomSheet';
export { SideSheet, type SideSheetProps } from '../comicstudio/mobile/sheets/SideSheet';
export {
  AdaptiveSheet,
  detentHeights,
  resolvePresentation,
  snapDetent,
  type AdaptiveSheetProps,
  type SheetDetent,
  type SheetPresentation
} from '../comicstudio/mobile/sheets/AdaptiveSheet';
