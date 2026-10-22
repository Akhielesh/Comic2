// Client feature module: the mobile/tablet/foldable shell (header slots: Easy/Pro mode, savings).
// Owner: P1-SHELL. Registered through ../features.ts (contract §13.2).
//
// The shell itself (layouts, tab bar, rail, pane switcher, sheets, touch canvas) is imported
// directly by ComicStudio.tsx and the editors; this module only contributes header slots and
// re-exports the public surface for other features.

import type { FeatureModule } from '../extensions';
import { HEADER_SLOT_ORDER } from './headerSlots';
import { ModeToggleSlot } from './ModeToggle';
import { SavingsChipSlot } from './SavingsChip';

export const feature: FeatureModule = {
  headerSlots: [
    { id: 'mode', order: HEADER_SLOT_ORDER.mode, Component: ModeToggleSlot },
    { id: 'savings', order: HEADER_SLOT_ORDER.savings, Component: SavingsChipSlot }
  ]
};

export { HEADER_BANNER_MIN_ORDER, HEADER_SLOT_ORDER } from './headerSlots';
export * from './formFactor';
export { useFormFactor, readFormFactor, FormFactorProvider, formFactorFor, resetFormFactorStore } from './useFormFactor';
export { useKeyboardInset, computeKeyboardInset, KB_OPEN_THRESHOLD, type KeyboardInset } from './useKeyboardInset';
export { useBackLayer, pushLayer, popLayer, openLayers } from './backStack';
export { useThemeColor } from './useThemeColor';
export { ModeToggle, MODE_HINT } from './ModeToggle';
export { SavingsChip, SavingsBreakdown, SAVINGS_COPY, savedTotal, savedEntries } from './SavingsChip';
export { AdaptiveSheet, type AdaptiveSheetProps } from './sheets/AdaptiveSheet';
export { BottomSheet, type BottomSheetProps } from './sheets/BottomSheet';
export { SideSheet, type SideSheetProps } from './sheets/SideSheet';
export { resolvePresentation, snapDetent, detentHeights, type SheetDetent, type SheetPresentation } from './sheets/snap';
export { TouchCanvas, ZoomContext, useZoom, type TouchCanvasProps, type ZoomState } from './touch/TouchCanvas';
export { GestureArbiterProvider, GestureArbiterContext, useGestureArbiter, createGestureArbiter, type GestureArbiterApi } from './touch/GestureArbiter';
export { useLongPress, type LongPressInfo } from './touch/useLongPress';
export { ContextMenuSheet, type ContextMenuItem } from './touch/ContextMenuSheet';
export * as pointerPolicy from './touch/pointerPolicy';
export * as gestureMath from './touch/gestureMath';
export { srcSetFor, variantWidthFor, pickVariant, heavyImageAttr, VARIANT_THUMB_W, VARIANT_SCREEN_W } from './media/imageVariants';
export { useImageBudget, imageBudget, releasePlan } from './media/imageBudget';
