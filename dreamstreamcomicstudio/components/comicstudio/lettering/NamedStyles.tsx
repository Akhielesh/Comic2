// Saved lettering styles (agent-editor plan §3 C7; master plan §2.4 "Cascade"): "Save as style…" keeps a balloon's
// look under a name; balloons that use it are LINKED, so updating the style restyles every one of them (the Adobe
// character-style behaviour). The list renames, duplicates and deletes; deleting folds the style's look back into the
// balloons that used it, so nothing on the page changes. All free, each one undo entry.
//
// `named` and `styleId` are Pro fields (S2b lead decision, collisions C-9): while PRO_EDIT_OPS_PATCHABLE is off this
// section is not rendered at all and nothing here can send them.

import React, { useState } from 'react';
import { Check, Copy, PencilLine, Trash2 } from 'lucide-react';
import type { ComicDoc, Line, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { PRO_LETTER_LIMITS } from '../../../shared/comic/limits';
import type { PatchOptions } from '../types';
import { cn } from '../../../lib/utils';
import { FIELD, FOCUS_RING, INK, MUTED, OVERLINE, RADIUS_CONTROL, TONE_TEXT } from '../../chat/studioDesign';
import { LINE_KIND_LABEL, castName } from '../board/boardModel';
import { proFieldsWritable } from '../editor/inspector/proGate';
import {
  cleanStyleName,
  deleteNamedStyleOps,
  duplicateNamedStyleOps,
  namedStylesOf,
  redefineNamedStyleOps,
  renameNamedStyleOps,
  saveNamedStyleOps,
  uniqueStyleName,
  useNamedStyleOps
} from './styleOps';

export interface NamedStylesProps {
  doc: ComicDoc;
  page: Page;
  /** The selected lines (reading order). */
  lines: readonly Line[];
  apply(ops: DocOp[], opts?: PatchOptions): void;
  /** Translated editions share the original's styles: the list shows, the writers wait for the original. */
  editionLang?: string;
  /** Ids for new styles (tests); default a fresh `st_…`. */
  newStyleId?: () => string;
}

const BTN = cn(
  'inline-flex h-8 min-w-0 items-center justify-center gap-1 border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 text-[12px] font-medium hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-40 coarse:h-11 coarse:min-h-11 coarse:min-w-11 coarse:px-3',
  RADIUS_CONTROL,
  INK,
  FOCUS_RING
);
// The icon button's shape without an ink (cn keeps both inks of a stack: statusInkGuard), then the neutral one.
const ICON_BTN_SHAPE = cn(
  'grid h-8 w-8 shrink-0 place-items-center hover:bg-[var(--ds-hover)] disabled:cursor-not-allowed disabled:opacity-40 coarse:h-11 coarse:min-h-11 coarse:w-11 coarse:min-w-11',
  RADIUS_CONTROL,
  FOCUS_RING
);
const ICON_BTN = cn(ICON_BTN_SHAPE, MUTED);

/** The name "Save as style…" suggests: the speaker's name for a spoken line, else the kind ("Caption"). */
export const suggestedStyleName = (doc: ComicDoc, line: Line | undefined): string =>
  uniqueStyleName(doc, line?.speakerId ? castName(doc, line.speakerId) : line ? LINE_KIND_LABEL[line.kind] : 'Style');

const NameInput: React.FC<{ initial: string; label: string; onDone(name: string | null): void }> = ({ initial, label, onDone }) => {
  const [v, setV] = useState(initial);
  return (
    <input
      autoFocus
      aria-label={label}
      maxLength={PRO_LETTER_LIMITS.namedNameChars}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onDone(cleanStyleName(v) || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onDone(cleanStyleName(v) || null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone(null);
        }
      }}
      className={cn(FIELD, 'h-8 w-full min-w-0 px-2 text-[12.5px] coarse:h-11')}
    />
  );
};

