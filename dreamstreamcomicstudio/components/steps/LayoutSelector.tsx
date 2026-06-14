import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, UploadCloud, Wand2, Check, Grid, ArrowRight } from 'lucide-react';
import { ComicAgentSettings, LayoutType, TextLayout, AspectRatio, Scene, PricingConfig } from '../../types';
import { analyzeLayoutFromImages } from '../../services/geminiService';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { GRID_TEMPLATES, getTemplatesForRatio, getTemplateById, GridTemplate, PanelSlot } from '../../services/gridTemplates';
import { FEATURE_FLAGS } from '../../services/modelPolicy';
import { recommendLayouts } from '../../services/layoutRecommendation';
import { estimateStoryCostRange } from '../../services/costProjection';
import { agentConfirmLabel, normalizeComicAgentSettings, outputTargetLabel, shouldAutoRunComicAgent } from '../../services/comicAgentSettings';
import { AgentStageShell } from '../AgentStageShell';

interface LayoutSelectorProps {
    onLayoutConfirmed: (layout: LayoutType, customPrompt?: string, gridTemplateId?: string, pageCount?: number) => void;
    currentLayoutType?: LayoutType;
    currentGridTemplateId?: string;
    currentPageCount?: number;
    selectedFormFactor?: AspectRatio;
    scenes: Scene[];
    projectId: string;
    currentTextLayout?: TextLayout;
    onTextLayoutChange?: (layout: TextLayout) => void;
    currentDialogueMode?: 'universal' | 'per_panel';
    onDialogueModeChange?: (mode: 'universal' | 'per_panel') => void;
    currentDialogueStyle?: 'speech' | 'thought' | 'narration' | 'shout';
    onDialogueStyleChange?: (style: 'speech' | 'thought' | 'narration' | 'shout') => void;
    agentSettings?: ComicAgentSettings;
    pricingConfig?: PricingConfig;
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
    'bg-brand-red/20',
    'bg-brand-yellow/30',
    'bg-green-300/30',
    'bg-purple-300/30',
    'bg-pink-300/30',
    'bg-amber-300/30',
    'bg-cyan-300/30',
    'bg-sky-300/30',
];

