// Comic History — the History board tab (versions plan §8 "Entry points", order 510; package H5): the same History
// experience as the header panel, inline in the board. Shown only while Comic History is on.

import React from 'react';
import { historyEnabled } from '../../../shared/comic/capabilities';
import { HistoryBrowser } from './HistoryPanel';
import type { HistoryStudio } from './useHistory';

export const HistoryTab: React.FC<{ studio: HistoryStudio }> = ({ studio }) => {
  if (!historyEnabled(studio.caps) || !studio.doc) return null;
  return (
    <div className="min-w-0 pb-6" data-history-tab>
      <HistoryBrowser studio={studio} open inline />
    </div>
  );
};

export default HistoryTab;
