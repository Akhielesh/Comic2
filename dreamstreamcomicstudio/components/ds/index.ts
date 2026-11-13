/**
 * DreamStream design-system primitives (docs/design/design-system.md): Atlas's ui-generated recipes on
 * the `--ds-*` tokens and the studioDesign recipes. The overlays (DS-1c) are Radix: an unused one tree-shakes away
 * through this barrel (components/ds/overlays.hygiene.test.ts); the mobile sheets are imported from `components/ds/sheet`.
 */
export * from './recipes';

// Controls
export { Button, buttonClasses, labelChildren, wrapTextRuns, BUTTON_BASE, BUTTON_EXTENSION_VARIANTS, BUTTON_SIZE, BUTTON_SIZES, BUTTON_VARIANT, BUTTON_VARIANTS, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { IconButton, ICON_BUTTON_SIZE, type IconButtonProps, type IconButtonSize } from './IconButton';
export { Field, useField, useFieldControl, FIELD_DESCRIPTION, FIELD_ERROR, FIELD_LABEL, type FieldContextValue, type FieldControlProps, type FieldProps } from './Field';
export { Input, Textarea, INPUT_CLASSES, TEXTAREA_CLASSES, type InputProps, type TextareaProps } from './Input';
export { Select, SELECT_CLASSES, SELECT_SIZE, type SelectOption, type SelectProps, type SelectSize } from './Select';
export { Segmented, SEGMENTED_ITEM_EDGE, SEGMENTED_SIZE, type SegmentedOption, type SegmentedProps, type SegmentedSize } from './Segmented';
export { Tabs, TabsContent, TabsList, TabsTrigger, type TabsContentProps, type TabsListProps, type TabsProps, type TabsTriggerProps } from './Tabs';
export { Switch, SWITCH_HIT_AREA, SWITCH_THUMB, SWITCH_TRACK, type SwitchProps } from './Switch';
export { Slider, SLIDER_CLASSES, snapToStep, type SliderProps } from './Slider';
export { Progress, PROGRESS_BAR, PROGRESS_MAKING, PROGRESS_SIZE, PROGRESS_TRACK, type ProgressProps, type ProgressSize, type ProgressTone } from './Progress';
export { Checkbox, CHECKBOX_BOX, CHECKBOX_CHECK, CHECKBOX_CONTROL, CHECKBOX_DASH, CHECKBOX_DESCRIPTION, CHECKBOX_INPUT, CHECKBOX_LABEL, CHECKBOX_ROW, type CheckboxProps, type CheckedState } from './Checkbox';

// Labels
export { Chip, type ChipProps, type ChipVariant } from './Chip';
export { Badge, BADGE_BASE, BADGE_VARIANT, BADGE_VARIANTS, type BadgeProps, type BadgeVariant } from './Badge';
export { StatusChip, STATUS_STATES, type StatusChipProps } from './StatusChip';

// Containers
export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, CARD, CARD_DESCRIPTION, CARD_TITLE, type CardTitleProps } from './Card';
export { SectionCard, type SectionCardProps } from './SectionCard';
export { PageHeader, PAGE_TITLE, type PageHeaderProps } from './PageHeader';
export { MetricCard, METRIC_CARD, METRIC_ICON_TILE, METRIC_VALUE, type MetricCardProps } from './MetricCard';

// States
export { EmptyState, EMPTY_FRAME, type EmptyStateProps } from './EmptyState';
export { LoadingState, type LoadingStateProps } from './LoadingState';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export { MessageText, LINE_CLAMP, MESSAGE_TEXT, MESSAGE_TOGGLE, type MessageTextLines, type MessageTextProps } from './MessageText';
export { StateIconTile, STATE_DESCRIPTION, STATE_TITLE, type StateAction, type StateHeading, type StateVariant } from './stateParts';
export { Skeleton, SKELETON_SHAPE, type SkeletonProps, type SkeletonShape } from './Skeleton';
export { ErrorBoundary, type ErrorBoundaryFallbackProps, type ErrorBoundaryProps } from './ErrorBoundary';

