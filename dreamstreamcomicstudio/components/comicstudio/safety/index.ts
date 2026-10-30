// Client feature module: PG-13 safety UI. Owner: P1-SAFETY (wave 1). Registered through
// ../features.ts (contract §13.2): the admin console gains the "Comic safety" section (admin-only
// in the UI; the server re-checks requireModerator on every call).
//
// The rating badge/picker, the veil and the report dialog are cross-package components that
// their hosts import directly (StoryTab, ImageFrame/ComicPageView/PagesTab, the reader chrome).

import React from 'react';
import { ShieldCheck } from 'lucide-react';
import type { FeatureModule } from '../extensions';
import { SafetyCasesSection } from './SafetyCasesSection';

export const feature: FeatureModule = {
  adminSections: [
    {
      id: 'comic-safety',
      label: 'Comic safety',
      icon: React.createElement(ShieldCheck, { size: 16, 'aria-hidden': true }),
      Component: SafetyCasesSection
    }
  ]
};

export { RatingBadge } from './RatingBadge';
export { RatingPicker, StudioRatingPicker, ratingPickerState } from './RatingPicker';
export { SafetyVeil } from './SafetyVeil';
export { ReportDialog, REPORT_REASON_OPTIONS } from './ReportDialog';
export { SafetyCasesSection } from './SafetyCasesSection';
