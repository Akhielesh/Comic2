// Client feature module: translations and reader languages (cards: translation; tabs: languages).
// Owner: P1-I18N. Registered through ../features.ts (contract §13.2).

import React from 'react';
import { Languages } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { i18nOf } from '../../../shared/comic/i18n';
import type { FeatureModule } from '../extensions';
import { LanguagesTab } from './LanguagesTab';
import { TranslationCard } from './TranslationCard';

/** The Languages tab shows once there is dialogue to translate, or a translation exists. */
export const languagesTabVisible = (doc: ComicDoc): boolean =>
  Object.keys(i18nOf(doc).editions).length > 0 || doc.pages.some((p) => p.panels.some((pn) => pn.lines.some((l) => !!l.text?.trim())));

export const feature: FeatureModule = {
  cards: [{ type: 'translation', Component: TranslationCard }],
  tabs: [
    {
      id: 'languages',
      label: 'Languages',
      icon: React.createElement(Languages, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
      order: 800,
      Component: LanguagesTab,
      visible: (doc) => languagesTabVisible(doc)
    }
  ]
};

export { ReaderLanguagePicker, type ReaderLanguageSlot } from './ReaderLanguagePicker';
export { LanguageSwitch, languageSwitchOptions } from './LanguageSwitch';
export { pickReaderLanguage, readerLanguageOptions, readStoredReaderLang, storeReaderLang, readUrlLang, syncLangToUrl, nextLanguage, useReaderLanguage, type ReaderLanguageState } from './readerLanguage';
export { readerString, readerStrings } from './readerStrings';
export { cssFontFamily, ensureFontsFor } from './scriptFonts';
