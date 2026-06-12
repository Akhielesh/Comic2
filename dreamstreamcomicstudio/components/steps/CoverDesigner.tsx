import React, { useEffect, useState } from 'react';
import { Wand2, UploadCloud, RefreshCw, Image as ImageIcon, Sparkles } from 'lucide-react';
import { ComicState } from '../../types';
import { generateImage } from '../../services/imageService';
import { saveImage, getImageUrl } from '../../services/db';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { classifyStoryMood } from '../../services/storyMood';
import { resolveAspectRatio } from '../../services/imageUtils';
import { suggestCoverConcepts, type CoverConcept } from '../../services/geminiService';
import { COVER_TEMPLATE_DEFINITIONS } from '../../services/coverTemplates';

interface CoverDesignerProps {
  state: ComicState;
  projectId: string;
  /** The comic's name — default masthead title rendered on the cover. */
  projectName?: string;
  onUpdate: (updates: Partial<ComicState>) => void;
  onConfirm: () => void;
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
export const CoverDesigner: React.FC<CoverDesignerProps> = ({ state, projectId, projectName, onUpdate, onConfirm }) => {
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

  useEffect(() => {
    setRoughIdea(state.coverPrompt || '');
  }, [state.coverPrompt]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const base64 = await fileToBase64(files[0]);
    const imageId = await saveImage(base64);
    const imageUrl = (await getImageUrl(imageId)) || base64;
    onUpdate({ coverTemplateImageId: imageId, coverTemplateImageUrl: imageUrl });
  };

  const selectCoverCandidate = (candidate: CoverCandidate) => {
    onUpdate({
      coverImageId: candidate.imageId,
      coverImageUrl: candidate.imageUrl,
      coverPrompt: roughIdea,
      coverTemplateId: `ai:${candidate.conceptName}`
    });
  };

  const handleDesignCovers = async () => {
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
      if (nextCandidates[0]) selectCoverCandidate(nextCandidates[0]);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Cover generation failed. Try again.');
    } finally {
      setProgressLine(null);
      setIsGenerating(false);
    }
  };

  const handleSkip = () => {
    onUpdate({ coverTemplateId: state.coverTemplateId || 'skipped' });
    onConfirm();
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in">
      <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6">
        <div className="flex flex-col md:flex-row justify-between items-start gap-4">
          <div>
            <h2 className="text-4xl font-display text-black">Cover Designer</h2>
            <p className="text-slate-600 font-comic">
              Give a rough idea (or nothing) — the AI designs distinct cover options from your story and style,
              with the title rendered as real cover art.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleSkip}>Skip</Button>
            <Button onClick={onConfirm} className="bg-brand-yellow">Continue</Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[0.9fr_1.1fr] gap-6">
        <div className="space-y-6">
          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6 space-y-3">
            <label className="text-lg font-display text-black">Your Cover</label>
            <input
              value={coverTitle}
              onChange={(e) => setCoverTitle(e.target.value)}
              placeholder="Title — rendered as the cover masthead"
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
            <input
              value={coverTagline}
              onChange={(e) => setCoverTagline(e.target.value)}
              placeholder="Tagline — rendered small on the cover (optional)"
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
            <textarea
              value={roughIdea}
              onChange={(e) => {
                setRoughIdea(e.target.value);
                onUpdate({ coverPrompt: e.target.value });
              }}
              placeholder="Rough idea (optional) — e.g. 'Maya on her bike above the flooded city, defiant'…"
              className="w-full h-24 bg-slate-50 border-2 border-black rounded-lg p-3 text-sm"
            />
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase">Layout Reference (Optional)</div>
              <label className="flex items-center gap-2 border-2 border-dashed border-black rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                <UploadCloud size={16} />
                <span className="text-xs font-bold">Upload a cover you like as reference</span>
                <input type="file" hidden accept="image/*" onChange={(e) => handleUpload(e.target.files)} />
              </label>
              {state.coverTemplateImageUrl && (
                <button
                  onClick={() => setPreviewImage(state.coverTemplateImageUrl || null)}
                  className="text-xs font-bold text-brand-blue flex items-center gap-1"
                >
                  <ImageIcon size={12} /> View uploaded reference
                </button>
              )}
            </div>
            <Button onClick={handleDesignCovers} isLoading={isGenerating} icon={<Wand2 className="w-4 h-4" />} className="w-full">
              {candidates.length > 0 ? 'Design New Options' : 'Design Cover Options'}
            </Button>
            {progressLine && (
              <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
                <Sparkles size={14} className="text-brand-blue animate-pulse" /> {progressLine}
              </div>
            )}
            {error && <div className="text-xs font-bold text-brand-red">{error}</div>}
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6">
            <h3 className="text-2xl font-display mb-4">Cover Options</h3>
            {state.coverImageUrl && (
              <div className="border-4 border-black rounded-xl overflow-hidden shadow-comic cursor-pointer mb-4" onClick={() => setPreviewImage(state.coverImageUrl || null)}>
                <img src={state.coverImageUrl} alt="Selected cover" className="w-full h-auto object-cover" />
              </div>
            )}
            {candidates.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {candidates.map((candidate) => {
                  const selected = state.coverImageUrl === candidate.imageUrl;
                  return (
                    <button
                      key={candidate.id}
                      onClick={() => selectCoverCandidate(candidate)}
                      className={`text-left border-4 rounded-xl overflow-hidden transition-all ${selected ? 'border-brand-blue ring-4 ring-brand-blue/30' : 'border-black hover:-translate-y-1'}`}
                      title={candidate.conceptBrief}
                    >
                      <img src={candidate.imageUrl} alt={candidate.conceptName} className="w-full h-36 object-cover" />
                      <div className="p-2 bg-white border-t-2 border-black">
                        <div className="text-xs font-display truncate">{candidate.conceptName}</div>
                        <div className="text-[10px] font-comic text-slate-500 line-clamp-2">{candidate.conceptBrief}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : !state.coverImageUrl && (
              <div className="border-4 border-dashed border-black rounded-xl h-64 flex flex-col items-center justify-center gap-2 text-slate-400 font-comic">
                <RefreshCw size={20} className={isGenerating ? 'animate-spin' : ''} />
                {isGenerating ? 'Designing…' : 'No cover options yet — hit "Design Cover Options".'}
              </div>
            )}
          </div>
        </div>
      </div>

      {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
};
