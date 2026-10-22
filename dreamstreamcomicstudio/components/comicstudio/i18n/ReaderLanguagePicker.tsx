// Reader language picker (contract §13.3; owner P1-I18N). Wave 0 (P0-C) stub: renders nothing.

import type React from 'react';

/** What a reader surface needs to offer a language switch (also ImmersiveReader's `language`). */
export interface ReaderLanguageSlot {
  current: string;
  options: { code: string; label: string; native?: string; status?: 'ready' }[];
  onChange(code: string): void;
}

export type ReaderLanguagePickerProps = ReaderLanguageSlot;

export const ReaderLanguagePicker: React.FC<ReaderLanguagePickerProps> = () => null;

export default ReaderLanguagePicker;
