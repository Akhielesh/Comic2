// What a share-link reader may download (requirements-addendum "Share links — READ-ONLY + downloadable"):
// the author's switch and the published languages. A tiny module on purpose — the public reader needs
// these answers to build its Download menu without pulling the exporters (which load on the click).

import type { ComicDoc } from '../../../shared/comic/doc';
import type { PublicPublicationInfo } from '../../../shared/comic/publication';
import { sameLanguage } from '../../../shared/comic/languages';
import { exportLanguages } from './sequence';

/** The author's download switch (absent ⇒ allowed: the addendum's default is true). */
export const publicDownloadsAllowed = (publication?: Pick<PublicPublicationInfo, 'allowDownload'> | null): boolean => publication?.allowDownload !== false;

export interface PublicDownloadSource {
  publication: Pick<PublicPublicationInfo, 'allowDownload' | 'languages'> & Partial<Pick<PublicPublicationInfo, 'defaultLang'>>;
  /** The snapshot doc as served (source language + published editions). */
  doc: ComicDoc;
  urls: Readonly<Record<string, string>>;
}

/** What the language answers need (the image URLs are optional here). */
export type PublicLanguageSource = Pick<PublicDownloadSource, 'publication' | 'doc'> & Partial<Pick<PublicDownloadSource, 'urls'>>;

/**
 * The languages a share-link reader may download: the published editions the snapshot really carries.
 * Never the source language when the author did not publish it (`exportLanguages` alone would fall
 * back to it). An old publication without a language list publishes its source (the publish default).
 */
export function publicExportLanguages(src: PublicLanguageSource): string[] {
  const listed = src.publication.languages?.filter((l) => typeof l === 'string' && l) ?? [];
  if (!listed.length) return exportLanguages(src.doc, [src.doc.format?.language || 'en']);
  return exportLanguages(src.doc, listed).filter((l) => listed.some((p) => sameLanguage(p, l)));
}

/** The published language to export for a reader's choice (undefined when nothing is published). */
export function publicExportLanguage(src: PublicLanguageSource, lang?: string): string | undefined {
  const published = publicExportLanguages(src);
  return published.find((l) => lang && sameLanguage(l, lang)) ?? published.find((l) => src.publication.defaultLang && sameLanguage(l, src.publication.defaultLang)) ?? published[0];
}