// Shell (DS-2; redesign plan §11.3 M1c)
export { AppHeader, AppHeaderSkeleton, HEADER_GRID, HEADER_INK, HEADER_INNER, HEADER_REGION, useScrolledPast, type AppHeaderProps, type AppHeaderSkeletonProps, type HeaderRegion } from './AppHeader';
export { TabBar, TabItemButton, navItemName, NAV_MOTION, TAB_BADGE, TAB_BAR, TAB_BAR_ROW, TAB_DOT, TAB_DOT_PLACE, TAB_HINT, TAB_HINT_MS, TAB_ITEM, TAB_ITEM_CURRENT, TAB_ITEM_DISABLED, TAB_ITEM_IDLE, TAB_ITEM_ORIENTATION, TAB_PILL, TAB_PILL_CURRENT, TAB_PILL_IDLE, type TabBarItem, type TabBarProps, type TabDot, type TabItemButtonProps } from './TabBar';
export { NavRail, NAV_RAIL, NAV_RAIL_DIVIDER, type NavRailBack, type NavRailProps } from './NavRail';

// Overlays (DS-1c: Radix, lead decision D6) and the app's one toast slot
export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, dialogMotion, DIALOG_CLOSE, DIALOG_DESCRIPTION, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_LAYER, DIALOG_PANEL, DIALOG_SCRIM, DIALOG_SIZE, DIALOG_TITLE_CLASSES, type DialogContentProps, type DialogProps, type DialogSize } from './Dialog';
export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger, ALERT_DIALOG_HEADER, type AlertDialogActionProps, type AlertDialogActionVariant, type AlertDialogContentProps, type AlertDialogProps } from './AlertDialog';
export { Menu, MenuCheckboxItem, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuShortcut, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, MENU_GROUP_LABEL, MENU_PANEL, MENU_ROW, MENU_ROW_CHOICE, MENU_ROW_INK, MENU_ROW_MARK, MENU_SEPARATOR, MENU_SHORTCUT, type MenuItemProps, type MenuItemVariant, type MenuProps } from './Menu';
export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger, POPOVER_PANEL, type PopoverProps } from './Popover';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, TOOLTIP_ARROW, TOOLTIP_DELAY_MS, TOOLTIP_LONG_PRESS_MS, TOOLTIP_PANEL, TOOLTIP_SKIP_DELAY_MS, TOOLTIP_TOUCH_HOLD_MS, type TooltipProps, type TooltipProviderProps } from './Tooltip';
export { claimToast, dismissToast, subscribeToastSlot, toast, ToastCard, ToastHost, toastSlotOwner, useToastSlot, TOAST_ACTIONS, TOAST_BODY, TOAST_CARD_WIDTH, TOAST_DURATION_MS, TOAST_HOST, TOAST_ICON, TOAST_STATUS, type ToastAction, type ToastCardProps, type ToastHandle, type ToastHostProps, type ToastOptions, type ToastTone } from './Toast';

// Motion and live state (bridge: Atlas effects ported onto styles/ds-motion.css)
export { useInViewPause, inViewAttribute, inViewRootMargin } from './useInViewPause';
export { InViewPause, type InViewPauseProps } from './InViewPause';
export { LiveDot, type LiveDotProps } from './LiveDot';
export { CountUp, COUNT_UP_MS, type CountUpProps } from './CountUp';
export { Collapse, COLLAPSE_BASE, COLLAPSE_CLOSED, COLLAPSE_OPEN, COLLAPSE_SETTLE_MS, type CollapseProps } from './Collapse';
export { usePresence, PRESENCE_EXIT_MS } from './usePresence';
export { useImageReveal, decodeImage, allowFilterEffects, canPlayEntrances, isCoarsePointer, isLowPowerDevice, motionEase, motionMs, parseMotionMs, playEntrance, readRevealEnvironment, revealTokenFallbacks, REVEAL_DECODE_TIMEOUT_MS, REVEAL_FILTER_MAX_WIDTH_PX, type DecodeImage, type ImageReveal, type ImageRevealOptions, type ImageRevealPhase, type RevealEnvironment } from './useImageReveal';
export { useReducedMotion, prefersReducedMotion } from './useReducedMotion';

