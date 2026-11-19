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
  AlertTriangle,
  BookOpen,
  Palette,
  Image as ImageIcon
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
import { buttonClasses } from '../ds/Button';
import {
  CHIP,
  CHIP_VARIANT,
  FIELD,
  FOCUS_RING,
  HAIRLINE,
  HEADING,
  INK,
  MUTED,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  SHADOW_SOFT,
  STATUS_SURFACE,
  TONE_TEXT,
  Z
} from '../chat/studioDesign';

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

// The Atlas card: an opaque surface with a hairline, the soft shadow and the panel radius.
const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`bg-[var(--ds-surface)] p-5 ${RADIUS_PANEL} ${HAIRLINE} ${SHADOW_SOFT} ${className}`}>{children}</div>
);

// Every step's action here asks the image model for work (it spends), so the primary is the ink fill, never a hue.
const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', ...props }) => (
  <button {...props} className={buttonClasses({ size: 'lg', className })} />
);

const GhostButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', ...props }) => (
  <button {...props} className={buttonClasses({ variant: 'outline', className })} />
);

const SECTION_HEADING = `mb-1 text-[length:var(--ds-text-lg)] font-semibold leading-6 ${INK}`;
const LEAD = `text-sm ${MUTED}`;
const TEXT_AREA = `${FIELD} block w-full text-sm`;
const SELECT = `${FIELD} mt-1 block h-10 px-2 text-sm`;
const DROP_ZONE = `border border-dashed border-[var(--ds-control-border)] p-4 ${RADIUS_PANEL}`;
const PICTURE = `${RADIUS_CONTROL} ${HAIRLINE}`;
const NOTE_BOX = `bg-[var(--ds-well)] ${RADIUS_PANEL} ${HAIRLINE}`;
/** A choice among several (the stepper, the layout presets): the chosen one on the ink edge and the active step. */
const CHOSEN = 'border-[var(--ds-ink)] bg-[var(--ds-active)] hover:bg-[var(--ds-active)]';
const choice = (on: boolean) =>
  `flex flex-col items-start p-3 text-left ${RADIUS_PANEL} border transition-colors duration-[var(--ds-motion-medium)] text-[var(--ds-ink)] ${FOCUS_RING} ${on ? CHOSEN : 'border-[var(--ds-hairline)] bg-[var(--ds-raised)] hover:bg-[var(--ds-hover)]'}`;

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
        baseImageId: res.imageId,
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
      // Saving strips URLs when an imageId exists: restore the matching ID too, or
      // clear it for an older URL-only original so reload cannot resurrect the edit.
      p.id === activePage.id ? { ...p, imageId: p.baseImageId, imageUrl: p.baseImageUrl, edits: [] } : p
    );
    patch({ pages: updatedPages });
  };

  // ---- Render ----------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] text-[var(--ds-ink)]">
      <header className={`sticky top-0 ${Z.header} border-b border-[var(--ds-hairline)] bg-[var(--ds-surface)]`}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <GhostButton onClick={onBack} className="px-3">
            <ArrowLeft className="w-4 h-4" /> Back
          </GhostButton>
          <h1 className={`flex items-center gap-2 text-xl ${HEADING}`}>
            <Sparkles className="size-5" aria-hidden="true" /> Page Studio
          </h1>
          <span className={`min-w-0 truncate text-sm ${MUTED}`}>· {project.name}</span>
        </div>
        {/* Stage stepper */}
        <div className="max-w-5xl mx-auto px-4 pb-3 flex flex-wrap gap-2">
          {STAGES.map((s, i) => (
            <button
              key={s.id}
              onClick={() => goto(s.id)}
              aria-current={stage === s.id ? 'step' : undefined}
              className={buttonClasses({ variant: 'outline', size: 'sm', className: stage === s.id ? CHOSEN : '' })}
            >
              {i + 1}. {s.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        {error && (
          <div className={`flex items-start gap-2 border p-3 ${RADIUS_PANEL} ${STATUS_SURFACE.error}`}>
            <AlertTriangle className={`mt-0.5 size-5 shrink-0 ${TONE_TEXT.danger}`} aria-hidden="true" />
            <p className={`min-w-0 text-sm [overflow-wrap:anywhere] ${INK}`}>{error}</p>
          </div>
        )}
        {busy && (
          <div className={`flex items-center gap-2 border p-3 ${RADIUS_PANEL} ${STATUS_SURFACE.active} ${INK}`}>
            <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <p className="text-sm font-semibold">{busy}</p>
          </div>
        )}

        {/* STORY */}
        {stage === 'brief' && (
          <Card>
            <h2 className={SECTION_HEADING}>What's this page about?</h2>
            <p className={`mb-3 ${LEAD}`}>
              Describe the scene(s) you want on this page — the action, characters and beats. The generator turns this
              into one full comic page.
            </p>
            <textarea
              value={ps.brief}
              onChange={(e) => patch({ brief: e.target.value })}
              rows={6}
              placeholder="e.g. Detective Mara kicks open the warehouse door, three thugs scatter, she fires a warning shot — end on a close-up of her determined face."
              className={`${TEXT_AREA} p-3`}
            />
            <div className="flex flex-wrap items-end gap-4 mt-4">
              <label className={`text-sm font-medium ${INK}`}>
                Page shape
                <select
                  value={ps.aspectRatio}
                  onChange={(e) => patch({ aspectRatio: e.target.value as AspectRatio })}
                  className={SELECT}
                >
                  {ASPECT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className={`text-sm font-medium ${INK}`}>
                Resolution
                <select
                  value={ps.resolution}
                  onChange={(e) => patch({ resolution: e.target.value as ImageResolution })}
                  className={SELECT}
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
            <h2 className={SECTION_HEADING}>Pin down the art style</h2>
            <p className={`mb-4 ${LEAD}`}>
              Upload a reference image of a style you love, or describe it in words. We'll read it back so you can
              confirm the direction — and optionally run a quick sample.
            </p>

            <div className="grid md:grid-cols-2 gap-4">
              {/* Image path */}
              <div className={DROP_ZONE}>
                <div className="mb-2 flex items-center gap-2 font-semibold"><ImageUp className="size-4" aria-hidden="true" /> Reference image</div>
                {ps.style.referenceDataUrl ? (
                  <img src={ps.style.referenceDataUrl} alt="style reference" className={`mb-2 h-40 w-full object-cover ${PICTURE}`} />
                ) : (
                  <div className={`flex h-40 items-center justify-center text-sm ${MUTED}`}>No image yet</div>
                )}
                <input ref={styleFileRef} type="file" accept="image/*" hidden onChange={(e) => onStyleFile(e.target.files?.[0])} />
                <GhostButton onClick={() => styleFileRef.current?.click()} className="w-full">
                  {ps.style.referenceDataUrl ? 'Replace image' : 'Upload image'}
                </GhostButton>
              </div>

              {/* Text path */}
              <div className={DROP_ZONE}>
                <div className="mb-2 flex items-center gap-2 font-semibold"><Type className="size-4" aria-hidden="true" /> Style in words</div>
                <textarea
                  value={ps.style.prompt || ''}
                  onChange={(e) => patchStyle({ prompt: e.target.value })}
                  rows={5}
                  placeholder="e.g. Gritty 90s noir comic, heavy ink shadows, muted desaturated palette, rough hand-lettered captions."
                  className={`${TEXT_AREA} p-2`}
                />
              </div>
            </div>

            {/* Once a reading exists, "Yes, this is the direction" is the one primary; reading again is quiet */}
            <div className="flex flex-wrap gap-2 mt-4">
              {ps.style.brief ? (
                <GhostButton
                  onClick={runStyleAnalysis}
                  disabled={!!busy || (!ps.style.referenceDataUrl && !ps.style.prompt?.trim())}
                >
                  <Wand2 className="w-4 h-4" /> Read again
                </GhostButton>
              ) : (
                <PrimaryButton
                  onClick={runStyleAnalysis}
                  disabled={!!busy || (!ps.style.referenceDataUrl && !ps.style.prompt?.trim())}
                >
                  <Wand2 className="w-4 h-4" /> Understand this style
                </PrimaryButton>
              )}
            </div>

            {ps.style.brief && (
              <div className={`mt-4 p-4 ${NOTE_BOX}`}>
                <div className={SECTION_HEADING}>Here's the style we understood:</div>
                <p className={`text-sm ${INK}`}>{ps.style.brief}</p>
                {!!ps.style.tags?.length && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {ps.style.tags.map((t) => (
                      <span key={t} className={`${CHIP} ${CHIP_VARIANT.outline}`}>{t}</span>
                    ))}
                  </div>
                )}
                {ps.style.sampleDataUrl && (
                  <img src={ps.style.sampleDataUrl} alt="style sample" className={`mt-3 w-48 ${PICTURE}`} />
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
            <h2 className={SECTION_HEADING}>How should the page be laid out?</h2>
            <p className={`mb-4 ${LEAD}`}>
              Pick a preset, or upload a comic page whose panel layout / caption style you want us to match exactly.
            </p>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
              {LAYOUT_PRESETS.map((preset) => {
                const selected = ps.layout.source === 'preset' && ps.layout.presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    onClick={() => patchLayout({ source: 'preset', presetId: preset.id, referenceDataUrl: undefined, brief: undefined })}
                    aria-pressed={selected}
                    className={choice(selected)}
                  >
                    <div className="flex items-center gap-2 font-semibold"><LayoutGrid className="size-4" aria-hidden="true" /> {preset.label}</div>
                    <p className={`mt-1 text-xs ${MUTED}`}>{preset.description}</p>
                  </button>
                );
              })}
              <button
                onClick={() => patchLayout({ source: 'auto', presetId: undefined, referenceDataUrl: undefined, brief: undefined })}
                aria-pressed={ps.layout.source === 'auto'}
                className={choice(ps.layout.source === 'auto')}
              >
                <div className="flex items-center gap-2 font-semibold"><Sparkles className="size-4" aria-hidden="true" /> Let AI decide</div>
                <p className={`mt-1 text-xs ${MUTED}`}>Best layout for the story beats.</p>
              </button>
            </div>

            <div className={DROP_ZONE}>
              <div className="mb-2 flex items-center gap-2 font-semibold"><ImageUp className="size-4" aria-hidden="true" /> Match a reference page</div>
              <div className="flex flex-col sm:flex-row gap-3">
                {ps.layout.referenceDataUrl ? (
                  <img src={ps.layout.referenceDataUrl} alt="layout reference" className={`h-52 w-40 object-cover ${PICTURE}`} />
                ) : (
                  <div className={`flex h-52 w-40 items-center justify-center bg-[var(--ds-well-strong)] text-sm ${MUTED} ${PICTURE}`}>No page</div>
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
                    <p className={`p-2 text-sm ${NOTE_BOX}`}>{ps.layout.brief}</p>
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
            <h2 className={SECTION_HEADING}>Generate the full page</h2>
            <p className={`mb-4 ${LEAD}`}>
              One model call renders the whole page — panels, gutters and lettering baked in. Edit it afterward.
            </p>
            <ul className={`mb-4 space-y-1 text-sm [overflow-wrap:anywhere] ${INK}`}>
              <li className="flex items-start gap-2"><BookOpen size={16} className={`mt-0.5 shrink-0 ${MUTED}`} aria-hidden /><span className="min-w-0"><b>Story:</b> {ps.brief.slice(0, 140) || '—'}</span></li>
              <li className="flex items-start gap-2"><Palette size={16} className={`mt-0.5 shrink-0 ${MUTED}`} aria-hidden /><span className="min-w-0"><b>Style:</b> {ps.style.brief ? `${ps.style.brief.slice(0, 120)}…` : ps.style.prompt || 'Auto'}</span></li>
              <li className="flex items-start gap-2"><LayoutGrid size={16} className={`mt-0.5 shrink-0 ${MUTED}`} aria-hidden /><span className="min-w-0"><b>Layout:</b> {ps.layout.brief || (layoutFragment ?? 'AI decides')}</span></li>
              <li className="flex items-start gap-2"><ImageIcon size={16} className={`mt-0.5 shrink-0 ${MUTED}`} aria-hidden /><span className="min-w-0"><b>Output:</b> {ps.aspectRatio} · {ps.resolution}</span></li>
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
                  <img src={activePage.imageUrl} alt="generated page" className={`w-full ${PICTURE}`} />
                ) : (
                  <div className={`flex aspect-[3/4] items-center justify-center text-center ${MUTED}`}>No page yet — generate one first.</div>
                )}
              </Card>
              {ps.pages.length > 1 && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {ps.pages.map((p, i) => (
                    <button
                      key={p.id}
                      onClick={() => patch({ activePageId: p.id })}
                      aria-current={p.id === activePage?.id ? 'true' : undefined}
                      className={`h-18 w-14 overflow-hidden ${RADIUS_CONTROL} ${p.id === activePage?.id ? 'border-2 border-[var(--ds-ink)]' : 'border border-[var(--ds-hairline)]'} ${FOCUS_RING}`}
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
                <h2 className={`flex items-center gap-2 ${SECTION_HEADING}`}><Wand2 className="size-4" aria-hidden="true" /> Edit this page</h2>
                <p className={`mb-3 ${LEAD}`}>Describe a targeted change. An image-editing model patches just that, keeping the rest intact.</p>
                <textarea
                  value={editInstruction}
                  onChange={(e) => setEditInstruction(e.target.value)}
                  rows={3}
                  placeholder="e.g. Change the caption in panel 1 to 'MIDNIGHT'. Make the sky stormy. Add a speech bubble saying 'Freeze!'"
                  className={`${TEXT_AREA} mb-2 p-2`}
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
                  <h3 className={`font-semibold ${INK}`}>Edit history</h3>
                  <GhostButton onClick={runGenerate} disabled={!!busy} className="h-8 px-2.5 text-xs" title="Generate a fresh page from the same brief">
                    <Sparkles className="size-3.5" /> New page
                  </GhostButton>
                </div>
                {activePage?.edits.length ? (
                  <ol className={`list-inside list-decimal space-y-1 text-sm [overflow-wrap:anywhere] ${INK}`}>
                    {activePage.edits.map((ed) => <li key={ed.id}>{ed.instruction}</li>)}
                  </ol>
                ) : (
                  <p className={`text-sm ${MUTED}`}>No edits yet.</p>
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
