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
    'bg-sky-300/20',
    'bg-emerald-300/20',
    'bg-rose-300/20',
    'bg-zinc-200/20',
    'bg-emerald-200/40',
    'bg-purple-200/40',
    'bg-amber-200/40',
    'bg-pink-200/40',
    'bg-cyan-200/40',
];

function SlotPreview({ slots }: { slots: PanelSlot[] }) {
    return (
        <div className="w-full h-full relative overflow-hidden rounded-md border border-zinc-700 bg-zinc-950">
            {slots.map((slot, i) => (
                <div
                    key={slot.id}
                    className={`absolute ${SLOT_COLORS[i % SLOT_COLORS.length]} rounded-sm border border-zinc-600`}
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
                className={`group relative flex flex-col overflow-hidden rounded-lg border bg-zinc-950 transition-colors ${isSelected
                    ? 'border-emerald-300 ring-2 ring-emerald-300/30'
                    : isIncompatible
                        ? 'border-zinc-800 opacity-45'
                        : 'border-zinc-800 hover:border-zinc-500'
                    }`}
            >
                <div className="relative aspect-[3/4] border-b border-zinc-800 bg-zinc-900 p-3">
                    <SlotPreview slots={template.panelSlots} />
                    {isSelected && (
                        <div className="absolute right-2 top-2 rounded-full border border-zinc-950 bg-emerald-300 p-1 text-zinc-950">
                            <Check size={16} strokeWidth={3} />
                        </div>
                    )}
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-zinc-950 px-2 py-1 text-[10px] font-semibold text-zinc-200 ring-1 ring-zinc-700">
                        <Grid size={10} />
                        {template.panelCount} panel{template.panelCount !== 1 ? 's' : ''}
                    </div>
                    {isIncompatible && (
                        <div className="absolute left-2 top-2 rounded-full bg-amber-950 px-2 py-0.5 text-[9px] font-semibold text-amber-200 ring-1 ring-amber-800">
                            Not optimal
                        </div>
                    )}
                    {template.id === recommendedTemplateId && (
                        <div className="absolute left-2 top-2 rounded-full bg-emerald-950 px-2 py-0.5 text-[9px] font-semibold text-emerald-200 ring-1 ring-emerald-800">
                            Recommended
                        </div>
                    )}
                </div>
                <div className="flex flex-1 flex-col p-4">
                    <h3 className="mb-2 text-sm font-semibold text-zinc-100">{template.title}</h3>
                    <p className="mb-3 flex-1 text-xs leading-5 text-zinc-500">{template.description}</p>
                    <div className="mb-4 flex flex-wrap gap-1">
                        {template.tags.slice(0, 3).map(tag => (
                            <span key={tag} className="rounded-full bg-zinc-900 px-2 py-0.5 text-[9px] font-semibold text-zinc-500 ring-1 ring-zinc-800">
                                {tag}
                            </span>
                        ))}
                    </div>
                    <Button
                        onClick={() => handleSelectTemplate(template)}
                        variant={isSelected ? "secondary" : "outline"}
                        className={`w-full ${isSelected ? 'border-emerald-300' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-900 hover:text-white'}`}
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
                    className="border-zinc-100"
                >
                    {autoRunAgent && !shouldConfirmSpend ? 'Autopilot build' : 'Start build'}
                </Button>
            )}
            sidebar={(
                <div className="space-y-5">
                    <div>
                        <div className="text-sm font-semibold text-zinc-200">Pages</div>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">
                            {plannedPanelTarget} panels across {scenes.length} scene{scenes.length === 1 ? '' : 's'}.
                        </p>
                        <div className="mt-4 flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setPageCount((n) => Math.max(minimumPageCount, n - 1))}
                                className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-950 text-xl font-semibold text-zinc-200 hover:border-zinc-500"
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
                                className="h-11 w-24 rounded-lg border border-zinc-700 bg-zinc-950 text-center text-lg font-semibold text-zinc-100 outline-none focus:border-zinc-400"
                                aria-label="Page count"
                            />
                            <button
                                type="button"
                                onClick={() => setPageCount((n) => Math.min(60, n + 1))}
                                className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-950 text-xl font-semibold text-zinc-200 hover:border-zinc-500"
                                aria-label="More pages"
                            >
                                +
                            </button>
                        </div>
                    </div>

                    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-zinc-200">Cost guard</span>
                            <span className={budgetExceeded ? 'text-sm font-semibold text-red-300' : 'text-sm font-mono text-zinc-100'}>
                                ${costProjection.minUsd.toFixed(2)}-${costProjection.maxUsd.toFixed(2)}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
                            <span className="rounded-full bg-zinc-900 px-2 py-1 ring-1 ring-zinc-800">{agentConfirmLabel(agentSettings.confirmPolicy)}</span>
                            {agentSettings.outputTargets.map((target) => (
                                <span key={target} className="rounded-full bg-zinc-900 px-2 py-1 ring-1 ring-zinc-800">{outputTargetLabel(target)}</span>
                            ))}
                            {agentSettings.budgetCapUsd && (
                                <span className={`rounded-full px-2 py-1 ring-1 ${budgetExceeded ? 'bg-red-950 text-red-200 ring-red-800' : 'bg-zinc-900 ring-zinc-800'}`}>
                                    Cap ${agentSettings.budgetCapUsd.toFixed(2)}
                                </span>
                            )}
                        </div>
                    </div>

                    <div>
                        <div className="mb-2 text-xs font-semibold uppercase text-zinc-500">Lettering</div>
                        <div className="grid grid-cols-2 gap-2">
                            {(['caption', 'speech_bubbles', 'chat_bubbles', 'none'] as TextLayout[]).map(layout => (
                                <button
                                    key={layout}
                                    type="button"
                                    onClick={() => onTextLayoutChange?.(layout)}
                                    className={`rounded-lg px-3 py-2 text-left text-xs font-semibold capitalize transition-colors ${currentTextLayout === layout ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
                                >
                                    {layout.replace(/_/g, ' ')}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <div className="mb-2 text-xs font-semibold uppercase text-zinc-500">Dialogue</div>
                        <div className="grid grid-cols-2 gap-2">
                            {(['universal', 'per_panel'] as const).map(mode => (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => onDialogueModeChange?.(mode)}
                                    className={`rounded-lg px-3 py-2 text-left text-xs font-semibold transition-colors ${currentDialogueMode === mode ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
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
                                        className={`rounded-lg px-3 py-2 text-left text-xs font-semibold capitalize transition-colors ${currentDialogueStyle === style ? 'bg-emerald-300 text-zinc-950' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
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
                <div className="flex flex-col gap-3 border-b border-zinc-800 px-5 py-4 md:flex-row md:items-center md:justify-between">
                    <div>
                        <div className="text-sm font-semibold text-zinc-200">Layout board</div>
                        <div className="mt-1 text-xs text-zinc-500">
                            {recommendedTemplateId
                                ? `Recommended: ${getTemplateById(recommendedTemplateId).title}${recommendedReason ? ` - ${recommendedReason}` : ''}`
                                : 'Choose a grid'}
                        </div>
                    </div>
                    {selectedFormFactor && (
                        <div className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-zinc-400">
                            {selectedFormFactor} format
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                        {displayTemplates.map(t => renderTemplateCard(t))}

                        <div className={`group relative flex flex-col overflow-hidden rounded-lg border bg-zinc-950 transition-colors md:col-span-2 xl:col-span-1 ${selectedCustom ? 'border-emerald-300 ring-2 ring-emerald-300/30' : 'border-zinc-800 hover:border-zinc-500'}`}>
                            <div className="relative flex aspect-[3/4] flex-col gap-2 border-b border-zinc-800 bg-zinc-900 p-3">
                                {selectedCustom && (
                                    <div className="absolute right-2 top-2 z-10 rounded-full border border-zinc-950 bg-emerald-300 p-1 text-zinc-950">
                                        <Check size={16} strokeWidth={3} />
                                    </div>
                                )}
                                <label className="flex flex-1 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-700 p-3 text-center text-zinc-500 hover:border-zinc-500 hover:text-zinc-300">
                                    <UploadCloud size={28} />
                                    <span className="mt-2 text-xs font-semibold">Upload layout refs</span>
                                    <input type="file" multiple accept="image/*" className="hidden" onChange={handleFileChange} />
                                </label>
                                {customImages.length > 0 && (
                                    <div className="grid h-1/2 grid-cols-2 gap-2">
                                        {customImages.map((src, i) => (
                                            <button key={i} type="button" onClick={() => setPreviewImage(src)} className="overflow-hidden rounded border border-zinc-700">
                                                <img src={src} className="h-full w-full object-cover" />
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex flex-1 flex-col p-4">
                                <h3 className="mb-2 text-sm font-semibold text-zinc-100">Custom layout</h3>
                                <p className="mb-3 flex-1 text-xs leading-5 text-zinc-500">Analyze up to four reference images.</p>

                                {customLayoutPrompt && (
                                    <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs leading-5 text-zinc-300">
                                        {customLayoutPrompt}
                                    </div>
                                )}

                                {customLayoutPrompt ? (
                                    <Button
                                        onClick={() => setSelectedCustom(true)}
                                        variant={selectedCustom ? "secondary" : "outline"}
                                        className={`w-full ${selectedCustom ? 'border-emerald-300' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-900 hover:text-white'}`}
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
                                        className="w-full border-zinc-700 text-zinc-300 hover:bg-zinc-900 hover:text-white"
                                        icon={<Wand2 />}
                                    >
                                        Read refs
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    {incompatibleTemplates.length > 0 && (
                        <details className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                            <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-400">
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
