// QA scene `research` (realworld RW-3; the scene contract is in qa/app/index.tsx): the Comic Studio research sources as
// a creator meets them, on invented fixtures (no real article text, no real people).
//
//   - a research card in a PG-13 comic: pictures show at once; one article and one picture are pinned to the comic
//   - the same card in a G comic: pictures wait behind one "Show pictures" tap
//   - Telugu sources with long titles, at the composer sheet's width (w-[min(28rem,calc(100vw-1.5rem))])
//
// Four articles carry extracts (two lines, then More); six pictures cover CC0, CC0 1.0, public domain (Add image),
// CC BY and CC BY-SA (Reference only). The thumbnails are Commons-shaped URLs, the only ones the shared normalizer
// accepts; the harness answers them with fixture pictures (tests/e2e/helpers/harness.ts), so the tiles are measured
// loaded, and one file named `Missing_…` with a 404, so the empty well stays covered. Nothing spends; the cards run over
// the browser-safe QA controller, and Add context only raises the composer event (nobody listens here).

import React, { useState } from 'react';
import { cn } from '../../../lib/utils';
import { CANVAS_BG, HEADING, INK, MUTED, OVERLINE, SECTION_CARD } from '../../../components/chat/studioDesign';
import type { Card, ComicDoc } from '../../../shared/comic/doc';
import type { ComicResearchResults } from '../../../shared/comic/research';
import { CardRenderer } from '../../../components/comicstudio/conversation/cards/CardRenderer';
import { ResearchPanel } from '../../../components/comicstudio/conversation/ResearchPanel';
import { makeQaDoc } from '../../../components/comicstudio/testing/qaFixtures';
import { useQaController } from '../../../components/comicstudio/testing/qaController';
import type { QaAppScene } from '../index';

