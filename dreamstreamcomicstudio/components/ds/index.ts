/**
 * DreamStream design-system primitives (docs/design/design-system.md): Atlas's ui-generated recipes on
 * the `--ds-*` tokens and the studioDesign recipes. Overlays (Dialog, AlertDialog, Menu, Popover,
 * Tooltip, the Toast host) follow in DS-1c; the mobile sheets are imported from `components/ds/sheet`.
 */
export * from './recipes';

// Controls
export { Button, buttonClasses, BUTTON_BASE, BUTTON_SIZE, BUTTON_SIZES, BUTTON_VARIANT, BUTTON_VARIANTS, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { IconButton, ICON_BUTTON_SIZE, type IconButtonProps, type IconButtonSize } from './IconButton';
export { Field, useField, useFieldControl, FIELD_DESCRIPTION, FIELD_ERROR, FIELD_LABEL, type FieldContextValue, type FieldControlProps, type FieldProps } from './Field';
export { Input, Textarea, INPUT_CLASSES, TEXTAREA_CLASSES, type InputProps, type TextareaProps } from './Input';
export { Select, SELECT_CLASSES, SELECT_SIZE, type SelectOption, type SelectProps, type SelectSize } from './Select';
export { Segmented, SEGMENTED_ITEM_EDGE, SEGMENTED_SIZE, type SegmentedOption, type SegmentedProps, type SegmentedSize } from './Segmented';
export { Tabs, TabsContent, TabsList, TabsTrigger, type TabsContentProps, type TabsListProps, type TabsProps, type TabsTriggerProps } from './Tabs';
export { Switch, SWITCH_HIT_AREA, SWITCH_THUMB, SWITCH_TRACK, type SwitchProps } from './Switch';
export { Slider, SLIDER_CLASSES, snapToStep, type SliderProps } from './Slider';
export { Progress, PROGRESS_BAR, PROGRESS_SIZE, PROGRESS_TRACK, type ProgressProps, type ProgressSize } from './Progress';
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
export { StateIconTile, STATE_DESCRIPTION, STATE_TITLE, type StateAction, type StateHeading, type StateVariant } from './stateParts';
export { Skeleton, SKELETON_SHAPE, type SkeletonProps, type SkeletonShape } from './Skeleton';
export { ErrorBoundary, type ErrorBoundaryFallbackProps, type ErrorBoundaryProps } from './ErrorBoundary';

// Motion and live state (bridge: Atlas effects ported onto styles/ds-motion.css)
export { useInViewPause, inViewAttribute, inViewRootMargin } from './useInViewPause';
export { InViewPause, type InViewPauseProps } from './InViewPause';
export { LiveDot, type LiveDotProps } from './LiveDot';
export { CountUp, COUNT_UP_MS, type CountUpProps } from './CountUp';
export { Collapse, COLLAPSE_BASE, COLLAPSE_CLOSED, COLLAPSE_OPEN, COLLAPSE_SETTLE_MS, type CollapseProps } from './Collapse';
export { usePresence, PRESENCE_EXIT_MS } from './usePresence';
export { useReducedMotion, prefersReducedMotion } from './useReducedMotion';
