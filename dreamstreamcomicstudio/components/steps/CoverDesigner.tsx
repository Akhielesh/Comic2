import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Wand2, UploadCloud, RefreshCw, Image as ImageIcon, Sparkles, Check } from 'lucide-react';
import { ComicAgentSettings, ComicState } from '../../types';
import { generateImage } from '../../services/imageService';
import { saveImage, getImageUrl } from '../../services/db';
import { Button } from '../ds/Button';
import { Field, FIELD_LABEL } from '../ds/Field';
import { Input, Textarea } from '../ds/Input';
import { cn } from '../../lib/utils';
import {
  CHIP,
  CHIP_VARIANT,
  FOCUS_RING,
  HAIRLINE,
  HEADING,
  OVERLINE,
  RADIUS_PANEL,
  SHADOW_SOFT,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_XL,
  TONE_TEXT,
  TRANSITION,
  WRAP_TEXT
} from '../chat/studioDesign';
import { AgentStageShell, STAGE_BOARD_HEADER, STAGE_BOARD_TITLE, STAGE_BODY, STAGE_CARD, STAGE_WELL, UPLOAD_TILE } from '../AgentStageShell';
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
    <AgentStageShell
      eyebrow="Cover agent"
      title="Design the front cover"
      description={autoRunAgent ? 'Autopilot will generate, pick, and continue from the first successful cover.' : undefined}
      icon={<Sparkles className="h-5 w-5" />}
      actions={(
        <>
          <Button variant="outline" onClick={handleSkip}>
            Skip
          </Button>
          <Button onClick={onConfirm} disabled={isGenerating}>
            Use cover
          </Button>
        </>
      )}
      sidebar={(
        <>
          <div className="mb-5">
            <h3 className={STAGE_BOARD_TITLE}>Brief</h3>
            <p className={cn('mt-1', STAGE_BODY)}>
              Title, tone, and optional reference art are carried into the cover concepts.
            </p>
          </div>

          <div className="space-y-4">
            <Field label="Title">
              <Input
                value={coverTitle}
                onChange={(e) => setCoverTitle(e.target.value)}
                placeholder="Cover title"
                className="h-11"
              />
            </Field>

            <Field label="Tagline">
              <Input
                value={coverTagline}
                onChange={(e) => setCoverTagline(e.target.value)}
                placeholder="Optional"
                className="h-11"
              />
            </Field>

            <Field label="Direction">
              <Textarea
                value={roughIdea}
                onChange={(e) => {
                  setRoughIdea(e.target.value);
                  onUpdate({ coverPrompt: e.target.value });
                }}
                placeholder="Example: Maya above the flooded city, defiant, dramatic moonlight."
                className="h-32 leading-6"
              />
            </Field>

            <div>
              <div className={cn('mb-1.5', FIELD_LABEL)}>Reference</div>
              <label className={UPLOAD_TILE}>
                <UploadCloud className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className={WRAP_TEXT}>Upload cover layout or mood reference</span>
                <input type="file" accept="image/*" className="sr-only" onChange={(e) => handleUpload(e.target.files)} />
              </label>
              {state.coverTemplateImageUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPreviewImage(state.coverTemplateImageUrl || null)}
                  className="mt-2 -ml-2.5 text-[var(--ds-muted)]"
                >
                  <ImageIcon className="h-3.5 w-3.5" /> View uploaded reference
                </Button>
              )}
            </div>

            <Button
              variant="outline"
              onClick={() => handleDesignCovers(false)}
              loading={isGenerating}
              disabled={isGenerating}
              className="w-full"
            >
              {isGenerating ? null : <Wand2 className="h-4 w-4" />}
              {candidates.length > 0 ? 'New options' : 'Create options'}
            </Button>

            {progressLine && (
              <div className={cn('flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--ds-ink)]', STAGE_WELL)}>
                <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
                <span className={WRAP_TEXT}>{progressLine}</span>
              </div>
            )}

            {error && (
              <div className={cn('rounded-[var(--ds-radius-control)] border px-3 py-2 text-sm font-medium', STATUS_SURFACE.error, STATUS_INK.error, WRAP_TEXT)}>
                {error}
              </div>
            )}
          </div>

          <div className={cn('mt-6 p-4', STAGE_CARD)}>
            <h3 className={STAGE_BOARD_TITLE}>Context used</h3>
            <div className="mt-3 space-y-2 text-sm text-[var(--ds-muted)]">
              <div className="flex items-center gap-2">
                <Check className={cn('h-4 w-4 shrink-0', TONE_TEXT.success)} aria-hidden="true" />
                {state.characters.length || 0} character{state.characters.length === 1 ? '' : 's'}
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Check className={cn('h-4 w-4 shrink-0', TONE_TEXT.success)} aria-hidden="true" />
                <span className={WRAP_TEXT}>{state.scenes[0]?.setting || 'Story setting'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className={cn('h-4 w-4 shrink-0', TONE_TEXT.success)} aria-hidden="true" />
                {state.stylePrompt ? 'Locked style prompt' : 'Default comic style'}
              </div>
            </div>
          </div>
        </>
      )}
    >
      <div className="flex min-h-[680px] flex-col">
        <div className={STAGE_BOARD_HEADER}>
          <div className="min-w-0">
            <h3 className={STAGE_BOARD_TITLE}>Cover board</h3>
            <div className="mt-1 text-xs text-[var(--ds-muted)]">
              {state.coverImageUrl ? 'Selected cover ready' : 'No cover selected yet'}
            </div>
          </div>
          <span className={cn(CHIP, CHIP_VARIANT.outline, 'tabular-nums')}>
            {candidates.length} option{candidates.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {state.coverImageUrl ? (
            <div className="grid gap-5 xl:grid-cols-[minmax(260px,420px)_1fr]">
              <button
                type="button"
                onClick={() => setPreviewImage(state.coverImageUrl || null)}
                aria-label="Preview selected cover"
                className={cn('group overflow-hidden text-left', RADIUS_PANEL, HAIRLINE, SHADOW_SOFT, 'bg-[var(--ds-well)]', FOCUS_RING)}
              >
                <img src={state.coverImageUrl} alt="Selected cover" className={cn('h-auto w-full object-cover group-hover:opacity-90', TRANSITION)} />
              </button>
              <div className={cn('flex min-w-0 flex-col justify-between p-5', STAGE_CARD)}>
                <div className="min-w-0">
                  <span className={cn('mb-3', STATUS_CHIP, STATUS_CHIP_TONE.healthy)}>
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    Selected
                  </span>
                  <h3 className={cn('m-0', HEADING, TEXT_XL, WRAP_TEXT)}>{selectedConceptName}</h3>
                  <p className={cn('mt-3', STAGE_BODY)}>{selectedConceptBrief}</p>
                </div>
                <div className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
                  <div className={cn('min-w-0 p-3', STAGE_WELL)}>
                    <div className={OVERLINE}>Masthead</div>
                    <div className="mt-1 truncate text-[var(--ds-ink)]">{coverTitle || projectName || 'Untitled'}</div>
                  </div>
                  <div className={cn('min-w-0 p-3', STAGE_WELL)}>
                    <div className={OVERLINE}>Tagline</div>
                    <div className="mt-1 truncate text-[var(--ds-ink)]">{coverTagline || 'None'}</div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className={cn('flex min-h-[360px] flex-col items-center justify-center border-dashed px-6 text-center', STAGE_WELL)}>
              <RefreshCw className={cn('h-6 w-6 text-[var(--ds-muted)]', isGenerating && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
              <div className="mt-4 text-[length:var(--ds-text-lg)] font-semibold text-[var(--ds-ink)]">
                {isGenerating ? 'Designing cover options' : 'Create cover options'}
              </div>
              <p className={cn('mt-2 max-w-md', STAGE_BODY)}>
                The agent will create distinct cover concepts from the story, style, cast, setting, and brief.
              </p>
            </div>
          )}

          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className={STAGE_BOARD_TITLE}>Generated options</h3>
              {candidates.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDesignCovers(false)}
                  disabled={isGenerating}
                  className="text-[var(--ds-muted)]"
                >
                  Refresh
                </Button>
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
                      aria-pressed={selected}
                      className={cn(
                        'min-w-0 overflow-hidden border bg-[var(--ds-surface)] text-left',
                        RADIUS_PANEL,
                        TRANSITION,
                        FOCUS_RING,
                        selected
                          ? 'border-[var(--ds-ink)] ring-1 ring-[var(--ds-ink)]'
                          : 'border-[var(--ds-hairline)] hover:border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)]'
                      )}
                      title={candidate.conceptBrief}
                    >
                      <img src={candidate.imageUrl} alt={candidate.conceptName} className="h-40 w-full bg-[var(--ds-well)] object-cover" />
                      <div className="border-t border-[var(--ds-hairline)] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 truncate text-sm font-semibold text-[var(--ds-ink)]">{candidate.conceptName}</div>
                          {selected && <Check className={cn('h-4 w-4 shrink-0', TONE_TEXT.success)} aria-hidden="true" />}
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--ds-muted)]">{candidate.conceptBrief}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className={cn('px-4 py-5', STAGE_WELL, STAGE_BODY)}>
                Cover concepts will appear here after generation.
              </div>
            )}
          </div>
        </div>
      </div>

      {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
    </AgentStageShell>
  );
};
