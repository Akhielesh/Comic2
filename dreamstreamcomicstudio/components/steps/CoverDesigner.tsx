import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Wand2, UploadCloud, RefreshCw, Image as ImageIcon, Sparkles, Check } from 'lucide-react';
import { ComicAgentSettings, ComicState } from '../../types';
import { generateImage } from '../../services/imageService';
import { saveImage, getImageUrl } from '../../services/db';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { classifyStoryMood } from '../../services/storyMood';
import { resolveAspectRatio } from '../../services/imageUtils';
import { suggestCoverConcepts, type CoverConcept } from '../../services/geminiService';
import { COVER_TEMPLATE_DEFINITIONS } from '../../services/coverTemplates';
import { shouldAutoRunComicAgent } from '../../services/comicAgentSettings';

interface CoverDesignerProps {
  state: ComicState;
  projectId: string;
  /** The comic's name — default masthead title rendered on the cover. */
  projectName?: string;
  onUpdate: (updates: Partial<ComicState>) => void;
  onConfirm: () => void;
  agentSettings?: ComicAgentSettings;
}

type CoverCandidate = {
  id: string;
  imageId?: string;
  imageUrl: string;
  prompt: string;
  conceptName: string;
  conceptBrief: string;
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

// When the concept call fails (offline text model etc.), covers still generate from
// three contrasting archetypes — the template library doubles as the safety net.
const FALLBACK_TEMPLATE_IDS = ['hero-splash', 'cinematic-montage', 'retro-pulp'];
const fallbackConcepts = (): CoverConcept[] =>
  COVER_TEMPLATE_DEFINITIONS
    .filter((t) => FALLBACK_TEMPLATE_IDS.includes(t.id))
    .map((t) => ({
      name: t.label,
      brief: `${t.compositionRules} ${t.focalStrategy} ${t.safeZoneNotes} Tone: ${t.toneTags.join(', ')}.`,
      typography: t.typography
    }));

/**
 * Cover stage, "master prompt" flow: the author gives a rough idea (or nothing); the AI
 * designs distinct cover CONCEPTS grounded in the story + locked style, each concept
 * renders as one candidate, and the author picks. No template grid, no identical
 * "Variation A/B/C" rerolls.
 */
export const CoverDesigner: React.FC<CoverDesignerProps> = ({ state, projectId, projectName, onUpdate, onConfirm, agentSettings }) => {
  const [roughIdea, setRoughIdea] = useState(state.coverPrompt || '');
  // The masthead defaults to the comic's actual name (it used to default to the STYLE
  // CATEGORY, which is why covers never carried a real title).
  const [coverTitle, setCoverTitle] = useState(projectName || '');
  const [coverTagline, setCoverTagline] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressLine, setProgressLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);
  const autoCoverStartedRef = useRef(false);
  const autoCoverConfirmedRef = useRef(false);
  const autoRunAgent = shouldAutoRunComicAgent(agentSettings);

  useEffect(() => {
    setRoughIdea(state.coverPrompt || '');
  }, [state.coverPrompt]);

  useEffect(() => {
    autoCoverStartedRef.current = false;
    autoCoverConfirmedRef.current = false;
  }, [projectId]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const base64 = await fileToBase64(files[0]);
    const imageId = await saveImage(base64);
    const imageUrl = (await getImageUrl(imageId)) || base64;
    onUpdate({ coverTemplateImageId: imageId, coverTemplateImageUrl: imageUrl });
  };

  const selectCoverCandidate = useCallback((candidate: CoverCandidate) => {
    onUpdate({
      coverImageId: candidate.imageId,
      coverImageUrl: candidate.imageUrl,
      coverPrompt: roughIdea,
      coverTemplateId: `ai:${candidate.conceptName}`
    });
  }, [onUpdate, roughIdea]);

  const handleDesignCovers = useCallback(async (continueAfterFirst = false) => {
    setIsGenerating(true);
    setError(null);
    setCandidates([]);
    try {
      const scene = state.scenes[0];
      const cast = state.characters.map((c) => c.name).join(', ');
      const styleVariant = state.styleVariants.find((v) => v.id === state.selectedStyleId);
      const referenceIds: string[] = [];
      if (state.coverTemplateImageId) referenceIds.push(state.coverTemplateImageId);
      if (styleVariant?.imageId) referenceIds.push(styleVariant.imageId);
      else if (state.styleImageId) referenceIds.push(state.styleImageId);

      const moodGuidance = (state.storyMood?.promptGuidance)
        || classifyStoryMood(state.script, state.creativeDirection).promptGuidance;

      // 1) Design pass — the AI turns the rough idea + story context into distinct concepts.
      setProgressLine('Designing cover concepts from your story…');
      let concepts: CoverConcept[];
      try {
        concepts = await suggestCoverConcepts({
          script: state.script,
          title: coverTitle || projectName || 'Untitled',
          tagline: coverTagline || undefined,
          roughIdea: roughIdea || undefined,
          stylePrompt: state.stylePrompt || undefined,
          cast: cast || undefined,
          setting: scene?.setting || undefined,
          moodHint: moodGuidance
        });
      } catch (conceptError) {
        console.warn('Cover concept design failed — using archetype fallbacks.', conceptError);
        concepts = fallbackConcepts();
      }

      // 2) Render pass — one cover per concept.
      const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);
      const nextCandidates: CoverCandidate[] = [];
      for (const [index, concept] of concepts.entries()) {
        setProgressLine(`Rendering "${concept.name}" (${index + 1}/${concepts.length})…`);
        const prompt = buildImagePrompt({
          stage: 'cover',
          stylePrompt: state.stylePrompt || 'bold comic style',
          sceneAction: `${concept.brief} Title treatment: ${concept.typography}`,
          setting: scene?.setting || '',
          characters: cast || 'Lead cast',
          moodGuidance,
          extraNotes: roughIdea.trim(),
          projectTitle: coverTitle || projectName || undefined,
          instructions: coverTagline || undefined
        });

        try {
          const generated = await generateImage(
            prompt,
            ratioConfig.modelRatio,
            state.imageResolution,
            referenceIds,
            projectId,
            {
              stage: 'cover',
              cropToRatio: ratioConfig.cropRatio,
              meta: {
                source: { type: 'cover', id: projectId, label: 'Cover' },
                concept: concept.name
              }
            }
          );
          if (generated?.imageUrl) {
            nextCandidates.push({
              id: `${concept.name}-${Date.now()}-${index}`,
              imageId: generated.imageId,
              imageUrl: generated.imageUrl,
              prompt,
              conceptName: concept.name,
              conceptBrief: concept.brief
            });
            // Show progress in the gallery as each concept lands.
            setCandidates([...nextCandidates]);
          }
        } catch (renderError) {
          console.warn(`Cover concept "${concept.name}" failed to render`, renderError);
        }
      }

      if (nextCandidates.length === 0) {
        setError('No covers could be rendered — check your image model/key in Settings and try again.');
        return;
      }
      if (nextCandidates[0]) {
        selectCoverCandidate(nextCandidates[0]);
        if (continueAfterFirst && !autoCoverConfirmedRef.current) {
          autoCoverConfirmedRef.current = true;
          onConfirm();
        }
      }
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Cover generation failed. Try again.');
    } finally {
      setProgressLine(null);
      setIsGenerating(false);
    }
  }, [
    coverTagline,
    coverTitle,
    projectId,
    projectName,
    roughIdea,
    selectCoverCandidate,
    state,
    onConfirm
  ]);

  useEffect(() => {
    if (!autoRunAgent || isGenerating || autoCoverConfirmedRef.current) return;
    if (state.coverImageUrl || state.coverImageId || state.coverTemplateId) {
      autoCoverConfirmedRef.current = true;
      onConfirm();
      return;
    }
    if (autoCoverStartedRef.current) return;
    autoCoverStartedRef.current = true;
    void handleDesignCovers(true);
  }, [
    autoRunAgent,
    handleDesignCovers,
    isGenerating,
    onConfirm,
    state.coverImageId,
    state.coverImageUrl,
    state.coverTemplateId
  ]);

  const handleSkip = () => {
    onUpdate({ coverTemplateId: state.coverTemplateId || 'skipped' });
    onConfirm();
  };

  const selectedCandidate = candidates.find((candidate) => candidate.imageUrl === state.coverImageUrl);
  const selectedConceptName = selectedCandidate?.conceptName
    || (state.coverTemplateId?.startsWith('ai:') ? state.coverTemplateId.slice(3) : 'Current cover');
  const selectedConceptBrief = selectedCandidate?.conceptBrief
    || 'Saved cover art for this project.';

  return (
    <div className="mx-auto w-full max-w-7xl animate-fade-in">
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#050505] text-zinc-100 shadow-2xl">
        <div className="flex flex-col gap-4 border-b border-zinc-800 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-950">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="text-xs font-semibold uppercase text-zinc-500">Cover agent</div>
              <h2 className="text-xl font-semibold text-zinc-100">Design the front cover</h2>
              {autoRunAgent && (
                <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-500">
                  Autopilot will generate, pick, and continue from the first successful cover.
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleSkip}
              className="border-zinc-700 text-zinc-300 hover:bg-zinc-900 hover:text-white"
            >
              Skip
            </Button>
            <Button
              variant="secondary"
              onClick={onConfirm}
              disabled={isGenerating}
              className="border-zinc-100"
            >
              Use cover
            </Button>
          </div>
        </div>

        <div className="grid min-h-[680px] grid-cols-1 lg:grid-cols-[360px_1fr]">
          <section className="border-b border-zinc-800 bg-[#111111] px-5 py-5 lg:border-b-0 lg:border-r">
            <div className="mb-5">
              <div className="text-sm font-semibold text-zinc-200">Brief</div>
              <p className="mt-1 text-sm leading-6 text-zinc-500">
                Title, tone, and optional reference art are carried into the cover concepts.
              </p>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase text-zinc-500">Title</span>
                <input
                  value={coverTitle}
                  onChange={(e) => setCoverTitle(e.target.value)}
                  placeholder="Cover title"
                  className="h-11 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder-zinc-600 focus:border-zinc-500"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase text-zinc-500">Tagline</span>
                <input
                  value={coverTagline}
                  onChange={(e) => setCoverTagline(e.target.value)}
                  placeholder="Optional"
                  className="h-11 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder-zinc-600 focus:border-zinc-500"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase text-zinc-500">Direction</span>
                <textarea
                  value={roughIdea}
                  onChange={(e) => {
                    setRoughIdea(e.target.value);
                    onUpdate({ coverPrompt: e.target.value });
                  }}
                  placeholder="Example: Maya above the flooded city, defiant, dramatic moonlight."
                  className="h-32 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm leading-6 text-zinc-100 outline-none placeholder-zinc-600 focus:border-zinc-500"
                />
              </label>

              <div>
                <div className="mb-2 text-xs font-semibold uppercase text-zinc-500">Reference</div>
                <label className="flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border border-dashed border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200">
                  <UploadCloud className="h-4 w-4 shrink-0" />
                  <span>Upload cover layout or mood reference</span>
                  <input type="file" hidden accept="image/*" onChange={(e) => handleUpload(e.target.files)} />
                </label>
                {state.coverTemplateImageUrl && (
                  <button
                    type="button"
                    onClick={() => setPreviewImage(state.coverTemplateImageUrl || null)}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-300 hover:text-white"
                  >
                    <ImageIcon className="h-3.5 w-3.5" /> View uploaded reference
                  </button>
                )}
              </div>

              <Button
                variant="secondary"
                onClick={() => handleDesignCovers(false)}
                isLoading={isGenerating}
                icon={<Wand2 className="h-4 w-4" />}
                className="w-full border-zinc-100"
              >
                {candidates.length > 0 ? 'New options' : 'Create options'}
              </Button>

              {progressLine && (
                <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-semibold text-zinc-300">
                  <Sparkles className="h-3.5 w-3.5 animate-pulse text-emerald-300" />
                  {progressLine}
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm font-semibold text-red-100">
                  {error}
                </div>
              )}
            </div>

            <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
              <div className="text-sm font-semibold text-zinc-200">Context used</div>
              <div className="mt-3 space-y-2 text-sm text-zinc-400">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-300" />
                  {state.characters.length || 0} character{state.characters.length === 1 ? '' : 's'}
                </div>
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-300" />
                  {state.scenes[0]?.setting || 'Story setting'}
                </div>
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-300" />
                  {state.stylePrompt ? 'Locked style prompt' : 'Default comic style'}
                </div>
              </div>
            </div>
          </section>

          <section className="flex min-h-[680px] flex-col">
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
              <div>
                <div className="text-sm font-semibold text-zinc-200">Cover board</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {state.coverImageUrl ? 'Selected cover ready' : 'No cover selected yet'}
                </div>
              </div>
              <div className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-zinc-400">
                {candidates.length} option{candidates.length === 1 ? '' : 's'}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {state.coverImageUrl ? (
                <div className="grid gap-5 xl:grid-cols-[minmax(260px,420px)_1fr]">
                  <button
                    type="button"
                    onClick={() => setPreviewImage(state.coverImageUrl || null)}
                    className="group overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 text-left shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
                  >
                    <img src={state.coverImageUrl} alt="Selected cover" className="h-auto w-full object-cover transition duration-200 group-hover:opacity-90" />
                  </button>
                  <div className="flex flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-5">
                    <div>
                      <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-emerald-950 px-3 py-1 text-xs font-semibold text-emerald-200">
                        <Check className="h-3.5 w-3.5" />
                        Selected
                      </div>
                      <h3 className="text-2xl font-semibold text-zinc-100">{selectedConceptName}</h3>
                      <p className="mt-3 text-sm leading-6 text-zinc-400">{selectedConceptBrief}</p>
                    </div>
                    <div className="mt-6 grid gap-3 text-sm text-zinc-400 sm:grid-cols-2">
                      <div className="rounded-lg bg-zinc-900 p-3">
                        <div className="text-xs font-semibold uppercase text-zinc-500">Masthead</div>
                        <div className="mt-1 truncate text-zinc-200">{coverTitle || projectName || 'Untitled'}</div>
                      </div>
                      <div className="rounded-lg bg-zinc-900 p-3">
                        <div className="text-xs font-semibold uppercase text-zinc-500">Tagline</div>
                        <div className="mt-1 truncate text-zinc-200">{coverTagline || 'None'}</div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-950 px-6 text-center">
                  <RefreshCw className={`h-6 w-6 text-zinc-500 ${isGenerating ? 'animate-spin' : ''}`} />
                  <div className="mt-4 text-lg font-semibold text-zinc-200">
                    {isGenerating ? 'Designing cover options' : 'Create cover options'}
                  </div>
                  <p className="mt-2 max-w-md text-sm leading-6 text-zinc-500">
                    The agent will create distinct cover concepts from the story, style, cast, setting, and brief.
                  </p>
                </div>
              )}

              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-200">Generated options</h3>
                  {candidates.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleDesignCovers(false)}
                      disabled={isGenerating}
                      className="text-xs font-semibold text-zinc-400 hover:text-white disabled:opacity-50"
                    >
                      Refresh
                    </button>
                  )}
                </div>

                {candidates.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {candidates.map((candidate) => {
                      const selected = state.coverImageUrl === candidate.imageUrl;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => selectCoverCandidate(candidate)}
                          className={`overflow-hidden rounded-lg border text-left transition ${
                            selected
                              ? 'border-emerald-300 bg-zinc-900 ring-2 ring-emerald-300/30'
                              : 'border-zinc-800 bg-zinc-950 hover:border-zinc-500'
                          }`}
                          title={candidate.conceptBrief}
                        >
                          <img src={candidate.imageUrl} alt={candidate.conceptName} className="h-40 w-full object-cover" />
                          <div className="border-t border-zinc-800 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="truncate text-sm font-semibold text-zinc-100">{candidate.conceptName}</div>
                              {selected && <Check className="h-4 w-4 shrink-0 text-emerald-300" />}
                            </div>
                            <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{candidate.conceptBrief}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-5 text-sm text-zinc-500">
                    Cover concepts will appear here after generation.
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
};
