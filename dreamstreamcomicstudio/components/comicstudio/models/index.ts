// Client feature module: the image-model picker, lock line and change confirm (models.md §3.6–§3.7, owner
// M1-PICKER-UI) and the admin-only Model Lab (M1-MODEL-LAB, under ./lab/**, registered as an admin section).
// Registered in ../features.ts by the lead. The hotspot files never import from here directly — everything reaches
// them through the FeatureModule registries:
//   - header slot `model-picker` at the banner tier (order 1010, under the header): ModelPickerHost renders
//     nothing in place; it answers every `open_model_picker` request (useStudio raises them for chips, the
//     reliability outage card and banner; the QualityPanel lock line and the Cost card raise them directly) with
//     the picker sheet, and a pick with the change confirm (C/D) — the only way a comic's model changes.
//
// Exports for other packages: LockLine (the Cost card's "Next pages draw on" row — M1-INSIGHTS-UI),
// ModelDetailSheet (the Models tab's L3 sheet), requestOpenModelPicker, and the copy for server-side twins.

import type { FeatureModule } from '../extensions';
import { MODEL_PICKER_SLOT_ORDER, ModelPickerHost } from './ModelPickerHost';

// One `feature` object for the whole folder. M1-MODEL-LAB's admin section joins THIS object
// (`adminSections: [labAdminSection]`, imported from './lab') — never a second `feature` export.
export const feature: FeatureModule = {
  headerSlots: [{ id: 'model-picker', order: MODEL_PICKER_SLOT_ORDER, Component: ModelPickerHost }]
};

export { ModelPickerHost, MODEL_PICKER_SLOT_ORDER } from './ModelPickerHost';
export { ModelPicker, ModelPickerPanel } from './ModelPicker';
export type { ModelPickerProps, ModelPickerPanelProps } from './ModelPicker';
export { ModelRow } from './ModelRow';
export { ModelChangeConfirm } from './ModelChangeConfirm';
export type { ModelChangeConfirmProps } from './ModelChangeConfirm';
export { ModelDetailSheet, ModelDetailView } from './ModelDetailSheet';
export type { ModelDetailSheetProps, ModelDetailViewProps } from './ModelDetailSheet';
export { LockLine } from './LockLine';
export type { LockLineProps } from './LockLine';
export { TierChangeConfirm } from './TierChangeConfirm';
export { OPEN_MODEL_PICKER_EVENT, requestOpenModelPicker, suggestionOf, useModelPickerRequests } from './openPicker';
export { useModelCatalog, useModelDetail, loadModelCatalog, seedModelCatalog, CATALOG_FRESH_MS } from './useModelCatalog';
export { fetchModelCatalog, fetchModelDetail, asCatalogRow, asCatalogDetail, registryCatalogRows, MODEL_CATALOG_PATH } from './modelsApi';
export { clientPriceBook } from './priceBook';
export type { ClientPriceBook, ClientQuote } from './priceBook';
export { buildPickerRows, sortPickerRows, easyPickerRows, listedPickerRows, isListedRow, currentModelId, isLocked, EASY_MAX_ROWS, REMOVED_FROM_PICKER } from './pickerRows';
export type { PickerRowModel, PickerSort } from './pickerRows';
export * as modelCopy from './copy';