// Content kit (DS-R1). Inspector and FilterSheet stay out of the barrel (they pull in the mobile sheets); import them by path.
export { ComicCard, COMIC_CARD, COMIC_CARD_PRIMARY, COMIC_CARD_ROW, type ComicCardAction, type ComicCardProps, type ComicCardVariant } from './ComicCard';
export { CoverImage, RevealImage, useNearViewport, isPublicationCoverSource, publicationCoverOrigins, revealKeyOf, artBoxStyle, COVER_BOX, COVER_WIDTHS, PUBLICATION_PATH_RE, type CoverImageProps, type CoverSources, type CoverWidth, type RevealImageProps } from './CoverImage';
export { MediaTile, MEDIA_TILE, MEDIA_TILE_RING_INSIDE, ON_ART_LABEL, type MediaTileProps } from './MediaTile';
export { CardGrid, CARD_GRID, CARD_GRID_STAGGER_MAX, focusTargetOf, nextGridIndex, type CardGridProps } from './CardGrid';
export { Shelf, useFinePointer, type ShelfProps } from './Shelf';
export { SearchField, SEARCH_MAX_LENGTH, type SearchFieldProps } from './SearchField';
export { FilterChips, FILTER_CHIP, FILTER_CHIP_ON, type FilterChipOption, type FilterChipsProps } from './FilterChips';
export { SelectionBar, selectionText, type SelectionBarProps } from './SelectionBar';
export { Lightbox, SWIPE_MIN_PX, type LightboxItem, type LightboxProps } from './Lightbox';
export { InlineMeta, INLINE_META, type InlineMetaProps } from './InlineMeta';
export { Row, ROW_PRIMARY, type RowProps } from './Row';
export { NavTrack, NAV_TRACK_ITEM, navTrackItemName, type NavTrackDot, type NavTrackItem, type NavTrackProps } from './NavTrack';
export { Sidebar, SIDEBAR, type SidebarGroup, type SidebarProps } from './Sidebar';
export { StatusBanner, STATUS_BANNER_SIZE, type StatusBannerProps, type StatusBannerTone } from './StatusBanner';
export { StatusPill, PILL_PRIORITY, pickPillState, pillName, pillStatus, type StatusPillProps, type StatusPillState } from './StatusPill';
export { SplitPane, splitBounds, type SplitPaneProps } from './SplitPane';
export { SourceBadge, type SourceBadgeProps } from './SourceBadge';
export { PresetTile, PRESET_TILE, type PresetSemantics, type PresetTileProps } from './PresetTile';
export { PresetGrid, type PresetGridProps, type PresetOption } from './PresetGrid';

// Content kit models (DS-R1)
export { layoutFor, postureOf, gutterFor, studioContentHeight, columnsStyle, CHROME, COARSE_HIT_AREA, CONTAINER_MAX_PX, GRID_GAP_PX, PAGES_TILE_PX, TEXT_MAX_PX, type AppNavKind, type DirectorLayout, type DirectorPlacement, type InspectorLayout, type InspectorMode, type LayoutPosture, type LayoutTable, type StudioNavKind } from './layout';
export { storageKeys, scopedKey, storageArea, readStored, writeStored, removeStored, storedBoolean, storedNumberIn, storedOneOf, useStoredState, type StorageArea, type StorageKey, type StorageScope } from './storage';
export { announce, announcedText, countWords, resetAnnouncer, useAnnounce, ANNOUNCE_GAP_MS, type AnnounceUrgency } from './announce';
export { useOnline, useConnectivity, markReachable, readConnectivity, UNREACHABLE_HOLD_MS, type Connectivity, type OfflineReason } from './useOnline';
export { useSelection, selectionReducer, EMPTY_SELECTION, type Selection, type SelectionAction, type SelectionState } from './useSelection';
export { useScrollRestore, readScrollPosition, writeScrollPosition, RESTORE_ATTEMPTS } from './useScrollRestore';