export const NamedStyles: React.FC<NamedStylesProps> = ({ doc, page, lines, apply, editionLang, newStyleId }) => {
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!proFieldsWritable()) return null;
  const styles = namedStylesOf(doc);
  const one = lines.length === 1 ? lines[0] : undefined;
  const ids = lines.map((l) => l.id);
  const atCap = styles.length >= PRO_LETTER_LIMITS.namedStyles;
  const inEdition = !!editionLang;
  const linked = one?.styleId ? styles.find((s) => s.id === one.styleId) : undefined;
  const run = (ops: DocOp[], label: string) => ops.length && apply(ops, { label });

  return (
    <section aria-label="Saved styles" data-testid="named-styles" className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 className={cn('m-0', OVERLINE)}>Saved styles</h4>
        <span className={cn('text-[11px] tabular-nums', MUTED)}>
          {styles.length} of {PRO_LETTER_LIMITS.namedStyles}
        </span>
      </div>
      {inEdition && <p className={cn('m-0 text-[11px] leading-snug', MUTED)}>Saved styles belong to the original language — switch to it to save or change one.</p>}
      {styles.length === 0 && !saving && <p className={cn('m-0 text-[11.5px] leading-snug', MUTED)}>Save a balloon’s look under a name, then use it on any balloon. Updating the style restyles them all.</p>}
      {styles.length > 0 && (
        <ul className="m-0 min-w-0 list-none space-y-1 p-0">
          {styles.map((s) => {
            const current = one?.styleId === s.id;
            return (
              <li key={s.id} data-style-id={s.id} className={cn('flex min-w-0 items-center gap-1 border border-[var(--ds-hairline)] px-1.5 py-1', RADIUS_CONTROL, current && 'bg-[var(--ds-accent-soft)]')}>
                {renaming === s.id ? (
                  <div className="min-w-0 flex-1">
                    <NameInput
                      initial={s.name}
                      label={`Rename “${s.name}”`}
                      onDone={(name) => {
                        setRenaming(null);
                        if (name) run(renameNamedStyleOps(doc, s.id, name), `Rename style “${s.name}”`);
                      }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-pressed={current}
                    disabled={!lines.length || inEdition}
                    title={lines.length ? `Use “${s.name}” on ${lines.length > 1 ? 'these balloons' : 'this balloon'}` : 'Select a balloon to use this style'}
                    onClick={() => run(useNamedStyleOps(doc, page, ids, s.id), `Use style “${s.name}”`)}
                    className={cn('flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-[12.5px] hover:bg-[var(--ds-hover)] disabled:cursor-default coarse:min-h-11', RADIUS_CONTROL, INK, FOCUS_RING)}
                  >
                    {current && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className={cn('shrink-0 text-[11px] tabular-nums', MUTED)}>{s.uses === 1 ? '1 balloon' : `${s.uses} balloons`}</span>
                  </button>
                )}
                <button type="button" aria-label={`Rename “${s.name}”`} disabled={inEdition} className={ICON_BTN} onClick={() => setRenaming(s.id)}>
                  <PencilLine className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Duplicate “${s.name}”`}
                  disabled={inEdition || atCap}
                  className={ICON_BTN}
                  onClick={() => run(duplicateNamedStyleOps(doc, s.id, newStyleId?.()), `Duplicate style “${s.name}”`)}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Delete “${s.name}”`}
                  title="Delete the style; its balloons keep their look"
                  disabled={inEdition}
                  className={cn(ICON_BTN_SHAPE, TONE_TEXT.danger)}
                  onClick={() => run(deleteNamedStyleOps(doc, s.id), `Delete style “${s.name}”`)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {saving && one ? (
        <NameInput
          initial={suggestedStyleName(doc, one)}
          label="Style name"
          onDone={(name) => {
            setSaving(false);
            if (name) run(saveNamedStyleOps(doc, page, one.id, name, newStyleId?.()), `Save style “${name}”`);
          }}
        />
      ) : (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <button
            type="button"
            className={BTN}
            disabled={!one || atCap || inEdition}
            title={atCap ? `At most ${PRO_LETTER_LIMITS.namedStyles} saved styles — delete one first` : one ? 'Save this balloon’s look under a name' : 'Select one balloon to save its look'}
            onClick={() => setSaving(true)}
          >
            Save as style…
          </button>
          {linked && one?.style && (
            <button type="button" className={BTN} disabled={inEdition} onClick={() => run(redefineNamedStyleOps(doc, page, one.id), `Update style “${linked.name}”`)}>
              Update “{linked.name}”
            </button>
          )}
          {linked && (
            <button type="button" className={BTN} disabled={inEdition} onClick={() => run(useNamedStyleOps(doc, page, ids, null), 'Stop using the saved style')}>
              Use no saved style
            </button>
          )}
        </div>
      )}
    </section>
  );
};

export default NamedStyles;
