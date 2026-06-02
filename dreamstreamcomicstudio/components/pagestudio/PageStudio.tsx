import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ImageUp,
  Loader2,
  Sparkles,
  Type,
  Wand2,
  LayoutGrid,
  RefreshCw,
  AlertTriangle
} from 'lucide-react';
import { Project, PageStudioState, PageStudioPage, AspectRatio, ImageResolution } from '../../types';
import {
  analyzeStyle,
  analyzeLayout,
  generatePage,
  editPage,
  composePagePrompt,
  LAYOUT_PRESETS
} from '../../services/pageStudio';
import { ApiError } from '../../services/apiClient';

type Stage = NonNullable<PageStudioState['stage']>;

interface PageStudioProps {
  project: Project;
  onUpdate: (updater: (prev: Project) => Partial<Project>) => void;
  onBack: () => void;
}

const DEFAULT_STATE: PageStudioState = {
  brief: '',
  style: { source: 'text' },
  layout: { source: 'auto' },
  aspectRatio: '3:4',
  resolution: '2K',
  pages: [],
  stage: 'brief'
};

const ASPECT_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: '3:4', label: 'Portrait page (3:4)' },
  { value: '2:3', label: 'Tall page (2:3)' },
  { value: '1:1', label: 'Square (1:1)' },
  { value: '4:3', label: 'Landscape (4:3)' },
  { value: '9:16', label: 'Vertical / webtoon (9:16)' }
];

const RESOLUTION_OPTIONS: { value: ImageResolution; label: string }[] = [
  { value: '1K', label: '1K — fast' },
  { value: '2K', label: '2K — balanced' },
  { value: '4K', label: '4K — full sheet' }
];

const STAGES: { id: Stage; label: string }[] = [
  { id: 'brief', label: 'Story' },
  { id: 'style', label: 'Style' },
  { id: 'layout', label: 'Layout' },
  { id: 'generate', label: 'Generate' },
  { id: 'edit', label: 'Edit' }
];

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const errMessage = (e: unknown) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.';

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`bg-white border-2 border-black rounded-xl shadow-comic p-5 ${className}`}>{children}</div>
);

const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', ...props }) => (
  <button
    {...props}
    className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg font-display tracking-wide bg-brand-blue text-white border-2 border-black shadow-comic disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5 transition-transform ${className}`}
  />
);

const GhostButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', ...props }) => (
  <button
    {...props}
    className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold bg-white text-black border-2 border-black hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${className}`}
  />
);

