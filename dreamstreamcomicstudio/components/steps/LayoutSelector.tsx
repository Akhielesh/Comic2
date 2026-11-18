import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, UploadCloud, Wand2, Check, Grid, ArrowRight, AlertCircle } from 'lucide-react';
import { ComicAgentSettings, LayoutType, TextLayout, AspectRatio, Scene, PricingConfig } from '../../types';
import { analyzeLayoutFromImages } from '../../services/geminiService';
import { Button } from '../ds/Button';
import { cn } from '../../lib/utils';
import {
    CHIP,
    CHIP_VARIANT,
    DENSITY,
    FIELD,
    FOCUS_RING,
    INK_TILE,
    OVERLINE,
    RADIUS_CONTROL,
    RADIUS_PANEL,
    RADIUS_PILL,
    SHADOW_SOFT,
    STATUS_CHIP,
    TONE_CHIP_ON_ART,
    TRANSITION,
    WRAP_TEXT,
    Z
} from '../chat/studioDesign';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { GRID_TEMPLATES, getTemplatesForRatio, getTemplateById, GridTemplate, PanelSlot } from '../../services/gridTemplates';
import { FEATURE_FLAGS } from '../../services/modelPolicy';
import { recommendLayouts } from '../../services/layoutRecommendation';
import { estimateStoryCostRange } from '../../services/costProjection';
import { agentConfirmLabel, normalizeComicAgentSettings, outputTargetLabel, shouldAutoRunComicAgent } from '../../services/comicAgentSettings';
import { AgentStageShell, STAGE_BOARD_HEADER, STAGE_BOARD_TITLE, STAGE_BODY, STAGE_CARD, STAGE_WELL, UPLOAD_TILE } from '../AgentStageShell';

/** The page stepper's square buttons: 44 px, outline control. */
const STEPPER_BUTTON = cn(
    'flex h-11 w-11 shrink-0 items-center justify-center border border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[length:var(--ds-text-lg)] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]',
    RADIUS_CONTROL,
    TRANSITION,
    FOCUS_RING
);
/** A choice in a small grid of options (lettering, dialogue): the selected one is ink-edged on the accent step. */
const OPTION_BUTTON = cn('min-h-9 border px-3 py-2 text-left text-xs font-medium', DENSITY.coarse, RADIUS_CONTROL, TRANSITION, FOCUS_RING);
const OPTION_ON = 'border-[var(--ds-ink)] bg-[var(--ds-accent-soft)] text-[var(--ds-ink)]';
const OPTION_OFF = 'border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]';
/** A status pill drawn over the layout well. */
const STATUS_CHIP_ON_ART = { attention: TONE_CHIP_ON_ART.warning, healthy: TONE_CHIP_ON_ART.success } as const;

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

