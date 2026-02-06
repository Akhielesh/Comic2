import React, { useState } from 'react';
import { Sparkles, LayoutGrid, PenTool, Image as ImageIcon, Layers, Zap, ArrowRight } from 'lucide-react';
import { Button } from './Button';
import { ModelSelector } from './ModelSelector';
import { FluxKeyInput } from './FluxKeyInput';
import { PRICING_AS_OF, FLASH_IMAGE_STANDARD, FLASH_IMAGE_BATCH, BANANA_PRO_IMAGE_1K, BANANA_PRO_IMAGE_4K, FLASH_LITE_PRICING, FLASH_PRICING } from '../services/pricingConfig';

const COMING_SOON_IMAGE_MODELS = [
  "Flux Dev",
  "Flux Pro",
  "SDXL Turbo",
  "SD3 Large"
];

interface HomePageProps {
  onEnterStudio: () => void;
  onSelectKey: () => void;
}

type StyleCard = {
  title: string;
  image: string;
  caption: string;
};

const STYLE_GALLERY: StyleCard[] = [
  { title: 'Ligne Claire', image: '/assets/home/styles/ligne-claire.jpg', caption: 'Clean lines, flat colors, fast readability.' },
  { title: 'Ink Wash Noir', image: '/assets/home/styles/ink-wash.jpg', caption: 'Ink drama and hand-made texture.' },
  { title: 'Indian Miniature Sci-Fi', image: '/assets/home/styles/indian-miniature.jpg', caption: 'Ornate detail with symbolic color.' },
  { title: 'Woodcut', image: '/assets/home/styles/woodcut.jpg', caption: 'Bold, carved, high-contrast.' },
  { title: 'Dieselpunk', image: '/assets/home/styles/dieselpunk.jpg', caption: 'Art deco machines and retro futures.' },
  { title: 'Surreal Dream', image: '/assets/home/styles/surreal.jpg', caption: 'Symbolic, impossible, dream logic.' },
  { title: 'Brutalist', image: '/assets/home/styles/brutalist.jpg', caption: 'Oppressive geometry, strong contrast.' },
  { title: 'Retrofuturism', image: '/assets/home/styles/retrofuturism.jpg', caption: 'Optimistic vintage tomorrow.' }
];

const DASH_TABS = [
  { id: 'script', label: 'Script', copy: 'Paste or draft a story. We auto-break it into scenes with character and location hooks.' },
  { id: 'style', label: 'Style', copy: 'Select only the looks you want. Generate in parallel with advanced form factors.' },
  { id: 'world', label: 'World', copy: 'Build the cast, props, and locations with instant previews and exportable cards.' },
  { id: 'preview', label: 'Preview', copy: 'Edit every panel prompt and dialogue before images are generated.' }
];

