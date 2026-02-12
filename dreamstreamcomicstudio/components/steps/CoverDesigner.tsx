import React, { useEffect, useMemo, useState } from 'react';
import { Wand2, UploadCloud, RefreshCw, Image as ImageIcon } from 'lucide-react';
import { ComicState, StyleVariant } from '../../types';
import { generateImage } from '../../services/imageService';
import { saveImage, getImageUrl } from '../../services/db';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { resolveAspectRatio } from '../../services/imageUtils';

interface CoverDesignerProps {
  state: ComicState;
  projectId: string;
  onUpdate: (updates: Partial<ComicState>) => void;
  onConfirm: () => void;
}

type CoverTemplate = {
  id: string;
  label: string;
  prompt: string;
  description: string;
};

const COVER_TEMPLATES: CoverTemplate[] = [
  { id: 'hero-splash', label: 'Hero Splash', prompt: 'single hero centered, dramatic lighting, bold silhouette, empty title space', description: 'Classic hero focus with big title space.' },
  { id: 'duel-standoff', label: 'Dual-Character Standoff', prompt: 'two characters in standoff composition, split lighting, dynamic tension', description: 'Conflict-driven, cinematic cover.' },
  { id: 'mystic-frame', label: 'Mystic Title Frame', prompt: 'ornate frame around the scene, mystical symbols, open title space', description: 'Epic and mythic, with structured framing.' },
  { id: 'minimal-icon', label: 'Minimal Icon + Background', prompt: 'minimalist icon foreground, textured background, large negative space', description: 'Clean, bold, modern cover.' },
  { id: 'collage-triptych', label: 'Collage / Triptych', prompt: 'three-panel collage, layered scenes, unified palette', description: 'Multiple story beats in one cover.' }
];

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

export const CoverDesigner: React.FC<CoverDesignerProps> = ({ state, projectId, onUpdate, onConfirm }) => {
  const initialTemplateId = COVER_TEMPLATES.find((t) => t.id === state.coverTemplateId)
    ? (state.coverTemplateId as string)
    : COVER_TEMPLATES[0].id;
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplateId);
  const [coverNotes, setCoverNotes] = useState(state.coverPrompt || '');
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  useEffect(() => {
    if (state.coverTemplateId && COVER_TEMPLATES.some((t) => t.id === state.coverTemplateId)) {
      setSelectedTemplateId(state.coverTemplateId);
    }
  }, [state.coverTemplateId]);

  useEffect(() => {
    setCoverNotes(state.coverPrompt || '');
  }, [state.coverPrompt]);

  const selectedTemplate = useMemo(
    () => COVER_TEMPLATES.find((t) => t.id === selectedTemplateId) || COVER_TEMPLATES[0],
    [selectedTemplateId]
  );

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const base64 = await fileToBase64(files[0]);
    const imageId = await saveImage(base64);
    const imageUrl = (await getImageUrl(imageId)) || base64;
    onUpdate({ coverTemplateImageId: imageId, coverTemplateImageUrl: imageUrl });
  };

  const handleGenerateCover = async () => {
    setIsGenerating(true);
    try {
      const scene = state.scenes[0];
      const cast = state.characters.map((c) => c.name).join(', ');
      const styleVariant = state.styleVariants.find((v: StyleVariant) => v.id === state.selectedStyleId);
      const referenceIds: string[] = [];
      if (state.coverTemplateImageId) referenceIds.push(state.coverTemplateImageId);
      if (styleVariant?.imageId) referenceIds.push(styleVariant.imageId);

      const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);
      const prompt = buildImagePrompt({
        stage: "cover",
        stylePrompt: state.stylePrompt || 'bold comic style',
        sceneAction: scene?.synopsis || 'Epic sci-fi adventure',
        setting: scene?.setting || 'Unknown',
        characters: cast || 'Main protagonist',
        extraNotes: `${selectedTemplate.prompt}. ${coverNotes || ''}`.trim(),
        projectTitle: state.styleCategory || undefined
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
        onUpdate({
          coverImageId: generated.imageId,
          coverImageUrl: generated.imageUrl,
          coverPrompt: coverNotes,
          coverTemplateId: selectedTemplate.id
        });
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
            <p className="text-slate-600 font-comic">Create a standout cover after building the world.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleSkip}>Skip</Button>
            <Button onClick={onConfirm} className="bg-brand-yellow">Continue</Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-6">
        <div className="space-y-6">
          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6 space-y-4">
            <h3 className="text-2xl font-display">Choose a Template</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {COVER_TEMPLATES.map((template) => {
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
                    <div className="text-xs font-comic text-slate-600">{template.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-xl border-4 border-black shadow-comic p-6 space-y-3">
            <label className="text-lg font-display text-black">Cover Notes (Optional)</label>
            <textarea
              value={coverNotes}
              onChange={(e) => {
                setCoverNotes(e.target.value);
                onUpdate({ coverPrompt: e.target.value });
              }}
              placeholder="Any special composition or mood notes..."
              className="w-full h-24 bg-slate-50 border-2 border-black rounded-lg p-3 text-sm font-medium text-black placeholder-slate-400 focus:ring-0 focus:shadow-comic transition-all resize-none"
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
              <Button onClick={handleGenerateCover} isLoading={isGenerating} icon={<Wand2 className="w-4 h-4" />}>Generate Cover</Button>
              {state.coverImageUrl && (
                <Button variant="secondary" onClick={handleGenerateCover} icon={<RefreshCw className="w-4 h-4" />}>Regenerate</Button>
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
          </div>
        </div>
      </div>

      {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
};
