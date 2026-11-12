// QA scene `ds-content` (DS-R1; redesign plan §4, §10; the scene contract is in qa/app/index.tsx): the content kit —
// ComicCard in every variant, CoverImage and MediaTile (with the comic's tint, the on-art chips and a selected ring),
// CardGrid in and out of selection mode with the SelectionBar, a Shelf (cards, loading, error), SearchField and
// FilterChips, StatusPill and StatusBanner in every state, NavTrack and the Sidebar, PresetGrid, the Lightbox, a
// SplitPane, Row and InlineMeta, SourceBadge and the on-art RatingBadge — plus the layout table's numbers for the
// viewport the scene is measured at. Everything is local: the art is inline SVG (data: URLs, no request), nothing
// fetches and nothing spends. Prices never appear (the kit takes amounts as formatted strings and this scene has none).

import React, { useMemo, useState } from 'react';
import { Bell, BookOpen, Download, Home, Image as ImageIcon, LayoutGrid, MessageSquare, Send, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ds/Button';
import { CardGrid } from '../../../components/ds/CardGrid';
import { ComicCard } from '../../../components/ds/ComicCard';
import { CoverImage } from '../../../components/ds/CoverImage';
import { FilterChips } from '../../../components/ds/FilterChips';
import { InlineMeta } from '../../../components/ds/InlineMeta';
import { Inspector } from '../../../components/ds/Inspector';
import { layoutFor } from '../../../components/ds/layout';
import { Lightbox } from '../../../components/ds/Lightbox';
import { MediaTile, ON_ART_LABEL } from '../../../components/ds/MediaTile';
import { NavTrack } from '../../../components/ds/NavTrack';
import { PresetGrid } from '../../../components/ds/PresetGrid';
import { Row } from '../../../components/ds/Row';
import { SearchField } from '../../../components/ds/SearchField';
import { SelectionBar } from '../../../components/ds/SelectionBar';
import { Shelf } from '../../../components/ds/Shelf';
import { Sidebar } from '../../../components/ds/Sidebar';
import { SourceBadge } from '../../../components/ds/SourceBadge';
import { SplitPane } from '../../../components/ds/SplitPane';
import { StatusBanner } from '../../../components/ds/StatusBanner';
import { StatusPill, type StatusPillState } from '../../../components/ds/StatusPill';
import { useSelection } from '../../../components/ds/useSelection';
import { countWords } from '../../../components/ds/announce';
import { RatingBadge } from '../../../components/comicstudio/safety/RatingBadge';
import { useFormFactor } from '../../../components/comicstudio/mobile/useFormFactor';
import { HEADING, OVERLINE, SECTION_CARD } from '../../../components/chat/studioDesign';
import type { QaAppScene } from '../index';

/** A cover as inline SVG: a soft gradient in the comic's hue and a simple panel grid (no request, no hex). */
const coverArt = (hue: number, label: string): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 45% 32%)"/></linearGradient></defs><rect width="200" height="300" fill="url(#g)"/><rect x="14" y="14" width="172" height="120" rx="6" fill="hsl(${hue} 30% 92% / .35)"/><rect x="14" y="146" width="80" height="140" rx="6" fill="hsl(${hue} 30% 92% / .25)"/><rect x="106" y="146" width="80" height="140" rx="6" fill="hsl(${hue} 30% 92% / .2)"/><text x="100" y="80" text-anchor="middle" font-family="sans-serif" font-size="22" fill="hsl(${hue} 20% 98%)">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

interface DemoComic {
  id: string;
  title: string;
  hue: number;
  pages: number;
  drawn: number;
  edited: string;
  rating: 'G' | 'PG' | 'PG-13';
  creator: string;
}

const COMICS: DemoComic[] = [
  { id: 'harbor', title: 'The Harbor Lights', hue: 210, pages: 6, drawn: 4, edited: 'Edited Tue', rating: 'PG', creator: '@mara' },
  { id: 'fox', title: 'Fox and the Lantern Festival', hue: 28, pages: 12, drawn: 12, edited: 'Edited 2 h ago', rating: 'G', creator: '@sol' },
  { id: 'noir', title: 'Rain on Seventh Street', hue: 260, pages: 8, drawn: 2, edited: 'Edited Oct 30', rating: 'PG-13', creator: '@ink' },
  { id: 'garden', title: 'A Garden on the Moon', hue: 140, pages: 4, drawn: 0, edited: 'Edited today', rating: 'G', creator: '@lune' },
  { id: 'heist', title: 'Twelve-Panel Heist', hue: 350, pages: 12, drawn: 7, edited: 'Edited Mon', rating: 'PG', creator: '@vic' },
  { id: 'tide', title: 'Low Tide', hue: 185, pages: 6, drawn: 6, edited: 'Edited Sep 2', rating: 'G', creator: '@reef' }
];

const PILLS: ReadonlyArray<[StatusPillState, string, string]> = [
  ['offline', 'Offline', 'Off'],
  ['error', 'Needs attention', '!'],
  ['waiting', 'Waiting for you', 'Wait'],
  ['drawing', 'Drawing 2 of 6', '2/6'],
  ['uploading', 'Uploading 3', 'Up 3'],
  ['saving', 'Saving…', 'Save'],
  ['idle', '62% left', '62%']
];

const KINDS = [
  { value: 'all', label: 'All', count: 6 },
  { value: 'drafts', label: 'Drafts', count: 3 },
  { value: 'drawn', label: 'Drawn', count: 2 },
  { value: 'live', label: 'Live', count: 1 },
  { value: 'pinned', label: 'Pinned', count: 0 }
] as const;
type Kind = (typeof KINDS)[number]['value'];

const PLACES = [
  { id: 'home', label: 'Home', icon: <Home /> },
  { id: 'director', label: 'Director', icon: <MessageSquare />, dot: 'new' as const },
  { id: 'story', label: 'Story', icon: <BookOpen /> },
  { id: 'pages', label: 'Pages', icon: <LayoutGrid />, badge: '4/6', badgeLabel: '4 of 6 pages drawn' },
  { id: 'publish', label: 'Publish', icon: <Send /> }
];

const Section: React.FC<{ id: string; title: string; children: React.ReactNode }> = ({ id, title, children }) => (
  <section aria-labelledby={`ds-content-${id}`} className={`${SECTION_CARD} min-w-0 p-4 sm:p-5`}>
    <h2 id={`ds-content-${id}`} className={`m-0 mb-3 text-[length:var(--ds-text-lg)] ${HEADING}`}>
      {title}
    </h2>
    <div className="flex min-w-0 flex-col gap-4">{children}</div>
  </section>
);

function Scene() {
  const ff = useFormFactor();
  const table = layoutFor(ff);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [place, setPlace] = useState('pages');
  const [style, setStyle] = useState<string | null>('ink');
  const [lightbox, setLightbox] = useState(0);
  const shown = useMemo(
    () =>
      COMICS.filter((c) => (kind === 'all' ? true : kind === 'drafts' ? c.drawn < c.pages : kind === 'drawn' ? c.drawn === c.pages : kind === 'live' ? c.id === 'fox' : false)).filter((c) =>
        c.title.toLowerCase().includes(query.trim().toLowerCase())
      ),
    [kind, query]
  );
  const selection = useSelection(shown.map((c) => c.id));
  const columns = table.library.columns.comfortable;

  return (
    <main data-qa-scene="ds-content" aria-label="Content kit" className="min-h-[100dvh] min-w-0 bg-[var(--ds-canvas)] px-4 py-6 text-[var(--ds-ink)] sm:px-6">
      <div className="mx-auto flex min-w-0 max-w-[1360px] flex-col gap-5">
        <header className="flex min-w-0 flex-col gap-1">
          <p className={`m-0 ${OVERLINE}`}>DS-R1</p>
          <h1 className={`m-0 text-[length:var(--ds-text-2xl)] ${HEADING}`}>Content kit</h1>
          <InlineMeta
            wrap
            items={[
              `Layout: ${table.posture}`,
              `${table.width}×${table.height}`,
              `Library ${columns} columns`,
              `Discover ${table.discover.columns.comfortable}`,
              `Pages ${table.studio.pagesColumns}`,
              `Studio nav: ${table.studio.nav}`,
              `Director: ${table.studio.director.placement}${table.studio.director.widthPx ? ` ${table.studio.director.widthPx}px` : ''}`,
              `Inspector: ${table.library.inspector.mode}`
            ]}
          />
        </header>

        <Section id="cards" title="Cards">
          <ComicCard
            variant="hero"
            title="The Harbor Lights"
            description="A lighthouse keeper's daughter finds the lamp has been signalling someone across the bay for forty years."
            onOpen={() => undefined}
            read={{ onClick: () => undefined, label: 'Read' }}
            open={{ onClick: () => undefined, label: 'Continue' }}
            cover={{ sources: { src: coverArt(210, 'Harbor') }, priority: true }}
            artColor="hsl(210 45% 55%)"
            meta={['Comic', '6 pages', 'Book 2:3', 'PG', 'EN · ES']}
            chip={<RatingBadge rating="PG" onArt />}
          />
          <CardGrid
            items={COMICS.slice(0, 2)}
            getKey={(c) => c.id}
            columns={Math.min(2, columns)}
            label="Card variants"
            renderItem={(c, i) =>
              i === 0 ? (
                <ComicCard
                  variant="owner"
                  title={c.title}
                  onOpen={() => undefined}
                  read={{ onClick: () => undefined }}
                  open={{ onClick: () => undefined }}
                  cover={{ sources: { src: coverArt(c.hue, 'Mine') } }}
                  artColor={`hsl(${c.hue} 45% 55%)`}
                  meta={['Comic', `${c.drawn} of ${c.pages} pages`, c.edited]}
                  progress={{ value: c.drawn, max: c.pages }}
                  chip={<span className={ON_ART_LABEL}>{`Drawing ${c.drawn}/${c.pages}`}</span>}
                />
              ) : (
                <ComicCard
                  variant="public"
                  title={c.title}
                  href="#fox"
                  read={{ href: '#fox' }}
                  cover={{ path: 'pub/AbCdEfGhIjKlMnOpQrStUv/cover.webp', resolve: () => coverArt(c.hue, 'Public'), publication: true }}
                  creator={c.creator}
                  meta={['Picture book', `${c.pages} pp`, 'EN ES +2']}
                  chip={<RatingBadge rating={c.rating} onArt />}
                />
              )
            }
          />
          <ComicCard variant="row" title="Rain on Seventh Street" onOpen={() => undefined} cover={{ sources: { src: coverArt(260, 'Noir') } }} meta={['Comic', '2 of 8 pages', 'Edited Oct 30']} read={{ onClick: () => undefined }} />
          <div className="max-w-[220px]">
            <ComicCard variant="end" title="Low Tide" href="#tide" read={{ href: '#tide', label: 'Read next' }} cover={{ sources: { src: coverArt(185, 'Next') } }} creator="@reef" headingLevel={3} />
          </div>
        </Section>

        <Section id="grid" title="Your comics">
          <div className="flex min-w-0 flex-col gap-3">
            <SearchField value={query} onChange={setQuery} label="Search your comics" placeholder="Search your comics" shortcut resultText={countWords(shown.length, 'comic')} />
            <FilterChips value={kind} onChange={setKind} options={KINDS} label="Filter comics" countNoun="comics" scroll />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => (selection.selecting ? selection.clear() : selection.start())}>
                {selection.selecting ? 'Done' : 'Select'}
              </Button>
            </div>
          </div>
          {selection.selecting ? (
            <SelectionBar
              count={selection.count}
              noun="comic"
              placement={table.library.selectionBar}
              total={shown.length}
              onSelectAll={selection.selectAll}
              onClear={selection.clear}
              actions={
                <>
                  <Button variant="outline" size="sm" disabled={!selection.count}>
                    <Download aria-hidden="true" />
                    Download
                  </Button>
                  <Button variant="outline" size="sm" disabled={!selection.count}>
                    <Trash2 aria-hidden="true" />
                    Delete
                  </Button>
                </>
              }
            />
          ) : null}
          {shown.length ? (
            <CardGrid
              items={shown}
              getKey={(c) => c.id}
              columns={columns}
              label="Your comics"
              selecting={selection.selecting}
              onExitSelection={selection.clear}
              renderItem={(c) => (
                <ComicCard
                  title={c.title}
                  onOpen={() => (selection.selecting ? selection.toggle(c.id) : undefined)}
                  selected={selection.isSelected(c.id)}
                  cover={{ sources: { src: coverArt(c.hue, c.title.split(' ')[0]) } }}
                  artColor={`hsl(${c.hue} 45% 55%)`}
                  meta={['Comic', `${c.drawn} of ${c.pages} pages`, c.edited]}
                  read={selection.selecting ? undefined : { onClick: () => undefined }}
                  corner={
                    selection.selecting ? (
                      <label className="grid size-8 cursor-pointer place-items-center rounded-full bg-[var(--ds-raised)] coarse:size-11">
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.title}`}
                          checked={selection.isSelected(c.id)}
                          onChange={() => selection.toggle(c.id)}
                          className="size-4 accent-[var(--ds-ink)]"
                        />
                      </label>
                    ) : null
                  }
                />
              )}
            />
          ) : (
            <StatusBanner tone="waiting" title={`No comics match "${query}"`} action={{ label: 'Clear search and filters', onClick: () => (setQuery(''), setKind('all')) }} />
          )}
        </Section>

        <Section id="shelves" title="Shelves">
          <Shelf
            title="New this week"
            items={COMICS}
            getKey={(c) => c.id}
            cardPx={table.discover.shelfCardPx}
            seeAll={{ href: '#all' }}
            renderItem={(c) => (
              <ComicCard
                variant="rail"
                title={c.title}
                href={`#${c.id}`}
                cover={{ path: `pub/AbCdEfGhIjKlMnOp${c.id.padEnd(6, 'x').slice(0, 6)}/cover.webp`, resolve: () => coverArt(c.hue, ''), publication: true }}
                creator={c.creator}
                chip={<RatingBadge rating={c.rating} onArt />}
              />
            )}
          />
          <Shelf title="Keep reading" items={[]} getKey={() => 'x'} cardPx={table.discover.shelfCardPx} loading renderItem={() => null} skeletonCount={3} />
          <Shelf title="Trending" items={[]} getKey={() => 'x'} cardPx={table.discover.shelfCardPx} error onRetry={() => undefined} renderItem={() => null} />
          <Shelf title="Hidden when empty" items={[]} getKey={() => 'x'} cardPx={table.discover.shelfCardPx} renderItem={() => null} />
        </Section>

        <Section id="status" title="Status">
          <div className="flex min-w-0 flex-wrap gap-2">
            {PILLS.map(([state, label, short]) => (
              <StatusPill key={state} state={state} label={label} short={short} compact={table.width < 360} onOpen={state === 'waiting' ? () => undefined : undefined} />
            ))}
          </div>
          <StatusBanner tone="offline" size="line">
            Reading and editing still work. Drawing waits for the connection.
          </StatusBanner>
          <StatusBanner tone="error" title="Couldn't load Trending" action={{ label: 'Retry', onClick: () => undefined }} />
          <StatusBanner tone="healthy" title="Exported 12 pages" />
        </Section>

        <Section id="navigation" title="Navigation">
          <NavTrack items={PLACES} current={place} onSelect={setPlace} label="Comic places" dense={table.width < 400} />
          <div className="h-72 min-w-0 overflow-hidden rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)]">
            <Sidebar
              label="Studio navigation"
              header={<p className="m-0 truncate text-[13px] font-semibold">The Harbor Lights</p>}
              groups={[
                { id: 'places', content: <NavTrack items={PLACES} current={place} onSelect={setPlace} label="Places" orientation="vertical" /> },
                {
                  id: 'pages',
                  title: 'Pages',
                  content: <NavTrack items={[{ id: 'board', label: 'Board' }, { id: 'lettering', label: 'Lettering' }, { id: 'assets', label: 'Assets', icon: <ImageIcon /> }]} current="board" onSelect={() => undefined} label="Pages views" orientation="vertical" />
                }
              ]}
              footer={<Row title="Notifications" leading={<Bell aria-hidden="true" className="size-4" />} meta={['2 new']} />}
            />
          </div>
        </Section>

        <Section id="tiles" title="Tiles and presets">
          <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
            <MediaTile src={coverArt(30, 'Page 1')} artKey="u/demo/p/1.webp" label="Page 1, version 3" caption="Page 1 · v3" onOpen={() => undefined} chip={<span className={ON_ART_LABEL}>Out of date</span>} />
            <MediaTile src={coverArt(200, 'Page 2')} artKey="u/demo/p/2.webp" label="Page 2, selected" caption="Page 2" selected selecting onOpen={() => undefined} />
            <MediaTile artColor="hsl(320 40% 60%)" label="Page 3, not drawn yet" caption="Page 3 · not drawn" onOpen={() => undefined} />
            <MediaTile aspect="2 / 3">
              <CoverImage publication path="u/someone/draft.webp" sources={{ src: coverArt(0, 'Draft') }} />
            </MediaTile>
          </div>
          <PresetGrid
            label="Art style"
            value={style}
            onChange={setStyle}
            columns={Math.min(4, Math.max(2, columns))}
            options={[
              { value: 'ink', label: 'Noir ink', description: 'Bold blacks, one spot colour', art: <img alt="" src={coverArt(250, 'Ink')} className="h-full w-full object-cover" /> },
              { value: 'water', label: 'Watercolour', description: 'Soft washes, paper grain', art: <img alt="" src={coverArt(190, 'Wash')} className="h-full w-full object-cover" /> },
              { value: 'manga', label: 'Manga', description: 'Screentone, speed lines', art: <img alt="" src={coverArt(0, 'Tone')} className="h-full w-full object-cover" /> },
              { value: 'pop', label: 'Pop art', description: 'Ben-Day dots', art: <img alt="" src={coverArt(50, 'Pop')} className="h-full w-full object-cover" />, disabled: true }
            ]}
          />
        </Section>

        <Section id="viewer" title="Viewer and panes">
          <div className="h-80 min-w-0">
            <Lightbox
              label="Assets viewer"
              index={lightbox}
              onIndexChange={setLightbox}
              items={COMICS.slice(0, 4).map((c, i) => ({ key: `u/demo/${c.id}.webp`, src: coverArt(c.hue, `Page ${i + 1}`), alt: `${c.title}, page ${i + 1}`, caption: `Page ${i + 1} · v1` }))}
            />
          </div>
          <div className="h-48 min-w-0 overflow-hidden rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)]">
            <SplitPane
              label="Resize the Director"
              coarse={ff.coarse}
              minPx={120}
              start={<div className="flex-1 p-3 text-[13px] text-[var(--ds-muted)]">Director</div>}
              end={<div className="flex-1 p-3 text-[13px] text-[var(--ds-muted)]">Pages</div>}
            />
          </div>
          <Inspector layout={{ mode: 'segment', widthPx: null, scrim: false, detents: null }} open={false} onClose={() => undefined} label="Comic details" />
        </Section>

        <Section id="facts" title="Rows and facts">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {COMICS.slice(0, 3).map((c) => (
              <Row
                key={c.id}
                as="li"
                title={c.title}
                titleAs="h3"
                onOpen={() => undefined}
                leading={<span className="block h-16 w-12 overflow-hidden rounded-[var(--ds-radius-sm)]"><CoverImage sources={{ src: coverArt(c.hue, '') }} sizes="48px" aspect="3 / 4" /></span>}
                meta={['Comic', `${c.drawn} of ${c.pages} pages`, c.edited]}
                trailing={<RatingBadge rating={c.rating} />}
              />
            ))}
          </ul>
          <div className="flex min-w-0 flex-wrap gap-2">
            <SourceBadge licence="OFL" source="Google Fonts" href="https://openfontlicense.org" />
            <SourceBadge licence="CC0" source="Freesound" />
            <SourceBadge source="Made by DreamStream" />
          </div>
        </Section>
      </div>
    </main>
  );
}

const scene: QaAppScene = { id: 'ds-content', title: 'Content kit: cards, covers, grids, shelves, filters, selection, status, navigation, presets, viewer (DS-R1)', Scene };
export default scene;