function SlotPreview({ slots }: { slots: PanelSlot[] }) {
    return (
        <div className="w-full h-full relative overflow-hidden rounded-md border-2 border-black bg-slate-100">
            {slots.map((slot, i) => (
                <div
                    key={slot.id}
                    className={`absolute ${SLOT_COLORS[i % SLOT_COLORS.length]} rounded-sm border-2 border-black`}
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
    currentPageCount,
    selectedFormFactor,
    scenes,
    projectId,
    currentTextLayout = 'caption',
    onTextLayoutChange,
    currentDialogueMode = 'universal',
    onDialogueModeChange,
    currentDialogueStyle = 'speech',
    onDialogueStyleChange,
    agentSettings: rawAgentSettings,
    pricingConfig
}) => {
    const [customImages, setCustomImages] = useState<string[]>([]);
    const [customLayoutPrompt, setCustomLayoutPrompt] = useState<string | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const autoStartBuildRef = useRef(false);
    // Confirming this stage now LAUNCHES the build (the manual panel-plan stage is gone),
    // so a card click only selects — the explicit button below is the one spend gesture.
    const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(currentGridTemplateId || null);
    const [selectedCustom, setSelectedCustom] = useState(currentLayoutType === 'custom');
    const [pageCount, setPageCount] = useState<number>(() => Math.min(60, Math.max(1, currentPageCount || Math.ceil(Math.max(1, scenes.length) / 3))));

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

    // Never let the grid be empty (which would make the stage feel like a dead-end if a
    // form-factor ratio matched no template): fall back to all templates.
    const displayTemplates = compatibleTemplates.length > 0 ? compatibleTemplates : GRID_TEMPLATES;

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

    // One click = select only. Confirming launches the image build, so the explicit
    // "Generate my comic" button below is the single spend gesture.
    const handleSelectTemplate = (template: GridTemplate) => {
        setSelectedCustom(false);
        setSelectedTemplateId(template.id);
    };

    const effectiveTemplateId = selectedCustom ? null : (selectedTemplateId || currentGridTemplateId || recommendedTemplateId || displayTemplates[0]?.id);
    const effectivePanelCount = getTemplateById(effectiveTemplateId || '')?.panelCount || 3;
    const minimumPageCount = Math.max(1, Math.ceil(Math.max(1, scenes.length) / effectivePanelCount));
    const plannedPanelTarget = Math.max(scenes.length, pageCount * effectivePanelCount);
    const agentSettings = useMemo(() => normalizeComicAgentSettings(rawAgentSettings), [rawAgentSettings]);
    const autoRunAgent = shouldAutoRunComicAgent(agentSettings);
    const costProjection = useMemo(
        () => estimateStoryCostRange({
            pricingConfig,
            pageRange: { min: pageCount, max: pageCount },
            panelsPerPageRange: { min: effectivePanelCount, max: effectivePanelCount }
        }),
        [effectivePanelCount, pageCount, pricingConfig]
    );
    const budgetExceeded = typeof agentSettings.budgetCapUsd === 'number' && costProjection.maxUsd > agentSettings.budgetCapUsd;
    const shouldConfirmSpend =
        budgetExceeded ||
        agentSettings.confirmPolicy === 'always' ||
        (agentSettings.confirmPolicy === 'big_spends' && (budgetExceeded || costProjection.maxUsd >= 0.5));

    useEffect(() => {
        setPageCount((count) => Math.min(60, Math.max(minimumPageCount, count)));
    }, [minimumPageCount]);

    // The one explicit launch: layout + page count → straight into the build.
    const startBuild = useCallback(() => {
        if (shouldConfirmSpend) {
            const capLine = agentSettings.budgetCapUsd
                ? `\nBudget cap: $${agentSettings.budgetCapUsd.toFixed(2)}${budgetExceeded ? ' (projected over cap)' : ''}`
                : '';
            const ok = window.confirm(
                `Start comic build?\n\nEstimated spend: $${costProjection.minUsd.toFixed(2)}-$${costProjection.maxUsd.toFixed(2)} for ${plannedPanelTarget} panels.${capLine}`
            );
            if (!ok) return;
        }
        if (selectedCustom && customLayoutPrompt) {
            onLayoutConfirmed('custom', customLayoutPrompt, undefined, pageCount);
            return;
        }
        if (effectiveTemplateId) onLayoutConfirmed(effectiveTemplateId as LayoutType, undefined, effectiveTemplateId, pageCount);
    }, [
        agentSettings.budgetCapUsd,
        budgetExceeded,
        costProjection.maxUsd,
        costProjection.minUsd,
        customLayoutPrompt,
        effectiveTemplateId,
        onLayoutConfirmed,
        pageCount,
        plannedPanelTarget,
        selectedCustom,
        shouldConfirmSpend
    ]);

    useEffect(() => {
        autoStartBuildRef.current = false;
    }, [projectId]);

    useEffect(() => {
        if (!autoRunAgent || autoStartBuildRef.current || shouldConfirmSpend) return;
        if (selectedCustom && !customLayoutPrompt) return;
        if (!selectedCustom && !effectiveTemplateId) return;

        autoStartBuildRef.current = true;
        startBuild();
    }, [
        autoRunAgent,
        customLayoutPrompt,
        effectiveTemplateId,
        selectedCustom,
        shouldConfirmSpend,
        startBuild
    ]);

    // ---- Render helpers ----------------------------------------------------

    const renderTemplateCard = (template: GridTemplate, isIncompatible = false) => {
        const isSelected = !selectedCustom && effectiveTemplateId === template.id;

        return (
            <div
                key={template.id}
                className={`group relative flex flex-col overflow-hidden rounded-xl border-4 border-black bg-white shadow-comic transition-colors ${isSelected
                    ? 'border-brand-blue ring-2 ring-brand-blue'
                    : isIncompatible
                        ? 'border-black opacity-45'
                        : 'border-black hover:border-brand-blue'
                    }`}
            >
                <div className="relative aspect-[3/4] border-b-2 border-black bg-slate-100 p-3">
                    <SlotPreview slots={template.panelSlots} />
                    {isSelected && (
                        <div className="absolute right-2 top-2 rounded-full border-2 border-black bg-brand-blue p-1 text-white">
                            <Check size={16} strokeWidth={3} />
                        </div>
                    )}
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full border-2 border-black bg-white px-2 py-1 text-[10px] font-semibold text-black">
                        <Grid size={10} />
                        {template.panelCount} panel{template.panelCount !== 1 ? 's' : ''}
                    </div>
                    {isIncompatible && (
                        <div className="absolute left-2 top-2 rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-semibold text-amber-700 border-2 border-black">
                            Not optimal
                        </div>
                    )}
                    {template.id === recommendedTemplateId && (
                        <div className="absolute left-2 top-2 rounded-full bg-green-100 px-2 py-0.5 text-[9px] font-semibold text-green-700 border-2 border-black">
                            Recommended
                        </div>
                    )}
                </div>
                <div className="flex flex-1 flex-col p-4">
                    <h3 className="mb-2 font-display text-black">{template.title}</h3>
                    <p className="mb-3 flex-1 text-xs leading-5 text-slate-600 font-comic">{template.description}</p>
                    <div className="mb-4 flex flex-wrap gap-1">
                        {template.tags.slice(0, 3).map(tag => (
                            <span key={tag} className="rounded-full border-2 border-black bg-white px-2 py-0.5 text-[9px] font-bold text-slate-600">
                                {tag}
                            </span>
                        ))}
                    </div>
                    <Button
                        onClick={() => handleSelectTemplate(template)}
                        variant={isSelected ? "secondary" : "outline"}
                        className={`w-full ${isSelected ? 'border-2 border-brand-blue' : 'border-2 border-black text-black hover:bg-brand-yellow'}`}
                        disabled={isIncompatible}
                    >
                        {isSelected ? "Selected" : isIncompatible ? "Unavailable" : "Select"}
                    </Button>
                </div>
            </div>
        );
    };

    return (
        <AgentStageShell
            eyebrow="Pages agent"
            title="Choose page rhythm"
            description={autoRunAgent && !shouldConfirmSpend ? 'Autopilot is using the recommended page plan and launching the build.' : 'Pick the grid and page count. The agent will plan panels, render pages, and prepare the selected outputs.'}
            icon={<LayoutTemplate className="h-5 w-5" />}
            actions={(
                <Button
                    variant="secondary"
                    onClick={startBuild}
                    icon={<ArrowRight className="h-4 w-4" />}
                    className="border-2 border-black"
                >
                    {autoRunAgent && !shouldConfirmSpend ? 'Autopilot build' : 'Start build'}
                </Button>
            )}
            sidebar={(
                <div className="space-y-5">
                    <div>
                        <div className="font-display text-black uppercase">Pages</div>
                        <p className="mt-1 text-sm leading-6 text-slate-600 font-comic">
                            {plannedPanelTarget} panels across {scenes.length} scene{scenes.length === 1 ? '' : 's'}.
                        </p>
                        <div className="mt-4 flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setPageCount((n) => Math.max(minimumPageCount, n - 1))}
                                className="flex h-11 w-11 items-center justify-center rounded-xl border-2 border-black bg-white text-xl font-semibold text-black hover:bg-brand-yellow"
                                aria-label="Fewer pages"
                            >
                                -
                            </button>
                            <input
                                type="number"
                                min={minimumPageCount}
                                max={60}
                                value={pageCount}
                                onChange={(e) => setPageCount(Math.min(60, Math.max(minimumPageCount, Math.floor(Number(e.target.value) || minimumPageCount))))}
                                className="h-11 w-24 rounded-xl border-2 border-black bg-white text-center text-lg font-semibold text-black outline-none focus:border-brand-blue"
                                aria-label="Page count"
                            />
                            <button
                                type="button"
                                onClick={() => setPageCount((n) => Math.min(60, n + 1))}
                                className="flex h-11 w-11 items-center justify-center rounded-xl border-2 border-black bg-white text-xl font-semibold text-black hover:bg-brand-yellow"
                                aria-label="More pages"
                            >
                                +
                            </button>
                        </div>
                    </div>

                    <div className="rounded-xl border-2 border-black bg-slate-50 p-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <span className="font-display text-black uppercase">Cost guard</span>
                            <span className={budgetExceeded ? 'text-sm font-semibold text-brand-red' : 'text-sm font-mono text-black'}>
                                ${costProjection.minUsd.toFixed(2)}-${costProjection.maxUsd.toFixed(2)}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                            <span className="rounded-full border-2 border-black bg-white px-2 py-1">{agentConfirmLabel(agentSettings.confirmPolicy)}</span>
                            {agentSettings.outputTargets.map((target) => (
                                <span key={target} className="rounded-full border-2 border-black bg-white px-2 py-1">{outputTargetLabel(target)}</span>
                            ))}
                            {agentSettings.budgetCapUsd && (
                                <span className={`rounded-full px-2 py-1 ${budgetExceeded ? 'bg-red-100 text-red-700 border-2 border-black' : 'bg-white border-2 border-black'}`}>
                                    Cap ${agentSettings.budgetCapUsd.toFixed(2)}
                                </span>
                            )}
                        </div>
                    </div>

                    <div>
                        <div className="mb-2 text-xs font-semibold uppercase text-slate-600">Lettering</div>
                        <div className="grid grid-cols-2 gap-2">
                            {(['caption', 'speech_bubbles', 'chat_bubbles', 'none'] as TextLayout[]).map(layout => (
                                <button
                                    key={layout}
                                    type="button"
                                    onClick={() => onTextLayoutChange?.(layout)}
                                    className={`rounded-xl px-3 py-2 text-left text-xs font-semibold capitalize transition-colors ${currentTextLayout === layout ? 'bg-brand-yellow text-black border-2 border-black' : 'bg-white text-slate-600 border-2 border-black hover:bg-brand-yellow hover:text-black'}`}
                                >
                                    {layout.replace(/_/g, ' ')}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <div className="mb-2 text-xs font-semibold uppercase text-slate-600">Dialogue</div>
                        <div className="grid grid-cols-2 gap-2">
                            {(['universal', 'per_panel'] as const).map(mode => (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => onDialogueModeChange?.(mode)}
                                    className={`rounded-xl px-3 py-2 text-left text-xs font-semibold transition-colors ${currentDialogueMode === mode ? 'bg-brand-yellow text-black border-2 border-black' : 'bg-white text-slate-600 border-2 border-black hover:bg-brand-yellow hover:text-black'}`}
                                >
                                    {mode === 'universal' ? 'Universal' : 'Per panel'}
                                </button>
                            ))}
                        </div>
                        {currentDialogueMode === 'universal' && (
                            <div className="mt-3 grid grid-cols-2 gap-2">
                                {(['speech', 'thought', 'narration', 'shout'] as const).map(style => (
                                    <button
                                        key={style}
                                        type="button"
                                        onClick={() => onDialogueStyleChange?.(style)}
                                        className={`rounded-xl px-3 py-2 text-left text-xs font-semibold capitalize transition-colors ${currentDialogueStyle === style ? 'bg-brand-blue text-white border-2 border-black' : 'bg-white text-slate-600 border-2 border-black hover:bg-brand-yellow hover:text-black'}`}
                                    >
                                        {style}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                </div>
            )}
        >
            <div className="flex min-h-[680px] flex-col">
                <div className="flex flex-col gap-3 border-b-2 border-black px-5 py-4 md:flex-row md:items-center md:justify-between">
                    <div>
                        <div className="font-display text-black uppercase">Layout board</div>
                        <div className="mt-1 text-xs text-slate-600 font-comic">
                            {recommendedTemplateId
                                ? `Recommended: ${getTemplateById(recommendedTemplateId).title}${recommendedReason ? ` - ${recommendedReason}` : ''}`
                                : 'Choose a grid'}
                        </div>
                    </div>
                    {selectedFormFactor && (
                        <div className="rounded-full border-2 border-black bg-white px-3 py-1 text-xs font-bold text-black">
                            {selectedFormFactor} format
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                        {displayTemplates.map(t => renderTemplateCard(t))}

                        <div className={`group relative flex flex-col overflow-hidden rounded-xl border-4 border-black bg-white shadow-comic transition-colors md:col-span-2 xl:col-span-1 ${selectedCustom ? 'border-brand-blue ring-2 ring-brand-blue' : 'border-black hover:border-brand-blue'}`}>
                            <div className="relative flex aspect-[3/4] flex-col gap-2 border-b-2 border-black bg-slate-100 p-3">
                                {selectedCustom && (
                                    <div className="absolute right-2 top-2 z-10 rounded-full border-2 border-black bg-brand-blue p-1 text-white">
                                        <Check size={16} strokeWidth={3} />
                                    </div>
                                )}
                                <label className="flex flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border-dashed border-2 border-black p-3 text-center text-slate-600 hover:bg-brand-yellow/20 hover:text-black">
                                    <UploadCloud size={28} />
                                    <span className="mt-2 text-xs font-semibold">Upload layout refs</span>
                                    <input type="file" multiple accept="image/*" className="hidden" onChange={handleFileChange} />
                                </label>
                                {customImages.length > 0 && (
                                    <div className="grid h-1/2 grid-cols-2 gap-2">
                                        {customImages.map((src, i) => (
                                            <button key={i} type="button" onClick={() => setPreviewImage(src)} className="overflow-hidden rounded border-2 border-black">
                                                <img src={src} className="h-full w-full object-cover" />
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex flex-1 flex-col p-4">
                                <h3 className="mb-2 font-display text-black uppercase">Custom layout</h3>
                                <p className="mb-3 flex-1 text-xs leading-5 text-slate-600 font-comic">Analyze up to four reference images.</p>

                                {customLayoutPrompt && (
                                    <div className="mb-3 rounded-xl border-2 border-black bg-slate-50 p-3 text-xs leading-5 text-black">
                                        {customLayoutPrompt}
                                    </div>
                                )}

                                {customLayoutPrompt ? (
                                    <Button
                                        onClick={() => setSelectedCustom(true)}
                                        variant={selectedCustom ? "secondary" : "outline"}
                                        className={`w-full ${selectedCustom ? 'border-2 border-brand-blue' : 'border-2 border-black text-black hover:bg-brand-yellow'}`}
                                        icon={<Check />}
                                    >
                                        {selectedCustom ? "Selected" : "Use layout"}
                                    </Button>
                                ) : (
                                    <Button
                                        onClick={handleAnalyzeLayout}
                                        variant="outline"
                                        isLoading={isAnalyzing}
                                        disabled={customImages.length === 0}
                                        className="w-full border-2 border-black text-black hover:bg-brand-yellow"
                                        icon={<Wand2 />}
                                    >
                                        Read refs
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    {incompatibleTemplates.length > 0 && (
                        <details className="mt-5 rounded-xl border-2 border-black bg-slate-50 p-4">
                            <summary className="cursor-pointer select-none text-sm font-semibold text-slate-600">
                                Show {incompatibleTemplates.length} layout{incompatibleTemplates.length !== 1 ? 's' : ''} outside {selectedFormFactor}
                            </summary>
                            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                                {incompatibleTemplates.map(t => renderTemplateCard(t, true))}
                            </div>
                        </details>
                    )}
                </div>
            </div>

            {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
        </AgentStageShell>
    );
};
