#!/usr/bin/env node
// Scaffold a new chat-artifact widget that is compliant with the calm-studio
// quality standard from the first keystroke (docs/COMPONENT_QUALITY.md), then
// print the exact wiring snippets for the four registration points so nothing is
// forgotten. The generated component passes `npm run lint:widgets` as-is.
//
//   npm run new:widget -- --name SprintBurndown --type sprint_burndown \
//       --title "Sprint burndown (ideal vs actual · scope changes)" \
//       --category "Data & charts" [--wide]
//
// Only the component FILE is written (always safe — it's new). The 4 edits to
// shared files are printed as copy-paste blocks rather than auto-applied, so a
// drifting anchor can never corrupt ChatArtifacts.tsx / ComponentGallery.tsx.

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = join(ROOT, 'components', 'chat', 'artifacts');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  console.error('Usage: npm run new:widget -- --name <PascalName> --type <snake_type> --title "<gallery title>" [--category "<Gallery category>"] [--wide]\n');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const name = typeof args.name === 'string' ? args.name : '';
const type = typeof args.type === 'string' ? args.type : '';
const title = typeof args.title === 'string' ? args.title : '';
const category = typeof args.category === 'string' ? args.category : 'Data & charts';
const wide = !!args.wide;

if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) die('--name must be PascalCase, e.g. SprintBurndown');
if (!/^[a-z][a-z0-9_]+$/.test(type)) die('--type must be snake_case, e.g. sprint_burndown');
if (!title) die('--title is required (the human label shown in the Gallery)');

const ArtifactType = `${name}Artifact`;
const componentPath = join(ARTIFACTS, `${name}.tsx`);
if (existsSync(componentPath)) die(`${name}.tsx already exists — pick another name or delete it first.`);

const component = `import React from 'react';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// ${name} — TODO: one-line purpose of this widget.
//  • detailed — TODO: describe the full view.
//  • compact  — a glance card: title + the first couple of facts.
//
// Calm-studio glass: Surface shell, --ds-* tokens, tabular-nums. Must satisfy
// docs/COMPONENT_QUALITY.md (checked by \`npm run lint:widgets\`).

// TODO: move this interface into apiTypes.ts as part of wiring (see the checklist
// printed by \`npm run new:widget\`). It lives here for now so the file typechecks
// and renders standalone before it's registered.
export interface ${ArtifactType} {
  title: string;
  subtitle?: string;
  items: { label: string; value: string }[];
  /** Let the model pre-pick the glance vs full layout. */
  density?: 'compact' | 'detailed';
}

export const ${name}: React.FC<{ data: ${ArtifactType} }> = ({ data }) => {
  const compact = useCompact();
  const items = data.items ?? [];
  if (!data.title && items.length === 0) return null;

  const header = (
    <div className="min-w-0">
      <SurfaceTitle>{data.title}</SurfaceTitle>
      {data.subtitle && <SurfaceSubtitle>{data.subtitle}</SurfaceSubtitle>}
    </div>
  );

  // ── Compact: a real glance card — title + the two most important facts. ──────
  if (compact) {
    return (
      <Surface header={header}>
        <dl className="grid grid-cols-2 gap-2 px-3 pb-3 pt-0.5">
          {items.slice(0, 2).map((it, i) => (
            <div key={i} className="min-w-0">
              <dt className="truncate text-[11px] text-[var(--ds-muted)]">{it.label}</dt>
              <dd className="truncate text-sm font-semibold tabular-nums text-[var(--ds-ink)]">{it.value}</dd>
            </div>
          ))}
        </dl>
      </Surface>
    );
  }

  // ── Detailed: the full breakdown. ────────────────────────────────────────────
  return (
    <Surface header={header}>
      <dl className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {items.map((it, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 px-3 py-2">
            <dt className="min-w-0 truncate text-[13px] text-[var(--ds-muted)]">{it.label}</dt>
            <dd className="shrink-0 text-sm font-semibold tabular-nums text-[var(--ds-ink)]">{it.value}</dd>
          </div>
        ))}
      </dl>
    </Surface>
  );
};
`;

if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
writeFileSync(componentPath, component, 'utf8');

const widePatch = wide
  ? `\n5. components/chat/artifacts/ChatArtifacts.tsx — add '${type}' to WIDE_IN_GALLERY (roomier gallery column).`
  : '';

console.log(`
✓ Created components/chat/artifacts/${name}.tsx (compliant, density-aware).

Now wire it up (copy-paste). The gallery + quality gates fail until steps 1–4 are done:

1. apiTypes.ts — move the interface out of ${name}.tsx and export it here:

   export interface ${ArtifactType} {
     title: string;
     subtitle?: string;
     items: { label: string; value: string }[];
     density?: 'compact' | 'detailed';
   }
   // (then delete the interface + the TODO from ${name}.tsx and import the type instead)

2. components/chat/artifacts/ChatArtifacts.tsx
   • import:   import { ${name} } from './${name}';
   • import type { ${ArtifactType} } from '../../../apiTypes';
   • ARTIFACT_RENDERERS:
       ${type}: (d, k) => <${name} key={k} data={d as ${ArtifactType}} />,
   • DENSITY_AWARE_TYPES set: add '${type}',

3. components/chat/ComponentGallery.tsx
   • import:   import { ${name} } from './artifacts/${name}';
   • import type { ${ArtifactType} } from '../../apiTypes';
   • demo + GALLERY_DEMOS entry:
       const ${name[0].toLowerCase() + name.slice(1)}Demo: ${ArtifactType} = {
         title: 'TODO realistic title',
         subtitle: 'TODO',
         items: [{ label: 'TODO', value: 'TODO' }, { label: 'TODO', value: 'TODO' }]
       };
       // …add to GALLERY_DEMOS:
       { title: ${JSON.stringify(title)}, type: '${type}', category: ${JSON.stringify(category)}, node: <${name} data={${name[0].toLowerCase() + name.slice(1)}Demo} /> },

4. (only if a model should emit it) add a tool in server/src/ai/tools/registry.ts
   and a catalog entry in toolCatalog.ts that returns { type: '${type}', data }.${widePatch}

Then verify:
   npm run lint:widgets   # quality + gallery coverage gates
   npm run typecheck

Standard: docs/COMPONENT_QUALITY.md
`);