export const PageStudio: React.FC<PageStudioProps> = ({ project, onUpdate, onBack }) => {
  const ps: PageStudioState = useMemo(
    () => ({ ...DEFAULT_STATE, ...(project.state.pageStudio || {}) }),
    [project.state.pageStudio]
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const styleFileRef = useRef<HTMLInputElement>(null);
  const layoutFileRef = useRef<HTMLInputElement>(null);
  const [editInstruction, setEditInstruction] = useState('');

  const patch = (next: Partial<PageStudioState>) => {
    onUpdate((prev) => ({
      state: { ...prev.state, pipelineMode: 'pagestudio', pageStudio: { ...DEFAULT_STATE, ...(prev.state.pageStudio || {}), ...next } }
    }));
  };
  const patchStyle = (next: Partial<PageStudioState['style']>) => patch({ style: { ...ps.style, ...next } });
  const patchLayout = (next: Partial<PageStudioState['layout']>) => patch({ layout: { ...ps.layout, ...next } });

  const stage: Stage = ps.stage || 'brief';
  const goto = (s: Stage) => patch({ stage: s });

  const activePage = ps.pages.find((p) => p.id === ps.activePageId) || ps.pages[ps.pages.length - 1];

  // ---- Style intake ----------------------------------------------------------
  const onStyleFile = async (file?: File) => {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      patchStyle({ source: 'image', referenceDataUrl: dataUrl, confirmed: false, brief: undefined, tags: [] });
    } catch (e) {
      setError(errMessage(e));
    }
  };

  const runStyleAnalysis = async () => {
    setError(null);
    setBusy('Understanding the style…');
    try {
      const res = await analyzeStyle({
        images: ps.style.referenceDataUrl ? [ps.style.referenceDataUrl] : [],
        textHint: ps.style.prompt,
        projectId: project.id
      });
      patchStyle({ brief: res.brief, tags: res.tags, confirmed: false });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const runStyleSample = async () => {
    setError(null);
    setBusy('Generating a quick style sample…');
    try {
      const prompt = composePagePrompt({
        brief: ps.brief || 'A single character standing, three-quarter view, neutral background.',
        styleBrief: ps.style.brief,
        stylePrompt: ps.style.prompt,
        styleTags: ps.style.tags,
        layoutFragment: 'a single full-page splash illustration with no internal panel borders'
      });
      const res = await generatePage({
        prompt,
        aspectRatio: ps.aspectRatio,
        resolution: '1K',
        referenceImages: ps.style.referenceDataUrl ? [ps.style.referenceDataUrl] : [],
        projectId: project.id,
        storage: 'test'
      });
      patchStyle({ sampleDataUrl: res.dataUrl || res.imageUrl });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // ---- Layout intake ---------------------------------------------------------
  const onLayoutFile = async (file?: File) => {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      patchLayout({ source: 'reference', referenceDataUrl: dataUrl, brief: undefined });
    } catch (e) {
      setError(errMessage(e));
    }
  };

  const runLayoutAnalysis = async () => {
    if (!ps.layout.referenceDataUrl) return;
    setError(null);
    setBusy('Reading the page layout…');
    try {
      const res = await analyzeLayout({ images: [ps.layout.referenceDataUrl], projectId: project.id });
      patchLayout({ brief: res.description });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // ---- Generate full page ----------------------------------------------------
  const layoutFragment = ps.layout.source === 'preset'
    ? LAYOUT_PRESETS.find((p) => p.id === ps.layout.presetId)?.promptFragment
    : undefined;

  const runGenerate = async () => {
    setError(null);
    setBusy('Generating your full comic page…');
    try {
      const prompt = composePagePrompt({
        brief: ps.brief,
        styleBrief: ps.style.brief,
        stylePrompt: ps.style.prompt,
        styleTags: ps.style.tags,
        layoutBrief: ps.layout.brief,
        layoutFragment
      });
      const refs = [ps.style.referenceDataUrl, ps.layout.referenceDataUrl].filter(Boolean) as string[];
      const res = await generatePage({
        prompt,
        aspectRatio: ps.aspectRatio,
        resolution: ps.resolution,
        referenceImages: refs,
        projectId: project.id,
        storage: 'project'
      });
      const url = res.imageUrl || res.dataUrl;
      const page: PageStudioPage = {
        id: `page_${Date.now()}`,
        prompt,
        imageUrl: url,
        imageId: res.imageId,
        baseImageUrl: url,
        edits: [],
        createdAt: Date.now()
      };
      patch({ pages: [...ps.pages, page], activePageId: page.id, stage: 'edit' });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // ---- Edit (image-editing model patches) ------------------------------------
  const runEdit = async () => {
    if (!activePage?.imageUrl || !editInstruction.trim()) return;
    setError(null);
    setBusy('Applying your edit…');
    try {
      const res = await editPage({
        instruction: editInstruction,
        currentImage: activePage.imageUrl,
        extraReferences: [ps.style.referenceDataUrl].filter(Boolean) as string[],
        aspectRatio: ps.aspectRatio,
        resolution: ps.resolution,
        projectId: project.id
      });
      const newUrl = res.imageUrl || res.dataUrl;
      const updatedPages = ps.pages.map((p) =>
        p.id === activePage.id
          ? {
              ...p,
              imageUrl: newUrl,
              imageId: res.imageId || p.imageId,
              edits: [
                ...p.edits,
                { id: `edit_${Date.now()}`, instruction: editInstruction.trim(), imageUrl: newUrl, imageId: res.imageId, createdAt: Date.now() }
              ]
            }
          : p
      );
      patch({ pages: updatedPages });
      setEditInstruction('');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const revertEdits = () => {
    if (!activePage) return;
    const updatedPages = ps.pages.map((p) =>
      p.id === activePage.id ? { ...p, imageUrl: p.baseImageUrl, edits: [] } : p
    );
    patch({ pages: updatedPages });
  };

  // ---- Render ----------------------------------------------------------------
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 bg-brand-yellow border-b-2 border-black">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <GhostButton onClick={onBack} className="!px-3">
            <ArrowLeft className="w-4 h-4" /> Back
          </GhostButton>
          <h1 className="font-display text-2xl tracking-wide flex items-center gap-2">
            <Sparkles className="w-5 h-5" /> Page Studio
          </h1>
          <span className="text-sm text-black/60 truncate">· {project.name}</span>
        </div>
        {/* Stage stepper */}
        <div className="max-w-5xl mx-auto px-4 pb-3 flex flex-wrap gap-2">
          {STAGES.map((s, i) => (
            <button
              key={s.id}
              onClick={() => goto(s.id)}
              className={`px-3 py-1 rounded-full border-2 border-black text-sm font-semibold transition-colors ${
                stage === s.id ? 'bg-brand-blue text-white' : 'bg-white hover:bg-slate-100'
              }`}
            >
              {i + 1}. {s.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        {error && (
          <div className="flex items-start gap-2 bg-red-50 border-2 border-red-500 text-red-800 rounded-lg p-3">
            <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}
        {busy && (
          <div className="flex items-center gap-2 bg-blue-50 border-2 border-brand-blue text-brand-blue rounded-lg p-3">
            <Loader2 className="w-5 h-5 animate-spin" />
            <p className="text-sm font-semibold">{busy}</p>
          </div>
        )}

        {/* STORY */}
        {stage === 'brief' && (
          <Card>
            <h2 className="font-display text-xl mb-1">What's this page about?</h2>
            <p className="text-sm text-slate-600 mb-3">
              Describe the scene(s) you want on this page — the action, characters and beats. The generator turns this
              into one full comic page.
            </p>
            <textarea
              value={ps.brief}
              onChange={(e) => patch({ brief: e.target.value })}
              rows={6}
              placeholder="e.g. Detective Mara kicks open the warehouse door, three thugs scatter, she fires a warning shot — end on a close-up of her determined face."
              className="w-full border-2 border-black rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-brand-blue"
            />
            <div className="flex flex-wrap items-end gap-4 mt-4">
              <label className="text-sm font-semibold">
                Page shape
                <select
                  value={ps.aspectRatio}
                  onChange={(e) => patch({ aspectRatio: e.target.value as AspectRatio })}
                  className="block mt-1 border-2 border-black rounded-lg p-2"
                >
                  {ASPECT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-semibold">
                Resolution
                <select
                  value={ps.resolution}
                  onChange={(e) => patch({ resolution: e.target.value as ImageResolution })}
                  className="block mt-1 border-2 border-black rounded-lg p-2"
                >
                  {RESOLUTION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <div className="ml-auto">
                <PrimaryButton onClick={() => goto('style')} disabled={!ps.brief.trim()}>
                  Next: Style →
                </PrimaryButton>
              </div>
            </div>
          </Card>
        )}

        {/* STYLE */}
        {stage === 'style' && (
          <Card>
            <h2 className="font-display text-xl mb-1">Pin down the art style</h2>
            <p className="text-sm text-slate-600 mb-4">
              Upload a reference image of a style you love, or describe it in words. We'll read it back so you can
              confirm the direction — and optionally run a quick sample.
            </p>

            <div className="grid md:grid-cols-2 gap-4">
              {/* Image path */}
              <div className="border-2 border-dashed border-black rounded-lg p-4">
                <div className="flex items-center gap-2 font-semibold mb-2"><ImageUp className="w-4 h-4" /> Reference image</div>
                {ps.style.referenceDataUrl ? (
                  <img src={ps.style.referenceDataUrl} alt="style reference" className="w-full h-40 object-cover rounded-md border-2 border-black mb-2" />
                ) : (
                  <div className="h-40 flex items-center justify-center text-slate-400 text-sm">No image yet</div>
                )}
                <input ref={styleFileRef} type="file" accept="image/*" hidden onChange={(e) => onStyleFile(e.target.files?.[0])} />
                <GhostButton onClick={() => styleFileRef.current?.click()} className="w-full">
                  {ps.style.referenceDataUrl ? 'Replace image' : 'Upload image'}
                </GhostButton>
              </div>

              {/* Text path */}
              <div className="border-2 border-dashed border-black rounded-lg p-4">
                <div className="flex items-center gap-2 font-semibold mb-2"><Type className="w-4 h-4" /> Style in words</div>
                <textarea
                  value={ps.style.prompt || ''}
                  onChange={(e) => patchStyle({ prompt: e.target.value })}
                  rows={5}
                  placeholder="e.g. Gritty 90s noir comic, heavy ink shadows, muted desaturated palette, rough hand-lettered captions."
                  className="w-full border-2 border-black rounded-lg p-2"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mt-4">
              <PrimaryButton
                onClick={runStyleAnalysis}
                disabled={!!busy || (!ps.style.referenceDataUrl && !ps.style.prompt?.trim())}
              >
                <Wand2 className="w-4 h-4" /> Understand this style
              </PrimaryButton>
            </div>

            {ps.style.brief && (
              <div className="mt-4 bg-amber-50 border-2 border-black rounded-lg p-4">
                <div className="font-display text-lg mb-1">Here's the style we understood:</div>
                <p className="text-sm text-slate-800">{ps.style.brief}</p>
                {!!ps.style.tags?.length && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {ps.style.tags.map((t) => (
                      <span key={t} className="text-xs bg-white border border-black rounded-full px-2 py-0.5">{t}</span>
                    ))}
                  </div>
                )}
                {ps.style.sampleDataUrl && (
                  <img src={ps.style.sampleDataUrl} alt="style sample" className="mt-3 w-48 rounded-md border-2 border-black" />
                )}
                <div className="flex flex-wrap gap-2 mt-3">
                  <GhostButton onClick={runStyleSample} disabled={!!busy}>
                    <RefreshCw className="w-4 h-4" /> Run a sample
                  </GhostButton>
                  <PrimaryButton onClick={() => { patchStyle({ confirmed: true }); goto('layout'); }} disabled={!!busy}>
                    <Check className="w-4 h-4" /> Yes, this is the direction
                  </PrimaryButton>
                </div>
              </div>
            )}
          </Card>
        )}

        {/* LAYOUT */}
        {stage === 'layout' && (
          <Card>
            <h2 className="font-display text-xl mb-1">How should the page be laid out?</h2>
            <p className="text-sm text-slate-600 mb-4">
              Pick a preset, or upload a comic page whose panel layout / caption style you want us to match exactly.
            </p>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
              {LAYOUT_PRESETS.map((preset) => {
                const selected = ps.layout.source === 'preset' && ps.layout.presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    onClick={() => patchLayout({ source: 'preset', presetId: preset.id, referenceDataUrl: undefined, brief: undefined })}
                    className={`text-left p-3 rounded-lg border-2 border-black transition-colors ${selected ? 'bg-brand-blue text-white' : 'bg-white hover:bg-slate-100'}`}
                  >
                    <div className="flex items-center gap-2 font-semibold"><LayoutGrid className="w-4 h-4" /> {preset.label}</div>
                    <p className={`text-xs mt-1 ${selected ? 'text-white/80' : 'text-slate-500'}`}>{preset.description}</p>
                  </button>
                );
              })}
              <button
                onClick={() => patchLayout({ source: 'auto', presetId: undefined, referenceDataUrl: undefined, brief: undefined })}
                className={`text-left p-3 rounded-lg border-2 border-black transition-colors ${ps.layout.source === 'auto' ? 'bg-brand-blue text-white' : 'bg-white hover:bg-slate-100'}`}
              >
                <div className="flex items-center gap-2 font-semibold"><Sparkles className="w-4 h-4" /> Let AI decide</div>
                <p className={`text-xs mt-1 ${ps.layout.source === 'auto' ? 'text-white/80' : 'text-slate-500'}`}>Best layout for the story beats.</p>
              </button>
            </div>

            <div className="border-2 border-dashed border-black rounded-lg p-4">
              <div className="flex items-center gap-2 font-semibold mb-2"><ImageUp className="w-4 h-4" /> Match a reference page</div>
              <div className="flex flex-col sm:flex-row gap-3">
                {ps.layout.referenceDataUrl ? (
                  <img src={ps.layout.referenceDataUrl} alt="layout reference" className="w-40 h-52 object-cover rounded-md border-2 border-black" />
                ) : (
                  <div className="w-40 h-52 flex items-center justify-center text-slate-400 text-sm border-2 border-black rounded-md">No page</div>
                )}
                <div className="flex-1 space-y-2">
                  <input ref={layoutFileRef} type="file" accept="image/*" hidden onChange={(e) => onLayoutFile(e.target.files?.[0])} />
                  <GhostButton onClick={() => layoutFileRef.current?.click()}>Upload a comic page</GhostButton>
                  {ps.layout.referenceDataUrl && (
                    <GhostButton onClick={runLayoutAnalysis} disabled={!!busy}>
                      <Wand2 className="w-4 h-4" /> Extract its layout
                    </GhostButton>
                  )}
                  {ps.layout.brief && (
                    <p className="text-sm bg-amber-50 border-2 border-black rounded-lg p-2">{ps.layout.brief}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end mt-4">
              <PrimaryButton onClick={() => goto('generate')}>Next: Generate →</PrimaryButton>
            </div>
          </Card>
        )}

        {/* GENERATE */}
        {stage === 'generate' && (
          <Card>
            <h2 className="font-display text-xl mb-1">Generate the full page</h2>
            <p className="text-sm text-slate-600 mb-4">
              One model call renders the whole page — panels, gutters and lettering baked in. Edit it afterward.
            </p>
            <ul className="text-sm text-slate-700 space-y-1 mb-4">
              <li>📖 <b>Story:</b> {ps.brief.slice(0, 140) || '—'}</li>
              <li>🎨 <b>Style:</b> {ps.style.brief ? `${ps.style.brief.slice(0, 120)}…` : ps.style.prompt || 'Auto'}</li>
              <li>🔲 <b>Layout:</b> {ps.layout.brief || (layoutFragment ?? 'AI decides')}</li>
              <li>🖼️ <b>Output:</b> {ps.aspectRatio} · {ps.resolution}</li>
            </ul>
            <PrimaryButton onClick={runGenerate} disabled={!!busy || !ps.brief.trim()}>
              <Sparkles className="w-4 h-4" /> Generate page
            </PrimaryButton>
          </Card>
        )}

        {/* EDIT */}
        {stage === 'edit' && (
          <div className="grid lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2">
              <Card>
                {activePage?.imageUrl ? (
                  <img src={activePage.imageUrl} alt="generated page" className="w-full rounded-lg border-2 border-black" />
                ) : (
                  <div className="aspect-[3/4] flex items-center justify-center text-slate-400">No page yet — generate one first.</div>
                )}
              </Card>
              {ps.pages.length > 1 && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {ps.pages.map((p, i) => (
                    <button
                      key={p.id}
                      onClick={() => patch({ activePageId: p.id })}
                      className={`w-14 h-18 rounded-md border-2 overflow-hidden ${p.id === activePage?.id ? 'border-brand-blue' : 'border-black'}`}
                      title={`Page ${i + 1}`}
                    >
                      {p.imageUrl && <img src={p.imageUrl} alt={`page ${i + 1}`} className="w-full h-full object-cover" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-4">
              <Card>
                <h2 className="font-display text-lg mb-1 flex items-center gap-2"><Wand2 className="w-4 h-4" /> Edit this page</h2>
                <p className="text-sm text-slate-600 mb-3">Describe a targeted change. An image-editing model patches just that, keeping the rest intact.</p>
                <textarea
                  value={editInstruction}
                  onChange={(e) => setEditInstruction(e.target.value)}
                  rows={3}
                  placeholder="e.g. Change the caption in panel 1 to 'MIDNIGHT'. Make the sky stormy. Add a speech bubble saying 'Freeze!'"
                  className="w-full border-2 border-black rounded-lg p-2 mb-2"
                />
                <div className="flex gap-2">
                  <PrimaryButton onClick={runEdit} disabled={!!busy || !editInstruction.trim() || !activePage?.imageUrl} className="flex-1">
                    Apply edit
                  </PrimaryButton>
                  {!!activePage?.edits.length && (
                    <GhostButton onClick={revertEdits} disabled={!!busy} title="Revert to the original generated page">
                      <RefreshCw className="w-4 h-4" />
                    </GhostButton>
                  )}
                </div>
              </Card>

              <Card>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Edit history</h3>
                  <GhostButton onClick={runGenerate} disabled={!!busy} className="!px-2 !py-1 text-xs" title="Generate a fresh page from the same brief">
                    <Sparkles className="w-3 h-3" /> New page
                  </GhostButton>
                </div>
                {activePage?.edits.length ? (
                  <ol className="text-sm space-y-1 list-decimal list-inside text-slate-700">
                    {activePage.edits.map((ed) => <li key={ed.id}>{ed.instruction}</li>)}
                  </ol>
                ) : (
                  <p className="text-sm text-slate-400">No edits yet.</p>
                )}
              </Card>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default PageStudio;
