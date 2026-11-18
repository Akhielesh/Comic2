import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Check, Download, Edit2, RefreshCw, History, Share2, FileCode, ArrowLeftRight, Terminal } from 'lucide-react';
import { AgentOutputTarget, ComicExportTarget, ComicPanel, ComicState, ProjectReport, Project } from '../../types';
import { PanelDialogue } from '../PanelDialogue';
import { regenerateSinglePanel } from '../../services/generationManager';
import { runContinuityAudit } from '../../services/geminiService';
import { Button } from '../ds/Button';
import { IconButton } from '../ds/IconButton';
import { cn } from '../../lib/utils';
import {
  DENSITY,
  FOCUS_ITEM,
  HAIRLINE,
  OVERLAY,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RADIUS_ROUND,
  SCRIM,
  SHADOW_SOFT,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_DOT,
  TEXT_XL,
  TONE_CHIP_ON_ART,
  TRANSITION,
  WRAP_TEXT,
  Z
} from '../chat/studioDesign';
// Lazy loaded components
const ImagePreviewModal = React.lazy(() => import('../modals/ImagePreviewModal').then(module => ({ default: module.ImagePreviewModal })));
const RegenerateModal = React.lazy(() => import('../modals/RegenerateModal').then(module => ({ default: module.RegenerateModal })));
const HistoryModal = React.lazy(() => import('../modals/HistoryModal').then(module => ({ default: module.HistoryModal })));
const BubbleEditorModal = React.lazy(() => import('../modals/BubbleEditorModal').then(module => ({ default: module.BubbleEditorModal })));
const ShareModal = React.lazy(() => import('../modals/ShareModal').then(module => ({ default: module.ShareModal })));

import { exportProject, getImageUrl, getImageDataUrl, saveArtifact } from '../../services/db';
import { getLayoutClass as sharedGetLayoutClass, getPanelClass as sharedGetPanelClass, getGridTemplate } from '../../services/panelLayout';
import { getModelForTask } from '../../services/appSettings';
import { getImageModelById } from '../../services/imageModels';
import { buildImagePrompt } from '../../services/imagePrompt';
import { parseRatio } from '../../services/imageUtils';
import { buildProjectReport } from '../../services/reporting';
import { loadArtifactsForProject } from '../../services/db';
import { downloadBlob } from '../../services/download';
import { appendCappedHistory } from '../../services/projectStorage';
import { ApiError } from '../../services/apiClient';
import { LimitExceededModal } from '../modals/LimitExceededModal';
import { getComicCost } from '../../services/billing';
import { costContextFromAllowance } from '../../services/costDisplay';
import { useUsageAllowance } from '../usage/useUsageAllowance';
import { aiUsageForExport, artifactsForExport, comicCostView, costSummaryForExport, isGovernedComicCost, localCostLabel, projectForExport, type ComicCostResponse } from './comicCostDisplay';
import { normalizeComicAgentSettings, outputTargetLabel } from '../../services/comicAgentSettings';
import { transitionAgentRun } from '../../services/comicAgentRun';
import { AgentStageShell, STAGE_BOARD_TITLE, STAGE_BODY, STAGE_CARD, STAGE_WELL } from '../AgentStageShell';
import { buildComicExportManifest, buildComicHtmlDocument } from '../../services/comicDeliverables';

import { legacyPdfErrorMessage, loadLegacyPdf } from '../../services/legacyPdfLoader';
import { STATUS_INK, STATUS_SURFACE } from '../ds/recipes';

interface ReviewExportProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  projectId: string;
  projectName: string;
  panels: ComicPanel[];
  state: ComicState;
  onReturnToPreview: () => void;
  onUpdatePanel: (panelId: string, imageId: string, imageUrl: string) => void;
}

// renderPanelText removed — use <PanelDialogue /> component instead
const EMPTY_EXPORTED_OUTPUTS: Partial<Record<ComicExportTarget, number>> = Object.freeze({});

