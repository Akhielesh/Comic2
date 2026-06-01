import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowDown, ArrowRight, FileText, ClipboardList, Palette, Boxes,
  BookImage, LayoutGrid, Eye, Wand2, Download, Sparkles, Cpu, ImageIcon, Type,
  Zap, KeyRound, ShieldCheck, GitBranch
} from 'lucide-react';

interface HowItWorksProps {
  onBack: () => void;
  onGetStarted?: () => void;
}

/** Scroll-reveal: adds `is-visible` to elements with `.hiw-reveal` as they enter the viewport. */
const useRevealRoot = () => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('.hiw-reveal'));
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return rootRef;
};

type Stage = {
  n: number;
  key: string;
  title: string;
  tag: string;
  Icon: React.ComponentType<{ className?: string }>;
  color: string;     // node bg
  accent: string;    // section accent
  blurb: string;
  inputs: string[];
  outputs: string[];
  tip: string;
};

const STAGES: Stage[] = [
  {
    n: 1, key: 'script', title: 'Script', tag: 'Understand the story', Icon: FileText,
    color: 'bg-brand-blue', accent: 'text-brand-blue',
    blurb: 'You paste plain prose — no screenplay formatting required. The AI reads it and breaks it into ordered scenes, each grounded in your actual words (it never invents characters or events).',
    inputs: ['Your story text'],
    outputs: ['Ordered scenes', 'Per-scene synopsis, setting & characters'],
    tip: 'Analysis happens once here. Every later stage reuses these scenes.'
  },
  {
    n: 2, key: 'plan', title: 'Plan', tag: 'Shape the book', Icon: ClipboardList,
    color: 'bg-amber-500', accent: 'text-amber-600',
    blurb: 'You set the format (US comic, manga, webtoon…) and page count. This is the blueprint — it drives the cost estimate, how scenes spread across pages, and the panel density suggested later.',
    inputs: ['Scenes', 'Word count'],
    outputs: ['Format & page count', 'Feasibility + cost estimate'],
    tip: 'Nothing is drawn yet — it’s the plan the next stages follow.'
  },
  {
    n: 3, key: 'style', title: 'Style', tag: 'Find the look', Icon: Palette,
    color: 'bg-brand-red', accent: 'text-brand-red',
    blurb: 'Generate multiple style samples at once, each grounded in your real opening scene’s mood and setting (no named characters — it’s a look-and-feel study). Pick the one that fits your story.',
    inputs: ['Opening scene mood/setting', 'Your style choices'],
    outputs: ['A locked art style', 'A style reference image'],
    tip: 'The style is rendering only — later stages never let it override your subject.'
  },
  {
    n: 4, key: 'world', title: 'World', tag: 'Cast & props', Icon: Boxes,
    color: 'bg-emerald-600', accent: 'text-emerald-600',
    blurb: 'The AI extracts every character, key item and location from your story and auto-fills structured fields (role, outfit, palette, materials, lighting…). “Generate All” renders consistent reference art for each.',
    inputs: ['Scenes', 'Chosen style'],
    outputs: ['Characters, items & locations', 'Reference images per entity'],
    tip: 'These references anchor every panel so your cast stays consistent.'
  },
  {
    n: 5, key: 'cover', title: 'Cover', tag: 'First impression', Icon: BookImage,
    color: 'bg-fuchsia-600', accent: 'text-fuchsia-600',
    blurb: 'Design a cover with clean, text-safe zones and a strong focal composition — built from your world and style, readable even at thumbnail size.',
    inputs: ['Style', 'Core cast & key props'],
    outputs: ['A cover image'],
    tip: 'Composition first; titles overlay cleanly on top.'
  },
  {
    n: 6, key: 'layout', title: 'Layout', tag: 'Panel geometry', Icon: LayoutGrid,
    color: 'bg-indigo-600', accent: 'text-indigo-600',
    blurb: 'Choose a page grid. Each template defines real per-panel shapes — a wide establishing strip, square insets, tall action panels — and each panel is now generated at its own slot’s aspect ratio.',
    inputs: ['Format', 'Scene/panel count'],
    outputs: ['A page grid template', 'Per-panel aspect ratios'],
    tip: 'The layout — not the style stage — decides each panel’s shape.'
  },
  {
    n: 7, key: 'preview', title: 'Preview', tag: 'Edit the plan', Icon: Eye,
    color: 'bg-cyan-600', accent: 'text-cyan-600',
    blurb: 'See the full plan — prompts, dialogue, cost — before anything renders. Tweak freely until it’s right, then commit.',
    inputs: ['Everything above'],
    outputs: ['An approved, editable plan'],
    tip: 'Your last checkpoint before generation spends anything.'
  },
  {
    n: 8, key: 'build', title: 'Build', tag: 'Draw the panels', Icon: Wand2,
    color: 'bg-orange-600', accent: 'text-orange-600',
    blurb: 'Each scene is broken into panels with an explicit focal subject, shot type, camera angle and composition — then drawn in your style, using your world references so the subject stays on-story and characters stay consistent.',
    inputs: ['Scenes', 'World references', 'Style', 'Layout slots'],
    outputs: ['Finished, dialogued panels'],
    tip: 'Subject & story lead the prompt; style is rendering only.'
  },
  {
    n: 9, key: 'export', title: 'Export', tag: 'Ship it', Icon: Download,
    color: 'bg-slate-800', accent: 'text-slate-700',
    blurb: 'Read it in the built-in reader, then export your finished comic — pages, dialogue and all.',
    inputs: ['Finished pages'],
    outputs: ['A shareable comic'],
    tip: 'Your story, drawn and done.'
  }
];

