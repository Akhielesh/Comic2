// Immersive full-screen reader, "Leaf" (contract §13.3; owner P1-READER).
// Wave 0 (P0-C) stub: renders nothing.

import type React from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';
import type { ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';

export interface ImmersiveReaderEndCard {
  authorName?: string;
  onMakeYourOwn?(): void;
  shareUrl?: string;
}

export interface ImmersiveReaderProps {
  doc: ComicDoc;
  urlFor: StudioController['urlFor'];
  /** 1-based page number, or the cover. */
  initialPage?: number | 'cover';
  language?: ReaderLanguageSlot;
  endCard?: ImmersiveReaderEndCard;
  /** Play the cover intro (immersive surfaces only, once per session per comic). */
  intro: boolean;
  onExit(): void;
  allowDownload?: boolean;
}

export const ImmersiveReader: React.FC<ImmersiveReaderProps> = () => null;

export default ImmersiveReader;