export const ReviewExport: React.FC<ReviewExportProps> = ({ project, onUpdateProject, projectId, projectName, panels, state, onReturnToPreview, onUpdatePanel }) => {
  const [selectedPanel, setSelectedPanel] = useState<ComicPanel | null>(panels[0] || null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showRegenModal, setShowRegenModal] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [historyUrls, setHistoryUrls] = useState<string[]>([]);
  const [costReport, setCostReport] = useState<ProjectReport | null>(null);
  const [costUpdatedAt, setCostUpdatedAt] = useState<number | null>(null);
  const [isCostLoading, setIsCostLoading] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditSummary, setAuditSummary] = useState<string>('');
  const [auditScoresByPanel, setAuditScoresByPanel] = useState<Record<string, { driftScore: number; issues: string[]; suggestedFix?: string }>>({});
  const [regenError, setRegenError] = useState<string | null>(null);
  // The PDF tools load on first use (services/legacyPdfLoader.ts); a load that fails says so calmly here.
  const [isBuildingPdf, setIsBuildingPdf] = useState(false);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);
  const [limitDetails, setLimitDetails] = useState<Record<string, unknown> | null>(null);
  const [comicCost, setComicCost] = useState<ComicCostResponse | null>(null);
  // Governed users never see dollars (P1-LIMITS): the usage status decides how spend reads.
  // Read on mount / focus and once after the comic's recorded spend changes — never polled.
  const spendKey = comicCost ? (isGovernedComicCost(comicCost) ? comicCost.usagePct : comicCost.totalProviderCostUsd) : null;
  const allowance = useUsageAllowance({ refreshKey: spendKey });
  const costCtx = useMemo(() => costContextFromAllowance(allowance), [allowance]);
  const costView = useMemo(
    () => (comicCost ? comicCostView(comicCost, costCtx, { digits: 4, lineDigits: 4 }) : null),
    [comicCost, costCtx]
  );
  const costLabel = costView ? costView.total : costReport ? localCostLabel(costReport, costCtx, 4) : 'n/a';
  const [showBubbleEditor, setShowBubbleEditor] = useState(false);
  const autoPrepareKeyRef = useRef('');

  const textLayout = state.textLayout || 'caption';
  const gridTemplate = getGridTemplate(state.gridTemplateId);
  const activeModel = getImageModelById(getModelForTask('panel'));
  const agentSettings = useMemo(() => normalizeComicAgentSettings(state.agentSettings), [state.agentSettings]);
  const wantsComic = agentSettings.outputTargets.includes('comic');
  const wantsBook = agentSettings.outputTargets.includes('book');
  const wantsHtml = agentSettings.outputTargets.includes('html');
  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const versions = state.versions || [];
  const exportedOutputs = state.exportedOutputs || EMPTY_EXPORTED_OUTPUTS;
  const deliveredOutputCount = agentSettings.outputTargets.filter((target) => exportedOutputs[target]).length;
  const requestedOutputCount = Math.max(agentSettings.outputTargets.length, 1);
  const exportProgress = Math.round((deliveredOutputCount / requestedOutputCount) * 100);
  const renderedPanels = panels.filter((panel) => panel.imageUrl).length;
  const failedPanels = panels.filter((panel) => panel.failureReason && !panel.imageUrl).length;
  const recentAgentEvents = [...(state.agentRun?.events || [])].slice(-6).reverse();

  const outputDelivered = (target: AgentOutputTarget) => Boolean(exportedOutputs[target]);

  const recordExportEvent = useCallback((
    message: string,
    summary = message,
    eventStatus: 'info' | 'blocked' | 'failed' = 'info'
  ) => {
    onUpdateProject((prev) => {
      const prevState = prev.state;
      const prevSettings = normalizeComicAgentSettings(prevState.agentSettings);
      const prevDeliveredCount = prevSettings.outputTargets.filter((target) => prevState.exportedOutputs?.[target]).length;
      const prevRequestedCount = Math.max(prevSettings.outputTargets.length, 1);
      return {
        state: {
          ...prevState,
          agentRun: transitionAgentRun(
            prevState,
            [
              {
                kind: 'export',
                status: eventStatus === 'failed' ? 'failed' : 'active',
                summary,
                progress: Math.round((prevDeliveredCount / prevRequestedCount) * 100)
              }
            ],
            {
              kind: 'export',
              status: eventStatus,
              message
            }
          )
        }
      };
    });
  }, [onUpdateProject]);

  const markOutputDelivered = useCallback((target: ComicExportTarget, message: string) => {
    onUpdateProject((prev) => {
      const prevState = prev.state;
      const prevSettings = normalizeComicAgentSettings(prevState.agentSettings);
      const prevRequestedCount = Math.max(prevSettings.outputTargets.length, 1);
      const nextExportedOutputs = {
        ...(prevState.exportedOutputs || {}),
        [target]: Date.now()
      };
      const nextDeliveredCount = prevSettings.outputTargets.filter((outputTarget) => nextExportedOutputs[outputTarget]).length;
      const nextProgress = Math.round((nextDeliveredCount / prevRequestedCount) * 100);
      const allRequestedDelivered = nextDeliveredCount >= prevRequestedCount;
      const nextState: ComicState = {
        ...prevState,
        exportedOutputs: nextExportedOutputs
      };

      return {
        state: {
          ...nextState,
          agentRun: transitionAgentRun(
            nextState,
            [
              {
                kind: 'export',
                status: allRequestedDelivered ? 'done' : 'active',
                summary: allRequestedDelivered
                  ? 'Requested outputs prepared.'
                  : `${nextDeliveredCount} of ${prevRequestedCount} requested outputs prepared.`,
                progress: nextProgress
              }
            ],
            {
              kind: 'export',
              status: 'info',
              message
            }
          )
        }
      };
    });
  }, [onUpdateProject]);

  useEffect(() => {
    let isActive = true;
    const computeCost = async () => {
      setIsCostLoading(true);
      try {
        const artifacts = await loadArtifactsForProject(projectId);
        const report = await buildProjectReport(
          {
            id: projectId,
            name: projectName,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            state
          },
          artifacts,
          {},
          state.pricingConfig
        );
        if (isActive) {
          setCostReport(report);
          setCostUpdatedAt(Date.now());
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (isActive) setIsCostLoading(false);
      }
    };
    computeCost();
    return () => {
      isActive = false;
    };
  }, [projectId, projectName, panels, state, state.pricingConfig]);

  useEffect(() => {
    let active = true;
    const loadComicCost = async () => {
      try {
        const cost = (await getComicCost(projectId)) as ComicCostResponse;
        if (!active) return;
        setComicCost(cost);
      } catch {
        if (active) setComicCost(null);
      }
    };
    void loadComicCost();
    return () => {
      active = false;
    };
  }, [projectId, panels.length, costUpdatedAt]);

  useEffect(() => {
    const loadHistory = async () => {
      if (!selectedPanel) return;
      if (selectedPanel.imageUrlHistory?.length) {
        setHistoryUrls(selectedPanel.imageUrlHistory);
        return;
      }
      if (selectedPanel.imageIdHistory?.length) {
        const urls = await Promise.all(selectedPanel.imageIdHistory.map((id) => getImageUrl(id)));
        setHistoryUrls(urls.filter((url): url is string => !!url));
      } else {
        setHistoryUrls([]);
      }
    };
    loadHistory();
  }, [selectedPanel]);

  useEffect(() => {
    if (!selectedPanel && panels.length > 0) {
      setSelectedPanel(panels[0]);
    }
    if (selectedPanel && !panels.find((p) => p.id === selectedPanel.id) && panels.length > 0) {
      setSelectedPanel(panels[0]);
    }
  }, [panels, selectedPanel]);


  const handleRegenerate = async (instructions: string, panelOverride?: ComicPanel) => {
    const targetPanel = panelOverride || selectedPanel;
    if (!targetPanel) return;

    // We don't necessarily block on continuity for single panel regen if instructions are explicit,
    // but it's safer to warn. However, users might use regen to FIX continuity.
    // So let's allow it but maybe log a warning?
    // For now, let's keep the user unblocked.
    setRegenError(null);
    setIsRegenerating(true);
    setShowRegenModal(false);

    try {
      // Wrapper to handle state updates from generationManager
      const handleProjectUpdate = (pid: string, updateOrFn: Partial<Project> | ((prev: Project) => Partial<Project>)) => {
        // Since we are inside the component, 'project' prop is the current state.
        if (typeof updateOrFn === 'function') {
          const updates = updateOrFn(project);
          onUpdateProject(updates);
        } else {
          onUpdateProject(updateOrFn);
        }
      };

      await regenerateSinglePanel(
        project,
        targetPanel.id,
        instructions,
        handleProjectUpdate
      );

      // No need to manually update selectedPanel/panels here because onUpdateProject will trigger
      // a prop update from parent.

    } catch (e: any) {
      console.error("Regeneration failed", e);
      if (e.message && (e.message.includes("Token limit") || e.message.includes("Billing"))) {
        // Show limit modal if we have details? 
        // generationManager handles logging but re-throws.
        setRegenError(e.message);
      } else {
        setRegenError(e.message || "Failed to regenerate panel");
      }
    } finally {
      setIsRegenerating(false);
    }
  };


  const extractLimitDetails = (error: unknown): Record<string, unknown> | null => {
    if (!(error instanceof ApiError)) return null;
    const details = error.details as Record<string, unknown> | undefined;
    if (!details) return null;
    if (typeof details.reason === 'string' && typeof details.requiredCt === 'number') return details;
    if (details.details && typeof details.details === 'object') return details.details as Record<string, unknown>;
    return null;
  };

  const handleRunContinuityAudit = async () => {
    if (panels.length === 0) return;
    setAuditLoading(true);
    setRegenError(null);
    recordExportEvent('Started continuity audit.', 'Checking finished panels for continuity drift.');
    try {
      const response = await runContinuityAudit({
        script: state.script,
        continuityBible: state.continuity?.bible,
        sceneBindings: state.continuity?.bible.sceneBindings,
        panels: panels.map((panel) => ({
          id: panel.id,
          sceneId: panel.sceneId,
          description: panel.description,
          dialogue: panel.dialogue,
          requiredEntityIds: panel.continuity?.requiredEntityIds,
          locationId: panel.continuity?.locationId
        }))
      }, projectId);
      const map: Record<string, { driftScore: number; issues: string[]; suggestedFix?: string }> = {};
      response.panelScores.forEach((score) => {
        if (!score.panelId) return;
        map[score.panelId] = {
          driftScore: score.driftScore,
          issues: score.issues || [],
          suggestedFix: score.suggestedFix
        };
      });
      setAuditSummary(response.summary || '');
      setAuditScoresByPanel(map);
      recordExportEvent('Continuity audit complete.', response.summary || 'Continuity audit complete.');
    } catch (error) {
      console.error(error);
      const message = (error as Error)?.message || 'Continuity audit failed.';
      setRegenError(message);
      recordExportEvent(`Continuity audit failed: ${message}`, 'Continuity audit needs attention.', 'failed');
    } finally {
      setAuditLoading(false);
    }
  };

  const handleFixFlaggedPanels = async () => {
    const flagged = panels.filter((panel) => (auditScoresByPanel[panel.id]?.driftScore || 0) > 0.35);
    if (flagged.length === 0) return;
    for (const panel of flagged) {
      const suggestion = auditScoresByPanel[panel.id]?.suggestedFix || 'Preserve strict continuity with previous panels.';
      await handleRegenerate(suggestion, panel);
    }
  };

  const handleDownloadPDF = async () => {
    const comicEl = document.getElementById('comic-render-area');
    if (!comicEl || isBuildingPdf) return;
    setPdfNotice(null);
    setIsBuildingPdf(true);
    try {
      const { jsPDF, html2canvas } = await loadLegacyPdf();
      const ratioValue = parseRatio(state.customAspectRatioEnabled && state.customAspectRatio ? state.customAspectRatio : state.styleAspectRatio) || 1;
      const pdf = new jsPDF(ratioValue < 1 ? 'p' : 'l', 'mm', 'a4');

      // Temporarily expand full height to capture everything
      const originalHeight = comicEl.style.height;
      const originalOverflow = comicEl.style.overflow;
      comicEl.style.height = 'auto';
      comicEl.style.overflow = 'visible';

      try {
        const canvas = await html2canvas(comicEl, { scale: 2, backgroundColor: '#FFFFFF' });
        const imgData = canvas.toDataURL('image/png');
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

        // Split into pages if too long
        if (pdfHeight > pdf.internal.pageSize.getHeight()) {
          let heightLeft = pdfHeight;
          let position = 0;
          const pageHeight = pdf.internal.pageSize.getHeight();

          pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, pdfHeight);
          heightLeft -= pageHeight;

          while (heightLeft >= 0) {
            position = heightLeft - pdfHeight;
            pdf.addPage();
            pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, pdfHeight);
            heightLeft -= pageHeight;
          }
        } else {
          pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        }

        const blob = pdf.output('blob');
        const safeName = projectName.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'dreamstream-comic';
        downloadBlob(blob, `${safeName}.pdf`);
        markOutputDelivered('book', 'Downloaded Book/PDF output.');
      } finally {
        comicEl.style.height = originalHeight;
        comicEl.style.overflow = originalOverflow;
      }
    } catch (error) {
      console.warn('PDF export did not finish.', error);
      setPdfNotice(legacyPdfErrorMessage(error));
    } finally {
      setIsBuildingPdf(false);
    }
  };

  const buildHtmlDeliverable = useCallback(async () => {
    const panelData = await Promise.all(panels.map(async (panel) => {
      const dataUrl = panel.imageId ? await getImageDataUrl(panel.imageId) : panel.imageUrl;
      return { ...panel, dataUrl };
    }));
    const coverDataUrl = state.coverImageId ? await getImageDataUrl(state.coverImageId) : state.coverImageUrl;

    return buildComicHtmlDocument({
      projectName,
      panels: panelData,
      coverDataUrl,
      textLayout
    });
  }, [panels, projectName, state.coverImageId, state.coverImageUrl, textLayout]);

  const handleDownloadHTML = async () => {
    const htmlContent = await buildHtmlDeliverable();
    const blob = new Blob([htmlContent], { type: 'text/html' });
    downloadBlob(blob, 'comic.html');
    markOutputDelivered('html', 'Downloaded HTML output.');
  };

  const savePreparedOutputArtifact = useCallback(async (
    target: AgentOutputTarget,
    responseText: string,
    prompt: string
  ) => {
    await saveArtifact({
      id: `export-${target}-${projectId}-${Date.now()}`,
      projectId,
      timestamp: Date.now(),
      type: 'system',
      model: 'browser-export',
      prompt,
      responseText,
      stage: 'export',
      success: true,
      meta: {
        target,
        projectName,
        panelCount: panels.length,
        renderedPanels,
        preparedBy: 'comic-agent'
      }
    });
  }, [panels.length, projectId, projectName, renderedPanels]);

  const prepareRequestedOutput = useCallback(async (target: AgentOutputTarget) => {
    if (target === 'html') {
      const htmlContent = await buildHtmlDeliverable();
      await savePreparedOutputArtifact('html', htmlContent, 'Prepared offline HTML comic export.');
      markOutputDelivered('html', 'Prepared HTML output.');
      return;
    }

    if (target === 'book') {
      const htmlContent = await buildHtmlDeliverable();
      await savePreparedOutputArtifact('book', htmlContent, 'Prepared print/book HTML source for PDF export.');
      markOutputDelivered('book', 'Prepared Book/PDF output.');
      return;
    }

    const manifest = buildComicExportManifest({
      projectId,
      projectName,
      panels,
      coverImageId: state.coverImageId,
      coverImageUrl: state.coverImageUrl,
      outputTargets: agentSettings.outputTargets
    });
    await savePreparedOutputArtifact('comic', manifest, 'Prepared comic export manifest.');
    markOutputDelivered('comic', 'Prepared comic output.');
  }, [
    agentSettings.outputTargets,
    buildHtmlDeliverable,
    markOutputDelivered,
    panels,
    projectId,
    projectName,
    savePreparedOutputArtifact,
    state.coverImageId,
    state.coverImageUrl
  ]);

  const handleShare = () => {
    setShowShareModal(true);
    recordExportEvent('Opened share dialog.', 'Ready to share the finished comic.');
  };

  const getExtensionFromMime = (mime: string) => {
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    return 'png';
  };

  const parseDataUrl = (dataUrl: string) => {
    const [meta, base64] = dataUrl.split(',');
    const mimeMatch = meta.match(/data:(.*?);base64/);
    const mimeType = mimeMatch?.[1] || 'image/png';
    return { mimeType, base64 };
  };

  const handleDownloadProjectData = async () => {
    try {
      const exportData = await exportProject(projectId);
      if (!exportData.project) return;

      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const safeName = projectName.replace(/[^a-zA-Z0-9-_]+/g, '_');

      zip.file('project.json', JSON.stringify(projectForExport(exportData.project, costCtx), null, 2));

      const imagesFolder = zip.folder('images');
      const imageFileMap: Record<string, string> = {};
      if (imagesFolder) {
        Object.entries(exportData.images).forEach(([id, dataUrl]) => {
          const { mimeType, base64 } = parseDataUrl(dataUrl as string);
          const ext = getExtensionFromMime(mimeType);
          const filename = `${id}.${ext}`;
          imageFileMap[id] = filename;
          imagesFolder.file(filename, base64, { base64: true });
        });
      }

      const artifactsFolder = zip.folder('artifacts');
      if (artifactsFolder) {
        artifactsFolder.file('artifacts.json', JSON.stringify(artifactsForExport(exportData.artifacts, costCtx), null, 2));
      }

      const reportFolder = zip.folder('report');
      if (reportFolder && exportData.report) {
        reportFolder.file('ai_usage.json', JSON.stringify(aiUsageForExport(exportData.report.ai_usage, costCtx), null, 2));
        reportFolder.file('cost_summary.json', JSON.stringify(costSummaryForExport(exportData.report.cost_summary, costCtx), null, 2));
        reportFolder.file('storage.json', JSON.stringify(exportData.report.storage, null, 2));
      }

      const coverImageRef = state.coverImageId ? `images/${imageFileMap[state.coverImageId] || ''}` : '';

      const html = buildComicHtmlDocument({
        projectName,
        coverDataUrl: coverImageRef,
        panels: panels.map((panel) => ({
          ...panel,
          dataUrl: panel.imageId ? `images/${imageFileMap[panel.imageId] || ''}` : panel.imageUrl
        })),
        textLayout
      });

      zip.file('comic.html', html);

      zip.file(
        'readme.txt',
        `DreamStream Comic Studio Export\n\nProject: ${projectName}\n\nContents:\n- project.json (full project state, image IDs)\n- images/ (all generated and reference images)\n- artifacts/ (AI prompts, models, timestamps, outputs)\n- report/ (ai usage, cost, storage)\n- comic.html (offline comic viewer with zoom)\n`
      );

      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${safeName || 'comic'}_project.zip`);
      markOutputDelivered('comic', 'Downloaded project ZIP output.');
    } catch (e) {
      console.error("Export failed", e);
      recordExportEvent(`Project ZIP export failed: ${(e as Error)?.message || 'Unknown error'}`, 'Project ZIP export failed.', 'failed');
    }
  };

  useEffect(() => {
    const pendingTargets = agentSettings.outputTargets.filter((target) => !exportedOutputs[target]);
    if (pendingTargets.length === 0) return;
    if (panels.length === 0 || renderedPanels === 0) return;

    const prepareKey = [
      projectId,
      pendingTargets.join(','),
      state.coverImageId || state.coverImageUrl || 'no-cover',
      textLayout,
      panels.map((panel) => `${panel.id}:${panel.imageId || panel.imageUrl || 'missing'}`).join('|')
    ].join('::');
    if (autoPrepareKeyRef.current === prepareKey) return;
    autoPrepareKeyRef.current = prepareKey;

    let cancelled = false;
    void (async () => {
      recordExportEvent('Preparing requested comic outputs.', 'Preparing requested outputs.');
      for (const target of pendingTargets) {
        if (cancelled) break;
        try {
          await prepareRequestedOutput(target);
        } catch (error) {
          console.error(`Failed to prepare ${target} output`, error);
          recordExportEvent(
            `Failed to prepare ${outputTargetLabel(target)} output: ${(error as Error)?.message || 'Unknown error'}`,
            `${outputTargetLabel(target)} output needs attention.`,
            'failed'
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    agentSettings.outputTargets,
    exportedOutputs,
    panels,
    prepareRequestedOutput,
    projectId,
    recordExportEvent,
    renderedPanels,
    state.coverImageId,
    state.coverImageUrl,
    textLayout
  ]);

  const getLayoutClass = () => sharedGetLayoutClass(state.layoutType);
  const getPanelClass = (idx: number) => sharedGetPanelClass(state.layoutType, idx);

  // One panel card. `slotStyle` present = absolute slot placement (grid template);
  // absent = normal flow placement (CSS layout). Shared by the paginated + flow renderers.
  const renderPanelCard = (panel: ComicPanel, displayIdx: number, slotStyle?: React.CSSProperties) => (
    <div
      key={panel.id}
      className={`relative group border-4 ${panel.failureReason ? 'border-[var(--ds-danger-mark)]' : 'border-black'} rounded-lg overflow-hidden shadow-comic cursor-pointer ${slotStyle ? '' : getPanelClass(displayIdx)}`}
      style={slotStyle}
      onClick={() => setSelectedPanel(panel)}
    >
      {panel.imageUrl ? (
        <img src={panel.imageUrl} alt={`Panel ${displayIdx + 1}`} className="w-full h-full object-cover" />
      ) : (
        <div className="flex h-full min-h-[120px] w-full flex-col items-center justify-center bg-[var(--ds-well)] text-[var(--ds-muted)]">
          <RefreshCw size={24} className="mb-1" aria-hidden="true" />
          <span className={OVERLINE}>Failed</span>
        </div>
      )}
      <PanelDialogue panel={panel} layout={textLayout} />
      {panel.failureReason && (
        <div className={cn('absolute left-2 top-2 max-w-[80%] truncate', STATUS_CHIP, TONE_CHIP_ON_ART.danger)}>
          ⚠ {panel.failureReason}
        </div>
      )}
      {auditScoresByPanel[panel.id] && !panel.failureReason && (
        <div className={cn('absolute left-2 top-2 tabular-nums', STATUS_CHIP, auditScoresByPanel[panel.id].driftScore > 0.35 ? TONE_CHIP_ON_ART.danger : TONE_CHIP_ON_ART.success)}>
          Drift {Math.round(auditScoresByPanel[panel.id].driftScore * 100)}%
        </div>
      )}
      <div className={cn('absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none', SCRIM)}>
        <IconButton label="Regenerate panel" title={null} variant="outline" size="lg" onClick={(e) => { e.stopPropagation(); setSelectedPanel(panel); setShowRegenModal(true); }}><RefreshCw size={16} /></IconButton>
        <IconButton label="Edit bubbles" title={null} variant="outline" size="lg" onClick={(e) => { e.stopPropagation(); setSelectedPanel(panel); setShowBubbleEditor(true); }}><Edit2 size={16} /></IconButton>
      </div>
      {selectedPanel?.id === panel.id && <div className="pointer-events-none absolute inset-0 ring-4 ring-inset ring-[var(--ds-ink)]" />}
    </div>
  );

  // Paginate panels across template pages so panels beyond the slot count flow onto a new
  // page (was: everything piled into one height-less box → overlap = the "glitch").
  const renderTemplatePages = () => {
    if (!gridTemplate) return null;
    const slotCount = Math.max(1, gridTemplate.panelSlots.length);
    const pageHeight = gridTemplate.panelSlots.reduce((max, s) => Math.max(max, s.y + s.height), 0) || 100;
    const pages: ComicPanel[][] = [];
    for (let i = 0; i < panels.length; i += slotCount) pages.push(panels.slice(i, i + slotCount));
    return (
      <div className="space-y-6">
        {pages.map((pagePanels, pageIdx) => (
          <div key={pageIdx} className="relative w-full" style={{ paddingBottom: `${pageHeight}%` }}>
            {pagePanels.map((panel, localIdx) => {
              const slot = gridTemplate.panelSlots[localIdx];
              return renderPanelCard(panel, pageIdx * slotCount + localIdx, {
                position: 'absolute',
                left: `${slot.x}%`,
                top: `${slot.y}%`,
                width: `${slot.width}%`,
                height: `${slot.height}%`
              });
            })}
          </div>
        ))}
      </div>
    );
  };

  const sidebar = (
    <div className="space-y-5">
      <div className={cn('p-4', STAGE_CARD)}>
        <h3 className={STAGE_BOARD_TITLE}>Deliverables</h3>
        <div className="mt-3 space-y-2">
          {agentSettings.outputTargets.map((target) => (
            <div key={target} className={cn('flex items-center justify-between gap-3 px-3 py-2', STAGE_WELL)}>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--ds-ink)]">{outputTargetLabel(target)}</div>
                <div className="text-xs text-[var(--ds-muted)]">
                  {outputDelivered(target)
                    ? `Prepared ${new Date(exportedOutputs[target] || 0).toLocaleTimeString()}`
                    : 'Waiting'}
                </div>
              </div>
              <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center border', RADIUS_ROUND, outputDelivered(target) ? STATUS_CHIP_TONE.healthy : STATUS_CHIP_TONE.waiting)}>
                {outputDelivered(target) ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <span className={cn('h-1.5 w-1.5', RADIUS_ROUND, STATUS_DOT.waiting)} />}
              </span>
            </div>
          ))}
        </div>
        <div className={cn('mt-4 h-2 overflow-hidden bg-[var(--ds-well-strong)]', RADIUS_ROUND)} aria-hidden="true">
          <div className={cn('h-full bg-[var(--ds-ink)] transition-[width] duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] motion-reduce:transition-none', RADIUS_ROUND)} style={{ width: `${exportProgress}%` }} />
        </div>
        <div className="mt-2 text-xs tabular-nums text-[var(--ds-muted)]">{deliveredOutputCount} of {requestedOutputCount} requested outputs prepared</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className={cn('min-w-0 p-3', STAGE_CARD)}>
          <div className={OVERLINE}>Panels</div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-[var(--ds-ink)]">{renderedPanels} / {panels.length}</div>
        </div>
        <div className={cn('min-w-0 p-3', STAGE_CARD)}>
          <div className={OVERLINE}>Retries</div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-[var(--ds-ink)]">{failedPanels}</div>
        </div>
        <div className={cn('min-w-0 p-3', STAGE_CARD)}>
          <div className={OVERLINE}>{costCtx.governed ? 'Usage' : 'Cost'}</div>
          <div className={cn('mt-1 text-sm font-semibold tabular-nums text-[var(--ds-ink)]', WRAP_TEXT)}>{costLabel}</div>
        </div>
        <div className={cn('min-w-0 p-3', STAGE_CARD)}>
          <div className={OVERLINE}>Model</div>
          <div className="mt-1 truncate text-sm font-semibold text-[var(--ds-ink)]">{activeModel?.label || 'Default'}</div>
        </div>
      </div>

      <div className={STAGE_CARD}>
        <h3 className={cn('flex items-center gap-2 border-b border-[var(--ds-hairline)] px-3 py-2', STAGE_BOARD_TITLE)}>
          <Terminal className="h-4 w-4" aria-hidden="true" /> Agent stream
        </h3>
        <div className="max-h-52 overflow-y-auto px-3 py-2 font-mono text-xs custom-scrollbar">
          {recentAgentEvents.length === 0 ? (
            <div className="py-2 text-[var(--ds-muted)]">No export events yet.</div>
          ) : recentAgentEvents.map((event) => (
            <div key={event.id} className={cn('border-b border-[var(--ds-hairline-soft)] py-2 text-[var(--ds-ink)] last:border-0', WRAP_TEXT)}>
              <span className="mr-2 text-[var(--ds-muted)]">{new Date(event.timestamp).toLocaleTimeString()}</span>
              {event.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={handleShare}>
        <Share2 className="h-4 w-4" /> Share
      </Button>
      <Button onClick={handleDownloadProjectData}>
        <Download className="h-4 w-4" /> ZIP
      </Button>
    </div>
  );

  return (
    <>
      <AgentStageShell
        eyebrow="Export agent"
        title="Review and deliver"
        description="Finished panels are ready for fixes, continuity checks, and requested outputs."
        icon={<Activity className="h-5 w-5" />}
        actions={actions}
        sidebar={sidebar}
        minHeightClassName="min-h-[760px]"
      >
        <div className="space-y-5 p-5">
          <div className={cn('max-h-[65vh] overflow-y-auto bg-[var(--ds-well-strong)] p-3 custom-scrollbar sm:p-5', RADIUS_PANEL, HAIRLINE)}>
            {/* The page itself is comic paper (white, captured into the PDF); only its frame is chrome. */}
            <div id="comic-render-area" className={cn('mx-auto max-w-5xl bg-white p-4 sm:p-6', RADIUS_PANEL, SHADOW_SOFT)}>
              {state.coverImageUrl && (
                <div className="mb-6 overflow-hidden rounded-lg border-4 border-black">
                  <img src={state.coverImageUrl} alt={`${projectName} cover`} className="h-auto w-full object-cover" />
                </div>
              )}
              {gridTemplate ? renderTemplatePages() : (
                <div className={getLayoutClass()}>
                  {panels.map((panel, idx) => renderPanelCard(panel, idx))}
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
            <div className={cn('min-w-0 p-4', STAGE_CARD)}>
              <h3 className={STAGE_BOARD_TITLE}>{costCtx.governed ? 'Usage so far' : 'Cost summary'}</h3>
              <div className={cn('mt-1 font-semibold tabular-nums text-[var(--ds-ink)]', TEXT_XL, WRAP_TEXT)}>
                {isCostLoading ? "Updating..." : costLabel}
              </div>
              {costView?.ownKeyNote && <div className={cn('mt-1 text-xs text-[var(--ds-muted)]', WRAP_TEXT)}>{costView.ownKeyNote}</div>}
              <div className="mt-1 font-mono text-xs text-[var(--ds-muted)]">
                {costUpdatedAt ? `Updated ${new Date(costUpdatedAt).toLocaleTimeString()}` : "Waiting for data..."}
              </div>
              <div className={cn('mt-2 select-all font-mono text-xs text-[var(--ds-muted)]', WRAP_TEXT)} title="Reference these when reporting an issue">
                Project {projectId} · Session {state.sessionId || "-"}
              </div>
              {regenError && (
                <div className={cn('mt-2 border px-3 py-2 text-xs font-medium', RADIUS_CONTROL, STATUS_SURFACE.error, STATUS_INK.error, WRAP_TEXT)}>{regenError}</div>
              )}
            </div>

            <div className={cn('min-w-0 p-4', STAGE_CARD)}>
              <h3 className={STAGE_BOARD_TITLE}>Continuity</h3>
              {auditSummary ? (
                <div className={cn('mt-2 text-sm leading-6 text-[var(--ds-ink)]', WRAP_TEXT)}>{auditSummary}</div>
              ) : (
                <div className={cn('mt-2', STAGE_BODY)}>No review audit has run for this build yet.</div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={handleRunContinuityAudit} loading={auditLoading} disabled={auditLoading}>
                  Audit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFixFlaggedPanels}
                  disabled={!Object.values(auditScoresByPanel).some((score) => score.driftScore > 0.35)}
                >
                  Fix Flagged
                </Button>
              </div>
            </div>
          </div>

          {costView && (costView.byStage.length > 0 || costView.byModel.length > 0) && (
            <div className={cn('p-4', STAGE_CARD)}>
              <h3 className={STAGE_BOARD_TITLE}>{costView.governed ? 'Usage breakdown' : 'Cost breakdown'}</h3>
              <div className="mt-3 grid gap-4 text-xs sm:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-1 font-semibold text-[var(--ds-ink)]">By stage</div>
                  {costView.byStage.slice(0, 6).map((line) => (
                    <div key={line.key} className="flex justify-between gap-2 py-0.5"><span className="min-w-0 truncate text-[var(--ds-muted)]">{line.key}</span><span className="shrink-0 font-mono tabular-nums text-[var(--ds-ink)]">{line.value}</span></div>
                  ))}
                </div>
                <div className="min-w-0">
                  <div className="mb-1 font-semibold text-[var(--ds-ink)]">By model</div>
                  {costView.byModel.slice(0, 6).map((line) => (
                    <div key={line.key} className="flex justify-between gap-2 py-0.5"><span className="min-w-0 truncate text-[var(--ds-muted)]">{line.key}</span><span className="shrink-0 font-mono tabular-nums text-[var(--ds-ink)]">{line.value}</span></div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className={cn('px-4 py-3', STAGE_CARD)}>
            <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-[var(--ds-ink)]', WRAP_TEXT)}>
              <div><span className="text-[var(--ds-muted)]">Model:</span> {activeModel?.label || 'Default'}</div>
              <div><span className="text-[var(--ds-muted)]">Layout:</span> {gridTemplate?.title || state.layoutType}</div>
              <div><span className="text-[var(--ds-muted)]">Panels:</span> {panels.length}</div>
              <div><span className="text-[var(--ds-muted)]">Requested:</span> {agentSettings.outputTargets.map(outputTargetLabel).join(', ')}</div>
              {costReport && <div><span className="text-[var(--ds-muted)]">Artifacts:</span> {costReport.ai_usage.totalArtifacts}</div>}
            </div>
          </div>

          <div className={cn('p-4', STAGE_CARD)}>
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setShowRegenModal(true)} disabled={!selectedPanel || isRegenerating} loading={isRegenerating}>{isRegenerating ? null : <RefreshCw className="h-4 w-4" />}Edit Panel</Button>
                <Button variant="outline" onClick={() => setShowHistoryModal(true)} disabled={!selectedPanel || (selectedPanel.imageIdHistory?.length || 0) <= 1}><History className="h-4 w-4" />History</Button>
                <Button variant="outline" onClick={onReturnToPreview}><ArrowLeftRight className="h-4 w-4" />Layout</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {versions.length > 0 && (
                  <div className="relative">
                    <Button variant="outline" aria-expanded={showVersionPicker} onClick={() => setShowVersionPicker(!showVersionPicker)}>
                      Versions ({versions.length})
                    </Button>
                    {showVersionPicker && (
                      <div className={cn('absolute bottom-full right-0 mb-2 max-h-56 w-72 max-w-[calc(100vw-4rem)] overflow-y-auto p-2', Z.popover, OVERLAY)}>
                        <div className={cn('mb-2 px-2', OVERLINE)}>Version History</div>
                        {versions.map(v => (
                          <button
                            key={v.id}
                            onClick={() => {
                              onUpdateProject({ state: v.state });
                              setShowVersionPicker(false);
                            }}
                            type="button"
                            className={cn('w-full p-2 text-left text-xs text-[var(--ds-muted)] hover:bg-[var(--ds-overlay-hover)]', RADIUS_CONTROL, DENSITY.coarse, TRANSITION, FOCUS_ITEM)}
                          >
                            <div className="truncate font-semibold text-[var(--ds-ink)]">{v.name}</div>
                            <div>{new Date(v.createdAt).toLocaleString()}</div>
                            {v.reason && <div className={cn('italic', WRAP_TEXT)}>{v.reason}</div>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* A requested output reads as the filled secondary step, the rest as outlines; the one ink
                    primary on this screen is the header's ZIP. */}
                <Button onClick={handleDownloadProjectData} variant={wantsComic ? 'secondary' : 'outline'}>Project ZIP</Button>
                <Button onClick={handleDownloadHTML} variant={wantsHtml ? 'secondary' : 'outline'}><FileCode className="h-4 w-4" />HTML</Button>
                <Button onClick={handleDownloadPDF} loading={isBuildingPdf} disabled={isBuildingPdf} variant={wantsBook ? 'secondary' : 'outline'}>
                  {isBuildingPdf ? null : <Download className="h-4 w-4" />}
                  {wantsBook ? 'Book/PDF' : 'PDF'}
                </Button>
              </div>
            </div>
            {pdfNotice && (
              <p role="status" className={`mt-3 rounded-[var(--ds-radius-control)] border px-3 py-2 text-xs leading-5 ${STATUS_SURFACE.attention} ${STATUS_INK.attention}`}>
                {pdfNotice}
              </p>
            )}
          </div>
        </div>
      </AgentStageShell>

      {/* Modals */}
      {showHistoryModal && selectedPanel && (
        <React.Suspense fallback={null}>
          <HistoryModal
            onClose={() => setShowHistoryModal(false)}
            selectedPanel={selectedPanel}
            historyUrls={historyUrls}
            onUpdatePanel={onUpdatePanel}
          />
        </React.Suspense>
      )}

      {showBubbleEditor && selectedPanel && (
        <React.Suspense fallback={null}>
          <BubbleEditorModal
            isOpen={showBubbleEditor}
            onClose={() => setShowBubbleEditor(false)}
            panel={selectedPanel}
            layout={textLayout}
            onUpdatePanel={(updatedPanel) => {
              const newPanels = panels.map(p => p.id === updatedPanel.id ? updatedPanel : p);
              onUpdateProject({
                state: {
                  ...state,
                  panels: newPanels
                }
              });
              setSelectedPanel(updatedPanel);
            }}
          />
        </React.Suspense>
      )}

      {showRegenModal && selectedPanel && selectedPanel.imageUrl && (
        <React.Suspense fallback={null}>
          <RegenerateModal
            currentImageUrl={selectedPanel.imageUrl}
            isLoading={isRegenerating}
            onConfirm={handleRegenerate}
            onClose={() => setShowRegenModal(false)}
          />
        </React.Suspense>
      )}

      {previewImage && (
        <React.Suspense fallback={null}>
          <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />
        </React.Suspense>
      )}

      {limitDetails && (
        <LimitExceededModal
          details={limitDetails}
          onClose={() => setLimitDetails(null)}
          onUpgrade={() => {
            setLimitDetails(null);
            window.alert('Open Account Settings > Billing to upgrade your plan.');
          }}
          onAddCredits={() => {
            setLimitDetails(null);
            window.alert('Open Account Settings > Billing to add credits.');
          }}
          onWait={() => setLimitDetails(null)}
        />
      )}

      {showShareModal && (
        <React.Suspense fallback={null}>
          <ShareModal projectId={projectId} onClose={() => setShowShareModal(false)} />
        </React.Suspense>
      )}
    </>
  );
};