const Chip: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border-2 border-black ${className}`}>{children}</span>
);

export const HowItWorks: React.FC<HowItWorksProps> = ({ onBack, onGetStarted }) => {
  const rootRef = useRevealRoot();
  const [activeStage, setActiveStage] = useState<string>('script');

  const scrollToStage = useCallback((key: string) => {
    setActiveStage(key);
    document.getElementById(`hiw-stage-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  return (
    <div ref={rootRef} className="relative min-h-screen bg-gradient-to-b from-brand-blue/10 via-white to-amber-50 overflow-hidden">
      {/* Drifting background blobs */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="hiw-drift absolute -top-24 -left-24 w-96 h-96 rounded-full bg-brand-blue/20 blur-3xl" />
        <div className="hiw-drift absolute top-1/3 -right-24 w-96 h-96 rounded-full bg-brand-red/15 blur-3xl" style={{ animationDelay: '-4s' }} />
        <div className="hiw-drift absolute bottom-0 left-1/3 w-96 h-96 rounded-full bg-amber-300/20 blur-3xl" style={{ animationDelay: '-8s' }} />
      </div>

      <div className="sticky top-0 z-30 backdrop-blur-sm bg-white/60 border-b-2 border-black/10">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-1 text-sm font-bold text-slate-600 hover:text-black transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <span className="text-slate-300">|</span>
          <span className="font-display text-lg">How It Works</span>
        </div>
      </div>

      {/* HERO */}
      <section className="max-w-5xl mx-auto px-4 pt-16 pb-10 text-center">
        <div className="hiw-reveal">
          <Chip className="bg-brand-yellow text-black inline-flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> The full pipeline, explained</Chip>
          <h1 className="mt-4 text-5xl md:text-7xl font-display leading-[1.05]">
            From a <span className="hiw-gradient-text">paragraph</span><br />to a finished <span className="hiw-gradient-text">comic</span>.
          </h1>
          <p className="mt-5 max-w-2xl mx-auto font-comic text-lg text-slate-600">
            Nine stages turn your plain-prose story into drawn, dialogued pages — each one grounded in your actual words, your chosen style, and your own AI keys. Here’s exactly what happens, and how your story flows through it.
          </p>
          <div className="mt-7 flex items-center justify-center gap-3">
            <button onClick={() => scrollToStage('script')} className="px-5 py-2.5 rounded-full border-4 border-black bg-brand-blue text-white font-display shadow-comic hover:translate-x-[2px] hover:translate-y-[2px] transition-transform">
              Walk me through it
            </button>
            {onGetStarted && (
              <button onClick={onGetStarted} className="px-5 py-2.5 rounded-full border-4 border-black bg-white font-display shadow-comic hover:translate-x-[2px] hover:translate-y-[2px] transition-transform">
                Start a comic
              </button>
            )}
          </div>
          <div className="mt-10 flex justify-center text-slate-400 hiw-bounce"><ArrowDown className="w-6 h-6" /></div>
        </div>
      </section>

      {/* PIPELINE OVERVIEW */}
      <section className="max-w-6xl mx-auto px-4 py-8">
        <div className="hiw-reveal bg-white/80 border-4 border-black rounded-2xl shadow-comic p-6">
          <div className="text-center mb-6">
            <h2 className="font-display text-2xl">The pipeline at a glance</h2>
            <p className="text-sm text-slate-500 font-comic">Content flows left → right. Tap a stage to jump to it.</p>
          </div>
          {/* Flowing connector (desktop) */}
          <div className="relative hidden md:block">
            <svg className="absolute left-0 right-0 top-7 w-full h-3 -z-0" preserveAspectRatio="none" viewBox="0 0 1000 12">
              <line x1="0" y1="6" x2="1000" y2="6" stroke="#0f172a" strokeOpacity="0.12" strokeWidth="8" strokeLinecap="round" />
              <line x1="0" y1="6" x2="1000" y2="6" stroke="#2867ff" strokeWidth="3" strokeLinecap="round" className="hiw-flow-dash" />
            </svg>
            <div className="relative grid grid-cols-9 gap-1">
              {STAGES.map((s) => (
                <button key={s.key} onClick={() => scrollToStage(s.key)} className="group flex flex-col items-center gap-2">
                  <span className="relative inline-flex">
                    <span className={`absolute inset-0 rounded-full ${s.color} opacity-30 hiw-pulse-ring`} />
                    <span className={`relative w-14 h-14 rounded-full ${s.color} text-white border-4 border-black flex items-center justify-center shadow-comic group-hover:scale-110 transition-transform`}>
                      <s.Icon className="w-6 h-6" />
                    </span>
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wide">{s.title}</span>
                </button>
              ))}
            </div>
          </div>
          {/* Mobile: vertical list */}
          <div className="md:hidden flex flex-col gap-2">
            {STAGES.map((s) => (
              <button key={s.key} onClick={() => scrollToStage(s.key)} className="flex items-center gap-3 text-left">
                <span className={`w-10 h-10 rounded-full ${s.color} text-white border-2 border-black flex items-center justify-center shrink-0`}><s.Icon className="w-5 h-5" /></span>
                <span className="font-bold">{s.n}. {s.title}</span>
                <span className="text-xs text-slate-500 ml-auto">{s.tag}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* STAGE DETAIL SECTIONS */}
      <section className="max-w-5xl mx-auto px-4 py-10 space-y-8">
        {STAGES.map((s, i) => (
          <div
            key={s.key}
            id={`hiw-stage-${s.key}`}
            className={`hiw-reveal grid md:grid-cols-[auto,1fr] gap-5 bg-white border-4 border-black rounded-2xl shadow-comic p-6 ${activeStage === s.key ? 'ring-4 ring-brand-yellow' : ''}`}
            onMouseEnter={() => setActiveStage(s.key)}
            style={{ transitionDelay: `${(i % 3) * 60}ms` }}
          >
            <div className="flex md:flex-col items-center md:items-start gap-3">
              <div className={`relative w-16 h-16 rounded-2xl ${s.color} text-white border-4 border-black flex items-center justify-center shadow-comic shrink-0`}>
                <s.Icon className="w-8 h-8" />
                <span className="absolute -top-3 -left-3 w-7 h-7 rounded-full bg-white text-black border-2 border-black text-xs font-display flex items-center justify-center">{s.n}</span>
              </div>
              <Chip className={`bg-slate-100 ${s.accent} whitespace-nowrap`}>{s.tag}</Chip>
            </div>

            <div className="min-w-0">
              <h3 className="font-display text-2xl">{s.title}</h3>
              <p className="mt-1 font-comic text-slate-700">{s.blurb}</p>

              <div className="mt-4 grid sm:grid-cols-2 gap-3">
                <div className="rounded-xl border-2 border-black/10 bg-slate-50 p-3">
                  <div className="text-[10px] font-bold uppercase text-slate-400 flex items-center gap-1"><ArrowRight className="w-3 h-3" /> Flows in</div>
                  <ul className="mt-1 space-y-0.5">
                    {s.inputs.map((x) => <li key={x} className="text-sm flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-slate-400" />{x}</li>)}
                  </ul>
                </div>
                <div className="rounded-xl border-2 border-black/10 bg-emerald-50 p-3">
                  <div className="text-[10px] font-bold uppercase text-emerald-500 flex items-center gap-1"><ArrowRight className="w-3 h-3" /> Flows out</div>
                  <ul className="mt-1 space-y-0.5">
                    {s.outputs.map((x) => <li key={x} className="text-sm flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{x}</li>)}
                  </ul>
                </div>
              </div>

              <div className={`mt-3 text-sm font-bold ${s.accent} flex items-start gap-1.5`}>
                <Sparkles className="w-4 h-4 mt-0.5 shrink-0" /> {s.tip}
              </div>

              {i < STAGES.length - 1 && (
                <div className="mt-4 flex items-center gap-2 text-slate-400">
                  <div className="h-px flex-1 bg-slate-200" />
                  <span className="text-[11px] font-bold uppercase">feeds {STAGES[i + 1].title}</span>
                  <ArrowDown className="w-4 h-4" />
                </div>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* CONTENT THREAD */}
      <section className="max-w-5xl mx-auto px-4 py-10">
        <div className="hiw-reveal bg-black text-white rounded-2xl border-4 border-black shadow-comic p-7 overflow-hidden relative">
          <div className="hiw-sheen pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-white/10 blur-xl" />
          <h2 className="font-display text-2xl flex items-center gap-2"><GitBranch className="w-6 h-6 text-brand-yellow" /> How your content threads through</h2>
          <p className="mt-1 text-slate-300 font-comic text-sm">One continuous thread of meaning — never re-invented between stages.</p>
          <div className="mt-5 flex flex-wrap items-center gap-2 text-sm font-bold">
            {['Your prose', 'Scenes', 'World entities (+refs)', 'Panels (subject + shot + angle)', 'Pages (per-slot shapes)', 'Exported comic'].map((node, idx, arr) => (
              <React.Fragment key={node}>
                <span className="px-3 py-1.5 rounded-full border-2 border-white/30 bg-white/5">{node}</span>
                {idx < arr.length - 1 && <ArrowRight className="w-4 h-4 text-brand-yellow" />}
              </React.Fragment>
            ))}
          </div>
          <p className="mt-5 text-sm text-slate-300">
            Grounding is enforced at every hop: scenes quote your script, world entities must appear in it, and each panel leads with a concrete <span className="text-white font-bold">focal subject</span> from the synopsis — so a story about boats renders boats, not generic heroes.
          </p>
        </div>
      </section>

      {/* MODEL LAYER */}
      <section className="max-w-5xl mx-auto px-4 py-10">
        <div className="hiw-reveal bg-white border-4 border-black rounded-2xl shadow-comic p-7">
          <h2 className="font-display text-2xl flex items-center gap-2"><Cpu className="w-6 h-6 text-brand-blue" /> The model layer — your keys, your sources</h2>
          <p className="mt-1 font-comic text-slate-600 text-sm">
            Every generation runs on <span className="font-bold">your own API keys</span> (BYOK). You choose which model from which source powers text and image — independently.
          </p>

          <div className="mt-5 grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border-2 border-black bg-blue-50 p-4">
              <div className="font-bold flex items-center gap-2"><Type className="w-4 h-4" /> Text (story brain)</div>
              <p className="text-sm text-slate-600 mt-1">Script analysis, world extraction, panel breakdown, dialogue.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Chip className="bg-white">OpenRouter</Chip>
                <Chip className="bg-white">NVIDIA Build</Chip>
                <Chip className="bg-white">Gemini</Chip>
              </div>
            </div>
            <div className="rounded-xl border-2 border-black bg-rose-50 p-4">
              <div className="font-bold flex items-center gap-2"><ImageIcon className="w-4 h-4" /> Image (the art)</div>
              <p className="text-sm text-slate-600 mt-1">Style boards, world refs, cover, and every panel.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Chip className="bg-white">OpenRouter</Chip>
                <Chip className="bg-white">Gemini</Chip>
                <Chip className="bg-white">Flux</Chip>
              </div>
            </div>
          </div>

          <div className="mt-4 grid sm:grid-cols-3 gap-3">
            <div className="rounded-xl border-2 border-black/10 bg-slate-50 p-3">
              <div className="font-bold text-sm flex items-center gap-1.5"><GitBranch className="w-4 h-4 text-brand-blue" /> Mix & match</div>
              <p className="text-xs text-slate-600 mt-1">Text from NVIDIA, image from OpenRouter? Fine — usage shows each source separately.</p>
            </div>
            <div className="rounded-xl border-2 border-black/10 bg-slate-50 p-3">
              <div className="font-bold text-sm flex items-center gap-1.5"><Zap className="w-4 h-4 text-amber-500" /> Truly-free bypass</div>
              <p className="text-xs text-slate-600 mt-1">Models that cost $0 (<span className="font-mono">:free</span>) skip your per-key spend cap — paid models still respect it.</p>
            </div>
            <div className="rounded-xl border-2 border-black/10 bg-slate-50 p-3">
              <div className="font-bold text-sm flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-emerald-600" /> Verified, not guessed</div>
              <p className="text-xs text-slate-600 mt-1">Free/paid and usage are reconciled against each source’s live API — no made-up numbers.</p>
            </div>
          </div>
          <div className="mt-4 text-xs text-slate-500 flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5" /> Add keys in Settings → API Configuration. Free tiers (OpenRouter, NVIDIA Build) get you started at no cost.
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-4 py-14 text-center">
        <div className="hiw-reveal">
          <h2 className="font-display text-4xl">Ready to draw your story?</h2>
          <p className="mt-2 font-comic text-slate-600">You bring the words. The pipeline brings the panels.</p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <button onClick={onGetStarted || onBack} className="px-6 py-3 rounded-full border-4 border-black bg-brand-red text-white font-display text-lg shadow-comic hover:translate-x-[2px] hover:translate-y-[2px] transition-transform">
              Start a comic
            </button>
            <button onClick={() => scrollToStage('script')} className="px-6 py-3 rounded-full border-4 border-black bg-white font-display text-lg shadow-comic hover:translate-x-[2px] hover:translate-y-[2px] transition-transform">
              Re-read the flow
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default HowItWorks;