const wiki = (host: string, key: string) => `https://${host}/wiki/${encodeURIComponent(key)}`;
const commons = (file: string) => ({
  source: `https://commons.wikimedia.org/wiki/File:${file}`,
  thumbnail: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${file}/320px-${file}`
});

/** Invented articles and pictures in the shape the research route returns (the shared normalizer still runs on them). */
export const researchResults = (): ComicResearchResults => ({
  articles: [
    {
      title: 'Lantern Harbour',
      source: wiki('en.wikipedia.org', 'Lantern_Harbour'),
      description: 'Fictional port town',
      extract: 'Lantern Harbour is an invented port town used in this fixture. Its old quarter climbs a hill above the docks, where fishing boats leave before dawn and a lighthouse keeps the bay in view through the night, season after season.'
    },
    {
      title: 'Harbour lighthouse (fixture)',
      source: wiki('en.wikipedia.org', 'Harbour_lighthouse_(fixture)'),
      extract: 'A stone tower at the end of the long pier. The fixture keeps this text short so it fits in two lines.'
    },
    {
      title: 'Night market of the old quarter',
      source: wiki('en.wikipedia.org', 'Night_market_of_the_old_quarter'),
      extract: 'Stalls open at dusk along the river steps. Lamps, paper kites and bowls of noodles fill the lanes until late, and the last ferry home leaves from the foot of the market at midnight, its bell carrying across the water.'
    },
    {
      title: 'Ferry routes of the bay',
      source: wiki('en.wikipedia.org', 'Ferry_routes_of_the_bay'),
      description: 'Invented routes',
      extract: 'Three small ferries cross the bay in the fixture: one to the island, one to the fort and one along the coast to the next town.'
    }
  ],
  images: [
    { title: 'Harbour at dawn', ...commons('Harbour_at_dawn.jpg'), license: 'CC0', credit: 'Fixture archive' },
    { title: 'Lighthouse from the pier, an unusually long picture title for one line', ...commons('Lighthouse_from_the_pier.jpg'), license: 'Public domain' },
    { title: 'Market lanterns', ...commons('Market_lanterns.jpg'), license: 'CC BY 4.0', credit: 'A fixture photographer with a credit far too long for one line' },
    { title: 'Ferry deck', ...commons('Ferry_deck.jpg'), license: 'CC BY-SA 4.0', credit: 'Fixture photo club' },
    { title: 'Old quarter steps', ...commons('Old_quarter_steps.jpg'), license: 'CC0 1.0' },
    // The one picture Commons cannot serve (the harness gives `Missing_…` files a 404): the calm empty well.
    { title: 'Kites over the river', ...commons('Missing_kites_over_the_river.jpg'), license: 'CC BY-SA 3.0', credit: 'Fixture camera group' }
  ],
  incomplete: false
});

/** Telugu articles with long titles (invented). */
export const teluguResults = (): ComicResearchResults => ({
  articles: [
    {
      title: 'దీపాల రేవు పట్టణం మరియు దాని పాత వీధుల సుదీర్ఘ చరిత్ర',
      source: wiki('te.wikipedia.org', 'దీపాల_రేవు'),
      extract: 'దీపాల రేవు ఈ పరీక్ష కోసం కల్పించిన ఒక రేవు పట్టణం. కొండపై ఉన్న పాత వీధులు, తెల్లవారకముందే బయలుదేరే పడవలు, రాత్రంతా వెలిగే దీపస్తంభం దీని గుర్తులు.'
    },
    {
      title: 'రాత్రి సంత',
      source: wiki('te.wikipedia.org', 'రాత్రి_సంత'),
      extract: 'సాయంత్రం నది మెట్ల వెంట అంగళ్లు తెరుచుకుంటాయి.'
    }
  ],
  images: [],
  incomplete: true
});

const researchCard = (id: string): Extract<Card, { type: 'research' }> => ({ type: 'research', id, query: 'Lantern Harbour at night', results: researchResults() });

/** The heist comic (a general audience, so the chosen rating holds) at a rating; the PG-13 one has one article and one picture pinned. */
const ratedDoc = (rating: 'G' | 'PG-13', pinned: boolean): ComicDoc => {
  const doc = makeQaDoc('heist-12p');
  doc.settings = { ...doc.settings, rating };
  if (pinned) {
    const [article] = researchResults().articles;
    const picture = researchResults().images[0];
    // ComicDoc.research lands with RW-5; the card already reads it defensively (pinnedSourceUrls).
    Object.assign(doc, {
      research: {
        sources: [
          { kind: 'article', title: article.title, url: article.source, lang: 'en', origin: 'pinned' },
          { kind: 'image', title: picture.title, url: picture.source, lang: 'en', license: picture.license, credit: picture.credit, origin: 'pinned' }
        ],
        lookups: 0
      }
    });
  }
  return doc;
};

function CardSection({ id, title, note, rating, pinned }: { id: string; title: string; note: string; rating: 'G' | 'PG-13'; pinned: boolean }) {
  const [init] = useState(() => ({ doc: ratedDoc(rating, pinned), tab: 'story' as const }));
  const studio = useQaController(init);
  const [card] = useState(() => researchCard(`research_${id}`));
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-2">
      <h2 id={`${id}-title`} className={cn('m-0 text-[length:var(--ds-text-base)]', HEADING)}>{title}</h2>
      <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>{note}</p>
      <div className="min-w-0 max-w-[40rem]">{studio.doc && <CardRenderer card={card} studio={studio} />}</div>
    </section>
  );
}

function ResearchScene() {
  return (
    <main aria-labelledby="research-title" className={cn('flex min-h-[100dvh] min-w-0 flex-col', CANVAS_BG, INK)}>
      <header className="mx-auto flex w-full min-w-0 max-w-5xl shrink-0 flex-col gap-1 px-4 pb-2 pt-4 sm:px-6">
        <p className={cn('m-0', OVERLINE)}>Research</p>
        <h1 id="research-title" className={cn('m-0 text-[length:var(--ds-text-lg)]', HEADING)}>
          Research sources
        </h1>
        <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>
          Only public-domain and CC0 pictures can be attached; the others are for reference. Pictures wait for a tap unless the comic is rated PG-13.
        </p>
      </header>
      <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-8 px-4 pb-8 sm:px-6 lg:grid-cols-2">
        <CardSection id="pg13" title="In a PG-13 comic" note="Pictures show at once. One article and one picture are pinned to this comic." rating="PG-13" pinned />
        <CardSection id="kids" title="In a G comic" note="Pictures wait behind one tap." rating="G" pinned={false} />
        <section aria-labelledby="telugu-title" className="flex min-w-0 flex-col gap-2 lg:col-span-2">
          <h2 id="telugu-title" className={cn('m-0 text-[length:var(--ds-text-base)]', HEADING)}>Telugu sources, at the search sheet’s width</h2>
          <p className={cn('m-0 text-[length:var(--ds-text-sm)]', MUTED)}>The language is named in the link only when the source is not English.</p>
          <div className={cn('w-[min(28rem,calc(100vw-1.5rem))] max-w-full', SECTION_CARD)}>
            <ResearchPanel projectId="qa_research" onAdd={() => undefined} suppliedResults={teluguResults()} kidsSafe={false} />
          </div>
        </section>
      </div>
    </main>
  );
}

const scene: QaAppScene = { id: 'research', title: 'Research sources: picture licences, kids comics, pinned, Telugu', Scene: ResearchScene };
export default scene;
