// Model Lab (M1-MODEL-LAB) — the admin-only section for the owner-approved paid checks D1–D4 (models.md §2.6).
// Registered as an admin section by the lead through the models feature: add `labAdminSection` to
// `adminSections` in ../index.ts (that file belongs to M1-PICKER-UI). The section is code-split, so studio users
// never download it, and the server re-checks requireAdmin on every /api/comic/models/lab path.

import React, { Suspense } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import type { AdminSectionRegistration } from '../../extensions';

const LazyModelLab = React.lazy(() => import('./ModelLabSection').then((m) => ({ default: m.ModelLabSection })));

/** Admin → Model Lab (lazy). */
export const ModelLabAdminSection: React.FC = () =>
  React.createElement(
    Suspense,
    {
      fallback: React.createElement(
        'div',
        { className: 'flex items-center gap-2 rounded-[var(--ds-radius-panel)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4 text-[13px] text-[var(--ds-muted)]' },
        React.createElement(Loader2, { className: 'h-4 w-4 motion-safe:animate-spin', 'aria-hidden': true }),
        'Loading the Model Lab…'
      )
    },
    React.createElement(LazyModelLab)
  );

export const labAdminSection: AdminSectionRegistration = {
  id: 'model-lab',
  label: 'Model Lab',
  icon: React.createElement(FlaskConical, { size: 15 }),
  Component: ModelLabAdminSection
};

export { MODEL_LAB_PATH, fetchLabOverview, runLabCheck, setLabWatermark, voteBlindPair, formatLabUsd, newClickId } from './labApi';
export type { LabOverview, LabItem, LabRun, BlindPair, LabRunAnswer } from './labApi';
// P1 · Pro pages A/B, part 1: rendered inside the lazy lab section (ProPagesSection.tsx), so only its types are
// re-exported here — a value export would pull it into the studio bundle.
export type { ProPagesOverview, ProPagesArmItem, ProPagesPage, LabAbRun, LabPageCheck } from './labApi';