export const HomePage: React.FC<HomePageProps> = ({ onEnterStudio, onSelectKey }) => {
  const [activeTab, setActiveTab] = useState(DASH_TABS[0].id);
  const activeCopy = DASH_TABS.find((tab) => tab.id === activeTab)?.copy || '';

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b-4 border-black">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center text-black font-display text-3xl shadow-comic transform -rotate-3">D</div>
            <div className="flex flex-col">
              <span className="font-display text-3xl tracking-tight text-black leading-none">DreamStream</span>
              <span className="font-comic font-bold text-brand-blue text-sm leading-none">Comic Studio</span>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-3">
            <button onClick={onSelectKey} className="text-xs font-bold font-mono text-slate-500 hover:text-brand-blue underline decoration-2 underline-offset-2">Change API Key</button>
            <Button onClick={onEnterStudio} icon={<ArrowRight size={16} />}>Enter Studio</Button>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,#93c5fd_0%,transparent_55%)]" />
        <div className="absolute -top-20 right-[-10%] w-96 h-96 bg-brand-yellow/30 rounded-full blur-3xl animate-float-slow" />
        <div className="max-w-6xl mx-auto px-6 py-20 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-12 items-center">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 bg-black text-brand-yellow px-4 py-1 rounded-full font-mono text-xs font-bold tracking-widest">
                GEMINI 2.5 POWERED STUDIO
              </div>
              <h1 className="text-5xl md:text-6xl font-display leading-tight text-black">
                Build cinematic comics with continuity, cost controls, and a world builder that never forgets.
              </h1>
              <p className="text-lg font-comic text-slate-700 max-w-xl">
                DreamStream turns scripts into panel plans, generates style previews in parallel, and ships full exports with usage metadata and offline readers.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={onEnterStudio} className="text-xl px-10 py-5" icon={<Sparkles />}>Create Your Comic</Button>
                <Button onClick={onSelectKey} variant="secondary" className="text-xl px-10 py-5">Connect Gemini Key</Button>
              </div>
              <div className="grid gap-3 max-w-md">
                <ModelSelector />
                <FluxKeyInput compact />
              </div>
              <div className="flex flex-wrap gap-4 text-xs font-bold">
                <span className="px-3 py-1 border-2 border-black rounded-full bg-white shadow-comic">Parallel Style Gen</span>
                <span className="px-3 py-1 border-2 border-black rounded-full bg-white shadow-comic">Editable Panel Plan</span>
                <span className="px-3 py-1 border-2 border-black rounded-full bg-white shadow-comic">Full Provenance Export</span>
              </div>
            </div>
            <div className="bg-white border-4 border-black rounded-2xl shadow-comic p-6 space-y-4">
              <div className="flex items-center gap-2 text-sm font-bold">
                <Sparkles size={16} /> Live Studio Snapshot
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 border-2 border-black rounded-lg bg-brand-yellow/40">
                  <div className="text-xs font-bold">Panels Planned</div>
                  <div className="text-2xl font-display">12</div>
                </div>
                <div className="p-3 border-2 border-black rounded-lg bg-brand-blue/20">
                  <div className="text-xs font-bold">Estimated Cost</div>
                  <div className="text-2xl font-display">$0.52</div>
                </div>
                <div className="p-3 border-2 border-black rounded-lg bg-white">
                  <div className="text-xs font-bold">Continuity</div>
                  <div className="text-sm font-comic">Last 2 panels referenced</div>
                </div>
                <div className="p-3 border-2 border-black rounded-lg bg-white">
                  <div className="text-xs font-bold">Exports</div>
                  <div className="text-sm font-comic">ZIP + HTML + PDF</div>
                </div>
              </div>
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div className="h-full w-2/3 bg-brand-yellow animate-progress" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { icon: <PenTool />, title: 'Script to Scenes', copy: 'We extract characters, settings, and visual beats automatically.' },
            { icon: <ImageIcon />, title: 'Parallel Style Builder', copy: 'Generate multiple directions at once and only keep what you love.' },
            { icon: <Layers />, title: 'Panel Plan Preview', copy: 'Edit prompts and dialogue before any image is rendered.' }
          ].map((item) => (
            <div key={item.title} className="bg-white p-6 rounded-xl border-4 border-black shadow-comic">
              <div className="w-12 h-12 bg-brand-yellow rounded-lg border-2 border-black flex items-center justify-center mb-4 text-black">
                {item.icon}
              </div>
              <h3 className="font-display text-xl mb-2">{item.title}</h3>
              <p className="font-comic text-sm text-slate-600">{item.copy}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white border-y-4 border-black py-16">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-3xl font-display">Style Gallery</h2>
              <p className="text-sm font-comic text-slate-600">Stock style references used for preview inspiration.</p>
            </div>
            <div className="hidden md:flex items-center gap-2 text-xs font-bold">
              <Sparkles size={14} /> 10+ curated looks
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {STYLE_GALLERY.map((style) => (
              <div key={style.title} className="group rounded-xl border-4 border-black overflow-hidden shadow-comic bg-slate-50">
                <div className="aspect-[4/5] overflow-hidden">
                  <img src={style.image} alt={style.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                </div>
                <div className="p-4">
                  <div className="font-display text-lg">{style.title}</div>
                  <div className="text-xs font-comic text-slate-600">{style.caption}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 lg:grid-cols-[0.9fr_1.1fr] gap-8">
          <div className="space-y-4">
            <h2 className="text-3xl font-display">Model Pricing Snapshot</h2>
            <p className="text-sm font-comic text-slate-600">Pricing as of {PRICING_AS_OF}. Rates shown per 1K tokens or per image.</p>
            <div className="bg-white border-4 border-black rounded-xl shadow-comic p-4 space-y-3">
              <div className="text-xs font-bold uppercase">Text Models</div>
              <div className="grid grid-cols-3 text-xs font-bold bg-slate-100 border border-black rounded px-2 py-1">
                <div>Model</div>
                <div>Input / Output</div>
                <div className="text-right">Unit</div>
              </div>
              <div className="grid grid-cols-3 text-xs font-bold px-2 py-1">
                <div>Gemini 2.5 Flash-Lite</div>
                <div>${FLASH_LITE_PRICING.inputPer1k.toFixed(4)} / ${FLASH_LITE_PRICING.outputPer1k.toFixed(4)}</div>
                <div className="text-right">per 1K</div>
              </div>
              <div className="grid grid-cols-3 text-xs font-bold px-2 py-1">
                <div>Gemini 2.5 Flash</div>
                <div>${FLASH_PRICING.inputPer1k.toFixed(4)} / ${FLASH_PRICING.outputPer1k.toFixed(4)}</div>
                <div className="text-right">per 1K</div>
              </div>
            </div>
            <div className="bg-white border-4 border-black rounded-xl shadow-comic p-4 space-y-3">
              <div className="text-xs font-bold uppercase">Image Models</div>
              <div className="grid grid-cols-3 text-xs font-bold bg-slate-100 border border-black rounded px-2 py-1">
                <div>Model</div>
                <div>Rate</div>
                <div className="text-right">Unit</div>
              </div>
              <div className="grid grid-cols-3 text-xs font-bold px-2 py-1">
                <div>Flux Schnell (Pixazo Free)</div>
                <div>$0.00</div>
                <div className="text-right">per image</div>
              </div>
              <div className="grid grid-cols-3 text-xs font-bold px-2 py-1">
                <div>Gemini 2.5 Flash Image (Nano Banana)</div>
                <div>${FLASH_IMAGE_STANDARD.toFixed(4)} / ${FLASH_IMAGE_BATCH.toFixed(4)}</div>
                <div className="text-right">per image</div>
              </div>
              <div className="grid grid-cols-3 text-xs font-bold px-2 py-1">
                <div>Gemini 3 Pro Image Preview (Banana Pro)</div>
                <div>${BANANA_PRO_IMAGE_1K.toFixed(3)} / ${BANANA_PRO_IMAGE_4K.toFixed(2)}</div>
                <div className="text-right">1K-2K / 4K</div>
              </div>
              {COMING_SOON_IMAGE_MODELS.map((model) => (
                <div key={model} className="grid grid-cols-3 text-xs font-bold px-2 py-1 text-slate-400">
                  <div>{model}</div>
                  <div>TBD</div>
                  <div className="text-right">coming soon</div>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white border-4 border-black rounded-xl shadow-comic p-6">
            <div className="flex items-center gap-3 mb-4">
              <LayoutGrid className="w-6 h-6" />
              <h3 className="font-display text-2xl">Interactive Studio Flow</h3>
            </div>
            <div className="flex flex-wrap gap-2 mb-4">
              {DASH_TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-1 rounded-full border-2 border-black text-xs font-bold ${activeTab === tab.id ? 'bg-brand-yellow' : 'bg-white'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="border-2 border-black rounded-lg p-4 bg-slate-50 min-h-[140px]">
              <div className="text-xs font-bold uppercase mb-2">{activeTab} Stage</div>
              <p className="text-sm font-comic text-slate-700">{activeCopy}</p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-xs font-bold">
              <div className="p-3 border-2 border-black rounded bg-white">Continuity refs: 2</div>
              <div className="p-3 border-2 border-black rounded bg-white">Stop guard: type STOP</div>
              <div className="p-3 border-2 border-black rounded bg-white">Panel plan editor</div>
              <div className="p-3 border-2 border-black rounded bg-white">ZIP + HTML exports</div>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="bg-brand-yellow rounded-2xl border-4 border-black shadow-comic p-8 flex flex-col md:flex-row items-center justify-between gap-6">
          <div>
            <h2 className="text-3xl font-display">Ready to build your comic universe?</h2>
            <p className="text-sm font-comic text-slate-700">Launch the studio and start with a script or a template.</p>
          </div>
          <div className="flex gap-3">
            <Button onClick={onEnterStudio} className="text-lg px-8" icon={<Zap size={16} />}>Enter Studio</Button>
            <Button onClick={onSelectKey} variant="secondary" className="text-lg px-8">Connect Gemini Key</Button>
          </div>
        </div>
      </section>
    </div>
  );
};
