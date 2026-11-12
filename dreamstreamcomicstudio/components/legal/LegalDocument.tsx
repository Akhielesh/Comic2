import React, { createContext, useContext, useEffect } from 'react';
import { LEGAL_LAST_UPDATED, OPERATOR_NAME } from './legalFacts';
import {
    LEGAL_DOCS,
    LEGAL_TITLE_ID,
    clearFragment,
    followLegalHistory,
    legalBackGoesBack,
    legalDoc,
    legalDocForPath,
    landOn,
    landOnTop,
    pushLegalPath,
    replaceLegalFragment,
    type LegalDocId
} from './legalRoutes';

// The shared frame of every legal page: title, date, the legal navigation, a table of contents and
// numbered sections with stable #anchors. Theme tokens only (--ds-*, see index.css), so every page
// reads in light and dark; the visual restyle comes later and only has to change this file.

export const LINK = 'font-medium text-[var(--ds-ink)] underline decoration-[var(--ds-accent)] underline-offset-2 hover:decoration-2';
export const LIST = 'list-disc space-y-2 pl-5';
export const NUMBERED = 'list-decimal space-y-2 pl-5';

/**
 * The document shown, and how to open another one inside the app (App passes setCurrentView;
 * absent = a normal link).
 */
const DocNavContext = createContext<{ doc: LegalDocId | null; open?: (id: LegalDocId) => void }>({ doc: null });

const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** A fragment from an href or the address (#%E0%A4 and other mangled ones kept as they are). */
const decodeFragment = (raw: string): string => {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
};

/**
 * Jump to a section of the page already shown without a new history entry (replaceLegalFragment
 * says why): scroll to it, put its #fragment on the current entry, and move focus there as the
 * browser's own fragment navigation would, so Tab carries on from the section. False when the
 * section isn't on this page or history can't be written: the caller then leaves the click alone.
 */
const showSection = (id: string): boolean => {
    const target = id ? document.getElementById(id) : null;
    if (!target || !replaceLegalFragment(id)) return false;
    landOn(target);
    return true;
};

export const ExternalLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
    </a>
);

/** A mailto link that shows the address itself (optionally with a subject line filled in). */
export const MailLink: React.FC<{ email: string; subject?: string }> = ({ email, subject }) => (
    <a href={`mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`} className={LINK}>
        {email}
    </a>
);

/**
 * A link to another legal document (or a section of one): SPA navigation on a plain click. A section
 * of the page already shown is a jump on the current entry (showSection); another document, with or
 * without a section, gets its own marked entry (pushLegalPath), and lands on the section once it is
 * in the DOM (useLandOnFragment), so its Back button returns here.
 */
export const DocLink: React.FC<{ to: LegalDocId; hash?: string; children?: React.ReactNode }> = ({ to, hash, children }) => {
    const { doc: shown, open } = useContext(DocNavContext);
    const doc = legalDoc(to);
    return (
        <a
            href={`${doc.path}${hash ? `#${hash}` : ''}`}
            className={LINK}
            onClick={(e) => {
                if (!plainClick(e)) return;
                if (to === shown && hash) {
                    if (showSection(hash)) e.preventDefault();
                    return;
                }
                if (!open) return;
                e.preventDefault();
                pushLegalPath(to, hash);
                open(to);
            }}
        >
            {children ?? doc.title}
        </a>
    );
};

export const SubHeading: React.FC<{ id?: string; children: React.ReactNode }> = ({ id, children }) => (
    <h3 id={id} className="scroll-mt-24 pt-3 text-[15px] font-semibold text-[var(--ds-ink)]">
        {children}
    </h3>
);

/** A highlighted aside (a plain-English summary, a safety note). */
export const Callout: React.FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="space-y-2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-4 py-3 text-sm">
        {title && <p className="font-semibold text-[var(--ds-ink)]">{title}</p>}
        {children}
    </div>
);

/**
 * A table (headers + rows of cells). From the sm breakpoint up it is a normal table (scrolling
 * sideways if it must); on a phone each row becomes a card, every cell under its column's name, so
 * no column is cut off at the screen's edge.
 */
