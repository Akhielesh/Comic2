import React, { useMemo, useState } from 'react';
import { LayoutTemplate, UploadCloud, Wand2, Check, Grid } from 'lucide-react';
import { ComicState, LayoutType, TextLayout, AspectRatio, Scene } from '../../types';
import { analyzeLayoutFromImages } from '../../services/geminiService';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { GRID_TEMPLATES, getTemplatesForRatio, getTemplateById, GridTemplate, PanelSlot } from '../../services/gridTemplates';
import { FEATURE_FLAGS } from '../../services/modelPolicy';
import { recommendLayouts } from '../../services/layoutRecommendation';

interface LayoutSelectorProps {
    onLayoutConfirmed: (layout: LayoutType, customPrompt?: string, gridTemplateId?: string) => void;
    currentLayoutType?: LayoutType;
    currentGridTemplateId?: string;
    selectedFormFactor?: AspectRatio;
    scenes: Scene[];
    projectId: string;
    currentTextLayout?: TextLayout;
    onTextLayoutChange?: (layout: TextLayout) => void;
    currentDialogueMode?: 'universal' | 'per_panel';
    onDialogueModeChange?: (mode: 'universal' | 'per_panel') => void;
    currentDialogueStyle?: 'speech' | 'thought' | 'narration' | 'shout';
    onDialogueStyleChange?: (style: 'speech' | 'thought' | 'narration' | 'shout') => void;
}

const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
});

// ---------------------------------------------------------------------------
// Slot-based visual preview
// ---------------------------------------------------------------------------

const SLOT_COLORS = [
    'bg-brand-blue/20',
    'bg-brand-yellow/20',
    'bg-brand-red/20',
    'bg-slate-200',
    'bg-emerald-200/40',
    'bg-purple-200/40',
    'bg-amber-200/40',
    'bg-pink-200/40',
    'bg-cyan-200/40',
];

