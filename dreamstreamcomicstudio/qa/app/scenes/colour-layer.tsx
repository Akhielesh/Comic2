// QA scene `colour-layer` (CL-6; the scene contract is in qa/app/index.tsx): the colour layer "Ink, Paper & Colour" as
// one specimen (components/ds/specimens/ColourSpecimen.tsx), in the page theme and in a dark panel, so the layout smoke
// and the screenshots see the seven hues, the chart order and ramps, the washes, the studio accents and a comic's tint
// at every viewport, light and dark, with and without the Atlas skin. Sample words only; nothing reaches the network.

import React from 'react';
import { ColourSpecimen } from '../../../components/ds/specimens/ColourSpecimen';
import { PageHeader } from '../../../components/ds';

function Panel({ dark, children }: { dark?: boolean; children: React.ReactNode }) {
  const skin = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-ds-skin') : null;
  return (
    <section
      aria-label={dark ? 'Dark theme' : 'Page theme'}
      className={dark ? 'dark min-w-0 rounded-[var(--ds-radius-panel)] bg-[var(--ds-canvas)] p-3 text-[var(--ds-ink)] sm:p-4' : 'min-w-0'}
      data-ds-skin={dark && skin ? skin : undefined}
    >
      {children}
    </section>
  );
}

function ColourLayerScene() {
  const pageIsDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return (
    <main data-qa-scene="colour-layer" aria-label="Colour layer" className="min-h-[100dvh] min-w-0 bg-[var(--ds-canvas)] px-4 py-6 text-[var(--ds-ink)] sm:px-6">
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-8">
        <PageHeader eyebrow="Design system" title="Ink, Paper & Colour" description="Ink on paper stays the base. Seven hues tell things apart, show data, warm a page, carry a comic's own colour and name the studio you are in." />
        <Panel>
          <ColourSpecimen />
        </Panel>
        {pageIsDark ? null : (
          <Panel dark>
            <ColourSpecimen />
          </Panel>
        )}
      </div>
    </main>
  );
}

export default { id: 'colour-layer', title: 'Colour layer "Ink, Paper & Colour": hues, chart order and ramps, washes, studio accents, a comic’s tint (CL-6)', Scene: ColourLayerScene };