export const DataTable: React.FC<{ caption: string; head: string[]; rows: React.ReactNode[][] }> = ({ caption, head, rows }) => (
    <div className="rounded-lg border border-[var(--ds-hairline)] sm:overflow-x-auto">
        <table className="block w-full border-collapse text-left text-sm sm:table sm:min-w-[36rem]">
            <caption className="sr-only">{caption}</caption>
            <thead className="hidden bg-[var(--ds-well)] sm:table-header-group">
                <tr>
                    {head.map((h) => (
                        <th key={h} scope="col" className="border-b border-[var(--ds-hairline)] px-3 py-2 font-semibold text-[var(--ds-ink)]">
                            {h}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody className="block sm:table-row-group">
                {rows.map((cells, r) => (
                    <tr key={r} className="block border-b border-[var(--ds-hairline)] py-1 last:border-b-0 sm:table-row sm:py-0 sm:align-top">
                        {cells.map((cell, c) =>
                            c === 0 ? (
                                <th key={c} scope="row" className="block px-3 py-2 font-semibold text-[var(--ds-ink)] sm:table-cell sm:border-b sm:border-[var(--ds-hairline)] sm:font-medium">
                                    {cell}
                                </th>
                            ) : (
                                <td key={c} className="block px-3 pb-2 sm:table-cell sm:border-b sm:border-[var(--ds-hairline)] sm:py-2">
                                    <span className="block text-xs font-semibold text-[var(--ds-muted)] sm:hidden">{head[c]}</span>
                                    {cell}
                                </td>
                            )
                        )}
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

export interface LegalSection {
    /** Stable anchor (#id). Never rename one that's published: other pages and emails link to it. */
    id: string;
    title: string;
    content: React.ReactNode;
}

/** What App gives every legal page. */
export interface LegalPageProps {
    /**
     * The page's own Back button when there is no page of this visit to go back to (a cold load of
     * the document's address). When the document was opened from another page of the app, the
     * button goes back in history instead, exactly like the browser's Back (legalBackGoesBack).
     */
    onBack: () => void;
    /** Opens another legal document inside the app (App's view setter). */
    onOpenDoc?: (id: LegalDocId) => void;
    /**
     * The browser's or phone's Back (or Forward) onto an entry that isn't a legal document: App
     * shows the view that entry names (its restoreViewFromHistory). Without it, onBack.
     */
    onHistoryBack?: () => void;
}

interface LegalDocumentProps extends LegalPageProps {
    doc: LegalDocId;
    /** Opening paragraph(s), above the table of contents. */
    intro: React.ReactNode;
    /** Optional plain-English summary shown before the full text. */
    summary?: React.ReactNode;
    sections: LegalSection[];
}

/**
 * Land on the URL's #fragment once the (lazily loaded) page is in the DOM, focus included (landOn):
 * a link to a section of another document unmounts the link that was clicked, which would otherwise
 * leave focus on <body>. Otherwise start at the top, with focus left on a control still on the page
 * (the shared footer's link) moved to the title (landOnTop).
 */
const useLandOnFragment = () => {
    useEffect(() => {
        const raw = window.location.hash.slice(1);
        if (!raw) {
            landOnTop();
            return;
        }
        // A mangled shared link (e.g. #%) must not take the whole page down.
        const target = document.getElementById(decodeFragment(raw));
        if (target) landOn(target);
        else landOnTop();
    }, []);
};

/**
 * Back and Forward between pages the reader opened in the app (pushLegalPath gives each its own
 * history entry): another legal document's path opens that document (followLegalHistory, which
 * also covers a Forward after this page has closed), any other path goes to the view that entry
 * names (onLeave: App's restoreViewFromHistory, see pushLegalPath), and a move between #sections of
 * this page is left to the browser.
 */
const useLegalHistory = (doc: LegalDocId, onLeave: () => void, onOpenDoc?: (id: LegalDocId) => void) => {
    useEffect(() => {
        if (!onOpenDoc) return;
        const stopFollowing = followLegalHistory(doc, onOpenDoc);
        const onPop = () => {
            if (!legalDocForPath(window.location.pathname)) onLeave();
        };
        window.addEventListener('popstate', onPop);
        return () => {
            stopFollowing();
            window.removeEventListener('popstate', onPop);
        };
    }, [doc, onLeave, onOpenDoc]);
};

const useDocumentTitle = (title: string) => {
    useEffect(() => {
        const previous = document.title;
        document.title = `${title} · ${OPERATOR_NAME}`;
        return () => {
            document.title = previous;
        };
    }, [title]);
};

export const LegalDocument: React.FC<LegalDocumentProps> = ({ doc, intro, summary, sections, onBack, onOpenDoc, onHistoryBack }) => {
    const { title } = legalDoc(doc);
    useLandOnFragment();
    useDocumentTitle(title);
    useLegalHistory(doc, onHistoryBack ?? onBack, onOpenDoc);
    // Opened from another page of this visit: the button and the browser's Back agree (popstate then
    // shows that page, through useLegalHistory). In the app only: without onOpenDoc nothing listens.
    // Moves between sections stay on that entry (onSectionLink), so its mark is still there. Otherwise
    // the page left for keeps no #section of this one in its address.
    const goBack = () => {
        if (onOpenDoc && legalBackGoesBack()) window.history.back();
        else {
            clearFragment();
            onBack();
        }
    };
    // Every same-page link (the table of contents, "see Enforcement" in the text): a jump on the
    // current history entry instead of a new entry with no state (showSection).
    const onSectionLink = (e: React.MouseEvent<HTMLElement>) => {
        if (e.defaultPrevented || !plainClick(e)) return;
        const href = (e.target as Element | null)?.closest?.('a')?.getAttribute('href');
        if (!href || !href.startsWith('#') || href.length < 2) return;
        if (showSection(decodeFragment(href.slice(1)))) e.preventDefault();
    };

    return (
        <DocNavContext.Provider value={{ doc, open: onOpenDoc }}>
            <div className="min-h-screen bg-[var(--ds-canvas)] font-sans text-[var(--ds-ink)]">
                <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-12" onClick={onSectionLink}>
                    <div className="mb-3 flex items-start justify-between gap-4">
                        <h1 id={LEGAL_TITLE_ID} tabIndex={-1} className="text-3xl font-semibold tracking-tight text-[var(--ds-ink)] focus:outline-none">{title}</h1>
                        <button
                            type="button"
                            onClick={goBack}
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-bold text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                        >
                            Back
                        </button>
                    </div>
                    <p className="mb-5 text-sm text-[var(--ds-muted)]">
                        Last updated <time dateTime={LEGAL_LAST_UPDATED.iso}>{LEGAL_LAST_UPDATED.label}</time>
                    </p>

                    <nav aria-label="Legal documents" className="mb-6">
                        <ul className="flex flex-wrap gap-2 text-sm">
                            {LEGAL_DOCS.map((d) => {
                                const current = d.id === doc;
                                return (
                                    <li key={d.id}>
                                        <a
                                            href={d.path}
                                            aria-current={current ? 'page' : undefined}
                                            onClick={(e) => {
                                                if (!onOpenDoc || !plainClick(e)) return;
                                                e.preventDefault();
                                                if (current) return;
                                                pushLegalPath(d.id);
                                                onOpenDoc(d.id);
                                            }}
                                            className={
                                                current
                                                    ? 'inline-block rounded-full border border-[var(--ds-ink)] px-3 py-1 font-semibold text-[var(--ds-ink)]'
                                                    : 'inline-block rounded-full border border-[var(--ds-hairline)] px-3 py-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                                            }
                                        >
                                            {d.label}
                                        </a>
                                    </li>
                                );
                            })}
                        </ul>
                    </nav>

                    <div className="space-y-3 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-5 text-[15px] leading-relaxed shadow-sm sm:p-8">
                        {intro}
                        {summary}

                        <nav aria-label="On this page" className="mt-6 rounded-lg border border-[var(--ds-hairline)] p-4">
                            <p className="mb-2 text-sm font-semibold text-[var(--ds-ink)]">On this page</p>
                            <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                                {sections.map((s, i) => (
                                    <li key={s.id}>
                                        <a href={`#${s.id}`} className="text-[var(--ds-muted)] underline-offset-2 hover:text-[var(--ds-ink)] hover:underline">
                                            {i + 1}. {s.title}
                                        </a>
                                    </li>
                                ))}
                            </ol>
                        </nav>

                        {sections.map((s, i) => (
                            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="mt-10 scroll-mt-24 space-y-3 focus:outline-none">
                                <h2 id={`${s.id}-title`} className="text-lg font-semibold text-[var(--ds-ink)]">
                                    {i + 1}. {s.title}
                                </h2>
                                {s.content}
                            </section>
                        ))}
                    </div>

                    <p className="mt-6 text-xs text-[var(--ds-muted)]">
                        {OPERATOR_NAME} · {title} · Last updated {LEGAL_LAST_UPDATED.label}
                    </p>
                </main>
            </div>
        </DocNavContext.Provider>
    );
};