function SlotPreview({ slots }: { slots: PanelSlot[] }) {
    return (
        <div className="w-full h-full relative bg-white border-2 border-black overflow-hidden">
            {slots.map((slot, i) => (
                <div
                    key={slot.id}
                    className={`absolute ${SLOT_COLORS[i % SLOT_COLORS.length]} border-2 border-black rounded-sm`}
                    style={{
                        left: `${slot.x}%`,
                        top: `${slot.y}%`,
                        width: `${slot.width}%`,
                        height: `${slot.height}%`,
                    }}
                />
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const LayoutSelector: React.FC<LayoutSelectorProps> = ({
    onLayoutConfirmed,
    currentLayoutType,
    currentGridTemplateId,
    selectedFormFactor,
    scenes,
    projectId,
    currentTextLayout = 'caption',
    onTextLayoutChange,
    currentDialogueMode = 'universal',
    onDialogueModeChange,
    currentDialogueStyle = 'speech',
    onDialogueStyleChange
}) => {
    const [customImages, setCustomImages] = useState<string[]>([]);
    const [customLayoutPrompt, setCustomLayoutPrompt] = useState<string | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [pendingConfirmTemplate, setPendingConfirmTemplate] = useState<GridTemplate | null>(null);

    // ---- Determine which templates to show ---------------------------------

    const useFiltering = FEATURE_FLAGS.ENABLE_FORM_FACTOR_FILTERING && selectedFormFactor;

    const compatibleTemplates = useFiltering
        ? getTemplatesForRatio(selectedFormFactor!)
        : GRID_TEMPLATES;

    const incompatibleTemplates = useFiltering
        ? GRID_TEMPLATES.filter(t => !t.compatibleRatios.includes(selectedFormFactor!))
        : [];

    const layoutRecommendations = useMemo(
        () => recommendLayouts({ scenes, selectedFormFactor, templates: GRID_TEMPLATES }),
        [scenes, selectedFormFactor]
    );
    const recommendedTemplateId = layoutRecommendations[0]?.templateId;
    const recommendedReason = layoutRecommendations[0]?.reason;

    // ---- Handlers ----------------------------------------------------------

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;
        const files = Array.from(e.target.files).slice(0, 4);
        const base64s = await Promise.all(files.map(fileToBase64));
        setCustomImages(base64s);
        setCustomLayoutPrompt(null);
    };

    const handleAnalyzeLayout = async () => {
        if (customImages.length === 0) return;
        setIsAnalyzing(true);
        try {
            const result = await analyzeLayoutFromImages(customImages, projectId);
            setCustomLayoutPrompt(result);
        } catch (e) {
            console.error(e);
            setCustomLayoutPrompt("Error: Could not analyze layout.");
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleSelectTemplate = (template: GridTemplate) => {
        if (recommendedTemplateId && template.id !== recommendedTemplateId) {
            setPendingConfirmTemplate(template);
            return;
        }
        onLayoutConfirmed(template.id as LayoutType, undefined, template.id);
    };

    // ---- Render helpers ----------------------------------------------------

    const renderTemplateCard = (template: GridTemplate, isIncompatible = false) => {
        const isSelected = currentGridTemplateId
            ? currentGridTemplateId === template.id
            : currentLayoutType === template.id;

        return (
            <div
                key={template.id}
                className={`group relative bg-white rounded-xl border-4 shadow-comic transition-all duration-300 flex flex-col overflow-hidden ${isSelected
                    ? 'border-brand-blue ring-4 ring-brand-blue/30 scale-105 z-10'
                    : isIncompatible
                        ? 'border-slate-300 opacity-50'
                        : 'border-black hover:-translate-y-2 hover:shadow-[8px_8px_0px_0px_#000]'
                    }`}
            >
                <div className="aspect-[3/4] bg-slate-50 p-4 border-b-4 border-black relative">
                    <SlotPreview slots={template.panelSlots} />
                    {isSelected && (
                        <div className="absolute top-2 right-2 bg-brand-blue text-white p-1 rounded-full border-2 border-white shadow-md">
                            <Check size={20} strokeWidth={3} />
                        </div>
                    )}
                    {/* Panel count badge */}
                    <div className="absolute bottom-2 left-2 bg-black text-white text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1">
                        <Grid size={10} />
                        {template.panelCount} panel{template.panelCount !== 1 ? 's' : ''}
                    </div>
                    {isIncompatible && (
                        <div className="absolute top-2 left-2 bg-amber-100 text-amber-800 text-[9px] font-bold px-2 py-0.5 rounded border border-amber-300">
                            Not optimal
                        </div>
                    )}
                    {template.id === recommendedTemplateId && (
                        <div className="absolute top-2 left-2 bg-green-100 text-green-800 text-[9px] font-bold px-2 py-0.5 rounded border border-green-300">
                            Recommended
                        </div>
                    )}
                </div>
                <div className="p-6 flex flex-col flex-1">
                    <h3 className="text-xl font-display text-black mb-2 uppercase">{template.title}</h3>
                    <p className="text-xs text-slate-600 font-comic mb-2 flex-1">{template.description}</p>
                    {/* Tags */}
                    <div className="flex flex-wrap gap-1 mb-4">
                        {template.tags.slice(0, 3).map(tag => (
                            <span key={tag} className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full border border-slate-200">
                                {tag}
                            </span>
                        ))}
                    </div>
                    <Button
                        onClick={() => handleSelectTemplate(template)}
                        variant={isSelected ? "primary" : "outline"}
                        className={`w-full ${!isSelected && !isIncompatible ? 'group-hover:bg-brand-yellow group-hover:text-black group-hover:border-black' : ''}`}
                        disabled={isIncompatible}
                    >
                        {isSelected ? "Selected" : isIncompatible ? "Not Available" : "Select"}
                    </Button>
                </div>
            </div>
        );
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-fade-in">
            <div className="text-center space-y-2 bg-white p-6 rounded-xl border-4 border-black shadow-comic max-w-2xl mx-auto transform -rotate-1">
                <h2 className="text-4xl font-display text-black">Choose Your Layout</h2>
                <p className="text-slate-600 font-comic font-bold">How should the reader experience your story?</p>
                {recommendedTemplateId && (
                    <p className="text-xs text-green-700 font-bold">
                        Auto recommendation: {getTemplateById(recommendedTemplateId).title} ({recommendedReason})
                    </p>
                )}
                {selectedFormFactor && (
                    <p className="text-xs text-brand-blue font-bold">
                        Showing layouts optimized for {selectedFormFactor} format
                        {incompatibleTemplates.length > 0 && ` · ${incompatibleTemplates.length} hidden`}
                    </p>
                )}
            </div>

            {/* Compatible templates */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {compatibleTemplates.map(t => renderTemplateCard(t))}

                {/* Custom Layout Card */}
                <div className={`group relative bg-white rounded-xl border-4 shadow-comic transition-all duration-300 flex flex-col overflow-hidden md:col-span-2 lg:col-span-1 ${currentLayoutType === 'custom' ? 'border-brand-blue ring-4 ring-brand-blue/30 scale-105 z-10' : 'border-black hover:-translate-y-2 hover:shadow-[8px_8px_0px_0px_#000]'}`}>
                    <div className="aspect-[3/4] bg-slate-50 p-4 border-b-4 border-black flex flex-col gap-2 relative">
                        {currentLayoutType === 'custom' && <div className="absolute top-2 right-2 bg-brand-blue text-white p-1 rounded-full border-2 border-white shadow-md z-10"><Check size={20} strokeWidth={3} /></div>}
                        <label className="flex-1 border-2 border-dashed border-slate-400 rounded-lg flex flex-col items-center justify-center text-center p-2 text-slate-400 cursor-pointer hover:bg-slate-100 hover:border-brand-blue">
                            <UploadCloud size={32} />
                            <span className="text-xs font-bold mt-1">Upload up to 4 reference images</span>
                            <input type="file" multiple accept="image/*" className="hidden" onChange={handleFileChange} />
                        </label>
                        <div className="grid grid-cols-2 gap-2 h-1/2">
                            {customImages.map((src, i) => <img key={i} src={src} className="w-full h-full object-cover rounded border-2 border-black cursor-pointer" onClick={() => setPreviewImage(src)} />)}
                        </div>
                    </div>
                    <div className="p-6 flex flex-col flex-1">
                        <h3 className="text-xl font-display text-black mb-2 uppercase">Custom Layout</h3>
                        <p className="text-xs text-slate-600 font-comic mb-4 flex-1">Let the AI analyze your favorite layouts.</p>

                        {customLayoutPrompt && (
                            <div className="mb-4 p-3 bg-brand-yellow/20 border-2 border-dashed border-black rounded-lg text-xs font-bold text-black">
                                <span className="font-display">AI Analysis: </span>{customLayoutPrompt}
                            </div>
                        )}

                        {customLayoutPrompt ? (
                            <Button onClick={() => onLayoutConfirmed('custom', customLayoutPrompt)} variant={currentLayoutType === 'custom' ? "primary" : "secondary"} icon={<Check />}>
                                {currentLayoutType === 'custom' ? "Selected" : "Use This Layout"}
                            </Button>
                        ) : (
                            <Button onClick={handleAnalyzeLayout} variant="secondary" isLoading={isAnalyzing} disabled={customImages.length === 0} icon={<Wand2 />}>Analyze Images</Button>
                        )}
                    </div>
                </div>
            </div>

            {/* Incompatible templates (collapsed) */}
            {incompatibleTemplates.length > 0 && (
                <details className="bg-slate-50 rounded-xl border-2 border-slate-200 p-4">
                    <summary className="cursor-pointer text-sm font-bold text-slate-500 select-none">
                        Show {incompatibleTemplates.length} layout{incompatibleTemplates.length !== 1 ? 's' : ''} not optimized for {selectedFormFactor}
                    </summary>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mt-4">
                        {incompatibleTemplates.map(t => renderTemplateCard(t, true))}
                    </div>
                </details>
            )}

            {/* Text Layout */}
            <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic max-w-4xl mx-auto">
                <h3 className="text-2xl font-display text-black mb-4">Default Text Style</h3>
                <p className="text-xs text-slate-600 font-comic mb-4">Set the default dialogue style for all panels. You can customize individual panels in the Review stage.</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {(['caption', 'speech_bubbles', 'chat_bubbles', 'none'] as TextLayout[]).map(layout => (
                        <button
                            key={layout}
                            onClick={() => onTextLayoutChange?.(layout)}
                            className={`border-2 border-black rounded-lg px-3 py-3 text-xs font-bold uppercase ${currentTextLayout === layout ? 'bg-brand-yellow' : 'bg-white'}`}
                        >
                            {layout.replace('_', ' ')}
                        </button>
                    ))}
                </div>

                {/* Dialogue Mode Toggle */}
                <div className="mt-6 pt-6 border-t-2 border-slate-200">
                    <h4 className="text-lg font-display text-black mb-2">Default Dialogue Mode</h4>
                    <p className="text-xs text-slate-600 font-comic mb-3">Set the starting dialogue mode. Override individual panels in Review.</p>
                    <div className="flex gap-3 mb-4">
                        {(['universal', 'per_panel'] as const).map(mode => (
                            <button
                                key={mode}
                                onClick={() => onDialogueModeChange?.(mode)}
                                className={`flex-1 border-2 border-black rounded-lg px-3 py-3 text-xs font-bold uppercase transition-all ${currentDialogueMode === mode ? 'bg-brand-blue text-white' : 'bg-white hover:bg-slate-50'
                                    }`}
                            >
                                {mode === 'universal' ? '🌐 Universal' : '🎯 Per-Panel'}
                            </button>
                        ))}
                    </div>
                    <p className="text-[10px] text-slate-500 font-comic">
                        {currentDialogueMode === 'universal'
                            ? 'One dialogue style applies to all panels. You can still override individual panels in the review stage.'
                            : 'Full control over each panel\'s dialogue style individually.'}
                    </p>

                    {currentDialogueMode === 'universal' && (
                        <div className="mt-4">
                            <h5 className="text-sm font-display text-black mb-2">Bubble Style</h5>
                            <div className="grid grid-cols-4 gap-2">
                                {(['speech', 'thought', 'narration', 'shout'] as const).map(style => (
                                    <button
                                        key={style}
                                        onClick={() => onDialogueStyleChange?.(style)}
                                        className={`border-2 border-black rounded-lg px-2 py-2 text-xs font-bold capitalize transition-all ${currentDialogueStyle === style ? 'bg-brand-yellow' : 'bg-white hover:bg-slate-50'
                                            }`}
                                    >
                                        {style === 'speech' ? '💬' : style === 'thought' ? '💭' : style === 'narration' ? '📖' : '💥'} {style}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
            {pendingConfirmTemplate && (
                <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
                    <div className="bg-white border-4 border-black rounded-xl shadow-comic p-6 max-w-md space-y-4">
                        <h3 className="text-2xl font-display">Confirm Non-Recommended Layout</h3>
                        <p className="text-sm text-slate-600 font-comic">
                            "{pendingConfirmTemplate.title}" is not the top recommended layout for your story pacing.
                            Continue anyway?
                        </p>
                        <div className="flex justify-end gap-2">
                            <Button variant="secondary" onClick={() => setPendingConfirmTemplate(null)}>
                                Cancel
                            </Button>
                            <Button
                                onClick={() => {
                                    onLayoutConfirmed(pendingConfirmTemplate.id as LayoutType, undefined, pendingConfirmTemplate.id);
                                    setPendingConfirmTemplate(null);
                                }}
                            >
                                Confirm Selection
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
