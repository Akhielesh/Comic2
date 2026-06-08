import React, { useEffect, useMemo, useState } from 'react';
import { Wand2, UploadCloud, RefreshCw, Image as ImageIcon } from 'lucide-react';
import { ComicState, StyleVariant } from '../../types';
import { generateImage } from '../../services/imageService';
import { saveImage, getImageUrl } from '../../services/db';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { classifyStoryMood } from '../../services/storyMood';
import { resolveAspectRatio } from '../../services/imageUtils';
import { COVER_TEMPLATE_DEFINITIONS } from '../../services/coverTemplates';

interface CoverDesignerProps {
  state: ComicState;
  projectId: string;
  onUpdate: (updates: Partial<ComicState>) => void;
  onConfirm: () => void;
}

type CoverCandidate = {
  id: string;
  imageId?: string;
  imageUrl: string;
  prompt: string;
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

export const CoverDesigner: React.FC<CoverDesignerProps> = ({ state, projectId, onUpdate, onConfirm }) => {
  const initialTemplateId = COVER_TEMPLATE_DEFINITIONS.find((t) => t.id === state.coverTemplateId)
    ? (state.coverTemplateId as string)
    : COVER_TEMPLATE_DEFINITIONS[0].id;
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplateId);
  const [coverNotes, setCoverNotes] = useState(state.coverPrompt || '');
  const [coverTitleIdea, setCoverTitleIdea] = useState(state.styleCategory || '');
  const [coverTagline, setCoverTagline] = useState('');
  const [coverMood, setCoverMood] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);

  useEffect(() => {
    if (state.coverTemplateId && COVER_TEMPLATE_DEFINITIONS.some((t) => t.id === state.coverTemplateId)) {
      setSelectedTemplateId(state.coverTemplateId);
    }
  }, [state.coverTemplateId]);

  useEffect(() => {
    setCoverNotes(state.coverPrompt || '');
  }, [state.coverPrompt]);

  const selectedTemplate = useMemo(
    () => COVER_TEMPLATE_DEFINITIONS.find((t) => t.id === selectedTemplateId) || COVER_TEMPLATE_DEFINITIONS[0],
    [selectedTemplateId]
  );

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
      coverPrompt: coverNotes,
      coverTemplateId: selectedTemplate.id
    });
  };

  const handleGenerateCover = async () => {
    setIsGenerating(true);
    try {
      const scene = state.scenes[0];
      const cast = state.characters.map((c) => c.name).join(', ');
      const keyItems = state.items.slice(0, 3).map((item) => item.name).join(', ');
      const styleVariant = state.styleVariants.find((v: StyleVariant) => v.id === state.selectedStyleId);
      const referenceIds: string[] = [];
      if (state.coverTemplateImageId) referenceIds.push(state.coverTemplateImageId);
      if (styleVariant?.imageId) referenceIds.push(styleVariant.imageId);
      else if (state.styleImageId) referenceIds.push(state.styleImageId);

      const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);
      const sharedTemplateBrief = [
        selectedTemplate.compositionRules,
        selectedTemplate.focalStrategy,
        selectedTemplate.safeZoneNotes,
        `Tone tags: ${selectedTemplate.toneTags.join(', ')}`
      ].join(' ');
      const sharedBrief = [
        coverNotes,
        coverMood ? `Mood direction: ${coverMood}` : '',
        coverTitleIdea ? `Title intent: ${coverTitleIdea}` : '',
        coverTagline ? `Tagline intent: ${coverTagline}` : ''
      ].filter(Boolean).join(' ');

      const variationLabels = ['Variation A', 'Variation B', 'Variation C'];
      const nextCandidates: CoverCandidate[] = [];

      for (const variation of variationLabels) {
        const prompt = buildImagePrompt({
          stage: 'cover',
          stylePrompt: state.stylePrompt || 'bold comic style',
          sceneAction: sharedTemplateBrief,
          setting: scene?.setting || '',
          characters: cast || 'Lead cast',
          items: keyItems || undefined,
          moodGuidance: (state.storyMood?.promptGuidance) || classifyStoryMood(state.script, state.creativeDirection).promptGuidance,
          extraNotes: `${sharedBrief} ${variation}`.trim(),
          projectTitle: coverTitleIdea || state.styleCategory || undefined
        });

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
              templateId: selectedTemplate.id
            }
          }
        );

        if (generated?.imageUrl) {
          nextCandidates.push({
            id: `${selectedTemplate.id}-${variation}-${Date.now()}`,
            imageId: generated.imageId,
            imageUrl: generated.imageUrl,
            prompt
          });
        }
      }

      setCandidates(nextCandidates);
      if (nextCandidates[0]) {
        selectCoverCandidate(nextCandidates[0]);
      }
    } catch (e) {
      console.error(e);
    } finally {
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
            <p className="text-slate-600 font-comic">Choose a cover template, add a brief, and generate multiple cover candidates.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleSkip}>Skip</Button>
            <Button onClick={onConfirm} className="bg-brand-yellow">Continue</Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-6">
        <div className="space-y-6">
          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6 space-y-4">
            <h3 className="text-2xl font-display">Choose a Template</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {COVER_TEMPLATE_DEFINITIONS.map((template) => {
                const selected = template.id === selectedTemplateId;
                return (
                  <button
                    key={template.id}
                    onClick={() => {
                      setSelectedTemplateId(template.id);
                      onUpdate({ coverTemplateId: template.id });
                    }}
                    className={`border-4 rounded-xl p-4 text-left transition-all ${selected ? 'border-brand-blue bg-brand-blue/5 shadow-comic' : 'border-black bg-white'}`}
                  >
                    <div className="font-display text-lg">{template.label}</div>
                    <div className="text-xs font-comic text-slate-600 mt-1">{template.description}</div>
                    <div className="text-[10px] font-bold uppercase text-slate-500 mt-2">Tone: {template.toneTags.join(', ')}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6 space-y-3">
            <label className="text-lg font-display text-black">Cover Brief</label>
            <input
              value={coverTitleIdea}
              onChange={(e) => setCoverTitleIdea(e.target.value)}
              placeholder="Title idea"
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
            <input
              value={coverTagline}
              onChange={(e) => setCoverTagline(e.target.value)}
              placeholder="Tagline or hook"
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
            <input
              value={coverMood}
              onChange={(e) => setCoverMood(e.target.value)}
              placeholder="Mood keywords (e.g., gritty, hopeful, neon)"
              className="w-full border-2 border-black rounded p-2 text-sm"
            />
            <textarea
              value={coverNotes}
              onChange={(e) => {
                setCoverNotes(e.target.value);
                onUpdate({ coverPrompt: e.target.value });
              }}
              placeholder="Composition and art direction notes..."
              className="w-full h-24 bg-slate-50 border-2 border-black rounded-lg p-3 text-sm"
            />
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase">Template Reference (Optional)</div>
              <label className="flex items-center gap-2 border-2 border-dashed border-black rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                <UploadCloud size={16} />
                <span className="text-xs font-bold">Upload rough cover layout</span>
                <input type="file" hidden accept="image/*" onChange={(e) => handleUpload(e.target.files)} />
              </label>
              {state.coverTemplateImageUrl && (
                <button
                  onClick={() => setPreviewImage(state.coverTemplateImageUrl || null)}
                  className="text-xs font-bold text-brand-blue flex items-center gap-1"
                >
                  <ImageIcon size={12} /> View uploaded template
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleGenerateCover} isLoading={isGenerating} icon={<Wand2 className="w-4 h-4" />}>
                Generate 3 Covers
              </Button>
              {state.coverImageUrl && (
                <Button variant="secondary" onClick={handleGenerateCover} icon={<RefreshCw className="w-4 h-4" />}>
                  Regenerate
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6">
            <h3 className="text-2xl font-display mb-4">Cover Preview</h3>
            {state.coverImageUrl ? (
              <div className="border-4 border-black rounded-xl overflow-hidden shadow-comic cursor-pointer" onClick={() => setPreviewImage(state.coverImageUrl || null)}>
                <img src={state.coverImageUrl} alt="Cover preview" className="w-full h-auto object-cover" />
              </div>
            ) : (
              <div className="border-4 border-dashed border-black rounded-xl h-64 flex items-center justify-center text-slate-400 font-comic">
                No cover generated yet.
              </div>
            )}

            {candidates.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="text-xs font-bold uppercase text-slate-500">Candidates</div>
                <div className="grid grid-cols-3 gap-2">
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      onClick={() => selectCoverCandidate(candidate)}
                      className={`border-2 rounded overflow-hidden ${state.coverImageUrl === candidate.imageUrl ? 'border-brand-blue' : 'border-black'}`}
                    >
                      <img src={candidate.imageUrl} alt="Cover candidate" className="w-full h-24 object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
};