// The template's panel slots drawn as a wireframe on the art well (monochrome: the slots are a
// diagram of the page, not a palette).
function SlotPreview({ slots }: { slots: PanelSlot[] }) {
    return (
        <div className="relative h-full w-full overflow-hidden rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)]">
            {slots.map((slot) => (
                <div
                    key={slot.id}
                    className="absolute rounded-[var(--ds-radius-sm)] border border-[var(--ds-control-border)] bg-[var(--ds-surface)]"
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
                className={cn(
                    'group relative isolate flex min-w-0 flex-col overflow-hidden border bg-[var(--ds-surface)]',
                    RADIUS_PANEL,
                    SHADOW_SOFT,
                    TRANSITION,
                    isSelected
                        ? 'border-[var(--ds-ink)] ring-1 ring-[var(--ds-ink)]'
                        : isIncompatible
                            ? 'border-[var(--ds-hairline)] opacity-60'
                            : 'border-[var(--ds-hairline)] hover:border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)]'
                )}
            >
                <div className="relative aspect-[3/4] border-b border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3">
                    <SlotPreview slots={template.panelSlots} />
                    {isSelected && (
                        <div className={cn('absolute right-2 top-2 flex h-6 w-6 items-center justify-center', RADIUS_PILL, INK_TILE)}>
                            <Check size={14} strokeWidth={3} aria-hidden="true" />
                        </div>
                    )}
                    <div className={cn('absolute bottom-2 left-2 tabular-nums', CHIP, CHIP_VARIANT.filled)}>
                        <Grid size={10} aria-hidden="true" />
                        {template.panelCount} panel{template.panelCount !== 1 ? 's' : ''}
                    </div>
                    {isIncompatible && (
                        <div className={cn('absolute left-2 top-2', STATUS_CHIP, STATUS_CHIP_ON_ART.attention)}>
                            Not optimal
                        </div>
                    )}
                    {template.id === recommendedTemplateId && (
                        <div className={cn('absolute left-2 top-2', STATUS_CHIP, STATUS_CHIP_ON_ART.healthy)}>
                            Recommended
                        </div>
                    )}
                </div>
                <div className="flex flex-1 flex-col p-4">
                    <h3 className={cn('mb-2', STAGE_BOARD_TITLE, WRAP_TEXT)}>{template.title}</h3>
                    <p className={cn('mb-3 flex-1 text-xs leading-5 text-[var(--ds-muted)]', WRAP_TEXT)}>{template.description}</p>
                    <div className="mb-4 flex flex-wrap gap-1">
                        {template.tags.slice(0, 3).map(tag => (
                            <span key={tag} className={cn(CHIP, CHIP_VARIANT.outline)}>
                                {tag}
                            </span>
                        ))}
                    </div>
                    <Button
                        onClick={() => handleSelectTemplate(template)}
                        variant={isSelected ? 'secondary' : 'outline'}
                        className="w-full"
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
                <Button onClick={startBuild}>
                    <ArrowRight className="h-4 w-4" />
                    {autoRunAgent && !shouldConfirmSpend ? 'Autopilot build' : 'Start build'}
                </Button>
            )}
            sidebar={(
                <div className="space-y-5">
                    <div>
                        <h3 className={STAGE_BOARD_TITLE}>Pages</h3>
                        <p className={cn('mt-1', STAGE_BODY)}>
                            {plannedPanelTarget} panels across {scenes.length} scene{scenes.length === 1 ? '' : 's'}.
                        </p>
                        <div className="mt-4 flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setPageCount((n) => Math.max(minimumPageCount, n - 1))}
                                className={STEPPER_BUTTON}
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
                                className={cn(FIELD, 'h-11 w-24 text-center text-[length:var(--ds-text-lg)] font-semibold tabular-nums')}
                                aria-label="Page count"
                            />
                            <button
                                type="button"
                                onClick={() => setPageCount((n) => Math.min(60, n + 1))}
                                className={STEPPER_BUTTON}
                                aria-label="More pages"
                            >
                                +
                            </button>
                        </div>
                    </div>

                    <div className={cn('p-4', STAGE_CARD)}>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <h3 className={STAGE_BOARD_TITLE}>Cost guard</h3>
                            <span className={cn('text-sm tabular-nums text-[var(--ds-ink)]', budgetExceeded ? 'font-semibold' : 'font-mono')}>
                                ${costProjection.minUsd.toFixed(2)}-${costProjection.maxUsd.toFixed(2)}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <span className={cn(CHIP, CHIP_VARIANT.outline)}>{agentConfirmLabel(agentSettings.confirmPolicy)}</span>
                            {agentSettings.outputTargets.map((target) => (
                                <span key={target} className={cn(CHIP, CHIP_VARIANT.outline)}>{outputTargetLabel(target)}</span>
                            ))}
                            {agentSettings.budgetCapUsd && (
                                <span className={cn(CHIP, budgetExceeded ? 'border-[var(--ds-ink)] bg-[var(--ds-surface)] font-semibold text-[var(--ds-ink)]' : CHIP_VARIANT.outline, 'tabular-nums')}>
                                    {budgetExceeded && <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />}
                                    Cap ${agentSettings.budgetCapUsd.toFixed(2)}
                                </span>
                            )}
                        </div>
                    </div>

                    <div>
                        <div className={cn('mb-2', OVERLINE)}>Lettering</div>
                        <div className="grid grid-cols-2 gap-2">
                            {(['caption', 'speech_bubbles', 'chat_bubbles', 'none'] as TextLayout[]).map(layout => (
                                <button
                                    key={layout}
                                    type="button"
                                    aria-pressed={currentTextLayout === layout}
                                    onClick={() => onTextLayoutChange?.(layout)}
                                    className={cn(OPTION_BUTTON, 'capitalize', currentTextLayout === layout ? OPTION_ON : OPTION_OFF)}
                                >
                                    {layout.replace(/_/g, ' ')}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <div className={cn('mb-2', OVERLINE)}>Dialogue</div>
                        <div className="grid grid-cols-2 gap-2">
                            {(['universal', 'per_panel'] as const).map(mode => (
                                <button
                                    key={mode}
                                    type="button"
                                    aria-pressed={currentDialogueMode === mode}
                                    onClick={() => onDialogueModeChange?.(mode)}
                                    className={cn(OPTION_BUTTON, currentDialogueMode === mode ? OPTION_ON : OPTION_OFF)}
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
                                        aria-pressed={currentDialogueStyle === style}
                                        onClick={() => onDialogueStyleChange?.(style)}
                                        className={cn(OPTION_BUTTON, 'capitalize', currentDialogueStyle === style ? OPTION_ON : OPTION_OFF)}
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
                <div className={STAGE_BOARD_HEADER}>
                    <div className="min-w-0">
                        <h3 className={STAGE_BOARD_TITLE}>Layout board</h3>
                        <div className={cn('mt-1 text-xs text-[var(--ds-muted)]', WRAP_TEXT)}>
                            {recommendedTemplateId
                                ? `Recommended: ${getTemplateById(recommendedTemplateId).title}${recommendedReason ? ` - ${recommendedReason}` : ''}`
                                : 'Choose a grid'}
                        </div>
                    </div>
                    {selectedFormFactor && (
                        <span className={cn(CHIP, CHIP_VARIANT.outline)}>
                            {selectedFormFactor} format
                        </span>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                        {displayTemplates.map(t => renderTemplateCard(t))}

                        <div
                            className={cn(
                                'group relative isolate flex min-w-0 flex-col overflow-hidden border bg-[var(--ds-surface)] md:col-span-2 xl:col-span-1',
                                RADIUS_PANEL,
                                SHADOW_SOFT,
                                TRANSITION,
                                selectedCustom
                                    ? 'border-[var(--ds-ink)] ring-1 ring-[var(--ds-ink)]'
                                    : 'border-[var(--ds-hairline)] hover:border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)]'
                            )}
                        >
                            <div className="relative flex aspect-[3/4] flex-col gap-2 border-b border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3">
                                {selectedCustom && (
                                    <div className={cn('absolute right-2 top-2 flex h-6 w-6 items-center justify-center', Z.chrome, RADIUS_PILL, INK_TILE)}>
                                        <Check size={14} strokeWidth={3} aria-hidden="true" />
                                    </div>
                                )}
                                <label className={cn(UPLOAD_TILE, 'flex-1 flex-col justify-center gap-0 text-center')}>
                                    <UploadCloud size={28} aria-hidden="true" />
                                    <span className="mt-2 text-xs font-medium">Upload layout refs</span>
                                    <input type="file" multiple accept="image/*" className="hidden" onChange={handleFileChange} />
                                </label>
                                {customImages.length > 0 && (
                                    <div className="grid h-1/2 grid-cols-2 gap-2">
                                        {customImages.map((src, i) => (
                                            <button
                                                key={i}
                                                type="button"
                                                onClick={() => setPreviewImage(src)}
                                                className={cn('overflow-hidden rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)]', FOCUS_RING)}
                                            >
                                                <img src={src} className="h-full w-full object-cover" />
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex flex-1 flex-col p-4">
                                <h3 className={cn('mb-2', STAGE_BOARD_TITLE)}>Custom layout</h3>
                                <p className="mb-3 flex-1 text-xs leading-5 text-[var(--ds-muted)]">Analyze up to four reference images.</p>

                                {customLayoutPrompt && (
                                    <div className={cn('mb-3 p-3 text-xs leading-5 text-[var(--ds-ink)]', STAGE_WELL, WRAP_TEXT)}>
                                        {customLayoutPrompt}
                                    </div>
                                )}

                                {customLayoutPrompt ? (
                                    <Button
                                        onClick={() => setSelectedCustom(true)}
                                        variant={selectedCustom ? 'secondary' : 'outline'}
                                        className="w-full"
                                    >
                                        <Check />
                                        {selectedCustom ? "Selected" : "Use layout"}
                                    </Button>
                                ) : (
                                    <Button
                                        onClick={handleAnalyzeLayout}
                                        variant="outline"
                                        loading={isAnalyzing}
                                        disabled={isAnalyzing || customImages.length === 0}
                                        className="w-full"
                                    >
                                        {isAnalyzing ? null : <Wand2 />}
                                        Read refs
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    {incompatibleTemplates.length > 0 && (
                        <details className={cn('mt-5 p-4', STAGE_WELL)}>
                            <summary className={cn('cursor-pointer select-none rounded-[var(--ds-radius-sm)] text-sm font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)]', DENSITY.coarse, FOCUS_RING)}>
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
