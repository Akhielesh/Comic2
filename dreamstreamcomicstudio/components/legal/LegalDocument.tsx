import React, { createContext, useContext, useEffect } from 'react';
import { LEGAL_LAST_UPDATED, OPERATOR_NAME } from './legalFacts';
import { LEGAL_DOCS, followLegalHistory, legalDoc, legalDocForPath, pushLegalPath, type LegalDocId } from './legalRoutes';

// The shared frame of every legal page: title, date, the legal navigation, a table of contents and
// numbered sections with stable #anchors. Theme tokens only (--ds-*, see index.css), so every page
// reads in light and dark; the visual restyle comes later and only has to change this file.

export const LINK = 'font-medium text-[var(--ds-ink)] underline decoration-[var(--ds-accent)] underline-offset-2 hover:decoration-2';
export const LIST = 'list-disc space-y-2 pl-5';
export const NUMBERED = 'list-decimal space-y-2 pl-5';

/** Opens another legal document inside the app (App passes setCurrentView); absent = a normal link. */
const OpenDocContext = createContext<((id: LegalDocId) => void) | undefined>(undefined);

const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

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

/** A link to another legal document (or a section of one): SPA navigation on a plain click. */
export const DocLink: React.FC<{ to: LegalDocId; hash?: string; children?: React.ReactNode }> = ({ to, hash, children }) => {
    const open = useContext(OpenDocContext);
    const doc = legalDoc(to);
    return (
        <a
            href={`${doc.path}${hash ? `#${hash}` : ''}`}
            className={LINK}
            onClick={(e) => {
                // A section of another page needs a real load to land on its anchor.
                if (!open || hash || !plainClick(e)) return;
                e.preventDefault();
                pushLegalPath(to);
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

interface LegalDocumentProps {
    doc: LegalDocId;
    /** Opening paragraph(s), above the table of contents. */
    intro: React.ReactNode;
    /** Optional plain-English summary shown before the full text. */
    summary?: React.ReactNode;
    sections: LegalSection[];
    onBack: () => void;
    onOpenDoc?: (id: LegalDocId) => void;
}

/** Jump to the URL's #fragment once the (lazily loaded) page is in the DOM; otherwise start at the top. */
const useLandOnFragment = () => {
    useEffect(() => {
        const raw = window.location.hash.slice(1);
        const top = () => (document.scrollingElement ?? document.documentElement)?.scrollTo?.({ top: 0 });
        if (!raw) {
            top();
            return;
        }
        // A mangled shared link (e.g. #%) must not take the whole page down.
        let id = raw;
        try {
            id = decodeURIComponent(raw);
        } catch {
            /* keep the raw fragment */
        }
        const target = document.getElementById(id);
        if (target) target.scrollIntoView?.();
        else top();
    }, []);
};

/**
 * Back and Forward between pages the reader opened in the app (pushLegalPath gives each its own
 * history entry): another legal document's path opens that document (followLegalHistory, which
 * also covers a Forward after this page has closed), any other path goes back to where the page's
 * Back button goes (App's onBack: Dashboard or Home, not necessarily the view that entry named;
 * see pushLegalPath), and a move between #sections of this page is left to the browser.
 */
const useLegalHistory = (doc: LegalDocId, onBack: () => void, onOpenDoc?: (id: LegalDocId) => void) => {
    useEffect(() => {
        if (!onOpenDoc) return;
        const stopFollowing = followLegalHistory(doc, onOpenDoc);
        const onPop = () => {
            if (!legalDocForPath(window.location.pathname)) onBack();
        };
        window.addEventListener('popstate', onPop);
        return () => {
            stopFollowing();
            window.removeEventListener('popstate', onPop);
        };
    }, [doc, onBack, onOpenDoc]);
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

export const LegalDocument: React.FC<LegalDocumentProps> = ({ doc, intro, summary, sections, onBack, onOpenDoc }) => {
    const { title } = legalDoc(doc);
    useLandOnFragment();
    useDocumentTitle(title);
    useLegalHistory(doc, onBack, onOpenDoc);

    return (
        <OpenDocContext.Provider value={onOpenDoc}>
            <div className="min-h-screen bg-[var(--ds-canvas)] font-sans text-[var(--ds-ink)]">
                <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
                    <div className="mb-3 flex items-start justify-between gap-4">
                        <h1 className="text-3xl font-semibold tracking-tight text-[var(--ds-ink)]">{title}</h1>
                        <button
                            type="button"
                            onClick={onBack}
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
                            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="mt-10 scroll-mt-24 space-y-3">
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
        </OpenDocContext.Provider>
    );
};
