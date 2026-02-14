import React, { useState, useEffect } from 'react';
import { Download, Edit2, RefreshCw, X, History, Share2, FileCode, Loader2, ArrowLeftRight } from 'lucide-react';
import { ComicPanel, ComicState, DialogueBlock, TextLayout, ProjectReport, Project } from '../../types';
import { PanelDialogue } from '../PanelDialogue';
import { generateImage } from '../../services/imageService';
import { regenerateSinglePanel } from '../../services/generationManager';
import { runContinuityAudit } from '../../services/geminiService';
import { Button } from '../Button';
// Lazy loaded components
const ImagePreviewModal = React.lazy(() => import('../modals/ImagePreviewModal').then(module => ({ default: module.ImagePreviewModal })));
const RegenerateModal = React.lazy(() => import('../modals/RegenerateModal').then(module => ({ default: module.RegenerateModal })));
const HistoryModal = React.lazy(() => import('../modals/HistoryModal').then(module => ({ default: module.HistoryModal })));
const BubbleEditorModal = React.lazy(() => import('../modals/BubbleEditorModal').then(module => ({ default: module.BubbleEditorModal })));

import { exportProject, getImageUrl, getImageDataUrl } from '../../services/db';
import { ensureDialogueBlocks } from '../../services/dialogueUtils';
import { getLayoutClass as sharedGetLayoutClass, getPanelClass as sharedGetPanelClass, getGridTemplate, EXPORT_DIALOGUE_CSS, buildPanelDialogueHtml } from '../../services/panelLayout';
import { getModelForTask } from '../../services/appSettings';
import { getImageModelById } from '../../services/imageModels';
import { buildImagePrompt } from '../../services/imagePrompt';
import { parseRatio, resolveAspectRatio } from '../../services/imageUtils';
import { buildProjectReport } from '../../services/reporting';
import { loadArtifactsForProject } from '../../services/db';
import { downloadBlob } from '../../services/download';
import { collectPanelReferenceImageIds, resolvePanelContinuity, validateContinuityState } from '../../services/continuity';
import { appendCappedHistory } from '../../services/projectStorage';
import { ApiError } from '../../services/apiClient';
import { LimitExceededModal } from '../modals/LimitExceededModal';
import { getComicCost } from '../../services/billing';

declare const jspdf: any;
declare const html2canvas: any;

interface ReviewExportProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => void;
  projectId: string;
  projectName: string;
  panels: ComicPanel[];
  state: ComicState;
  onReturnToPreview: () => void;
  onUpdatePanel: (panelId: string, imageId: string, imageUrl: string) => void;
}

// renderPanelText removed — use <PanelDialogue /> component instead

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getDialogueBlocks = (panel: ComicPanel) =>
  ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);

export const ReviewExport: React.FC<ReviewExportProps> = ({ project, onUpdateProject, projectId, projectName, panels, state, onReturnToPreview, onUpdatePanel }) => {
  const [selectedPanel, setSelectedPanel] = useState<ComicPanel | null>(panels[0] || null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showRegenModal, setShowRegenModal] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [historyUrls, setHistoryUrls] = useState<string[]>([]);
  const [costReport, setCostReport] = useState<ProjectReport | null>(null);
  const [costUpdatedAt, setCostUpdatedAt] = useState<number | null>(null);
  const [isCostLoading, setIsCostLoading] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditSummary, setAuditSummary] = useState<string>('');
  const [auditScoresByPanel, setAuditScoresByPanel] = useState<Record<string, { driftScore: number; issues: string[]; suggestedFix?: string }>>({});
  const [regenError, setRegenError] = useState<string | null>(null);
  const [limitDetails, setLimitDetails] = useState<Record<string, unknown> | null>(null);
  const estimatedCt = costReport ? Math.ceil(costReport.cost_summary.totalCost / 0.0001) : null;
  const [comicCost, setComicCost] = useState<{ totalActualCt: number; totalBillableUsd: number } | null>(null);
  const [showBubbleEditor, setShowBubbleEditor] = useState(false);

  const textLayout = state.textLayout || 'caption';
  const gridTemplate = getGridTemplate(state.gridTemplateId);
  const activeModel = getImageModelById(getModelForTask('panel'));
  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const versions = state.versions || [];

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
        const cost = await getComicCost(projectId);
        if (!active) return;
        setComicCost({
          totalActualCt: cost.totalActualCt,
          totalBillableUsd: cost.totalBillableUsd
        });
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
    } catch (error) {
      console.error(error);
      setRegenError((error as Error)?.message || 'Continuity audit failed.');
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
    if (!comicEl) return;

    const { jsPDF } = jspdf;
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
    } finally {
      comicEl.style.height = originalHeight;
      comicEl.style.overflow = originalOverflow;
    }
  };

  const handleDownloadHTML = async () => {
    const panelData = await Promise.all(panels.map(async (panel) => {
      const dataUrl = panel.imageId ? await getImageDataUrl(panel.imageId) : panel.imageUrl;
      return { ...panel, dataUrl };
    }));
    const coverDataUrl = state.coverImageId ? await getImageDataUrl(state.coverImageId) : state.coverImageUrl;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${escapeHtml(projectName)}</title>
        <style>
          body{margin:0;padding:20px;background:#eee;font-family:Arial,sans-serif;}
          .toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;}
          .comic-container{max-width:900px;margin:0 auto;background:white;padding:20px;box-shadow:0 4px 6px rgba(0,0,0,0.1);}
          .cover{margin-bottom:24px;border:4px solid #000;overflow:hidden;}
          .cover img{width:100%;display:block;}
          .panel{margin-bottom:20px;border:2px solid black;position:relative;overflow:hidden;}
          .panel img{width:100%;display:block;}
          .zoom-wrapper{transform-origin:top center;}
          ${EXPORT_DIALOGUE_CSS}
        </style>
      </head>
      <body>
        <div class="toolbar">
          <label>Zoom</label>
          <input id="zoom" type="range" min="0.5" max="2" value="1" step="0.1" />
          <button onclick="adjustZoom(-0.1)">-</button>
          <button onclick="adjustZoom(0.1)">+</button>
        </div>
        <div class="comic-container zoom-wrapper" id="zoomTarget">
          ${coverDataUrl ? `<div class="cover"><img src="${coverDataUrl}" /></div>` : ''}
          ${panelData.map(p => {
      return `<div class="panel">
              <img src="${p.dataUrl || ''}" />
              ${buildPanelDialogueHtml(p, textLayout)}
            </div>`;
    }).join('')}
        </div>
        <script>
          const zoom = document.getElementById('zoom');
          const target = document.getElementById('zoomTarget');
          const applyZoom = () => { target.style.transform = 'scale(' + zoom.value + ')'; };
          zoom.addEventListener('input', applyZoom);
          const adjustZoom = (delta) => { zoom.value = Math.min(2, Math.max(0.5, Number(zoom.value) + delta)); applyZoom(); };
          applyZoom();
        </script>
      </body>
      </html>
    `;
    const blob = new Blob([htmlContent], { type: 'text/html' });
    downloadBlob(blob, 'comic.html');
  };

  const handleShare = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'read');
    url.searchParams.set('id', projectId);
    const shareUrl = url.toString();
    setShareLink(shareUrl);
    navigator.clipboard.writeText(shareUrl);
    setTimeout(() => setShareLink(null), 3000);
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

      zip.file('project.json', JSON.stringify(exportData.project, null, 2));

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
        artifactsFolder.file('artifacts.json', JSON.stringify(exportData.artifacts, null, 2));
      }

      const reportFolder = zip.folder('report');
      if (reportFolder && exportData.report) {
        reportFolder.file('ai_usage.json', JSON.stringify(exportData.report.ai_usage, null, 2));
        reportFolder.file('cost_summary.json', JSON.stringify(exportData.report.cost_summary, null, 2));
        reportFolder.file('storage.json', JSON.stringify(exportData.report.storage, null, 2));
      }

      const coverImageRef = state.coverImageId ? `images/${imageFileMap[state.coverImageId] || ''}` : '';

      const html = `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(projectName)}</title>
  <style>
    body{margin:0;padding:20px;background:#eee;font-family:Arial,sans-serif;}
    .toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;}
    .comic-container{max-width:900px;margin:0 auto;background:white;padding:20px;box-shadow:0 4px 6px rgba(0,0,0,0.1);}
    .cover{margin-bottom:24px;border:4px solid #000;overflow:hidden;}
    .cover img{width:100%;display:block;}
    .panel{margin-bottom:20px;border:2px solid black;position:relative;overflow:hidden;}
    .panel img{width:100%;display:block;}
    .zoom-wrapper{transform-origin:top center;}
    ${EXPORT_DIALOGUE_CSS}
  </style>
</head>
<body>
  <div class="toolbar">
    <label>Zoom</label>
    <input id="zoom" type="range" min="0.5" max="2" value="1" step="0.1" />
    <button onclick="adjustZoom(-0.1)">-</button>
    <button onclick="adjustZoom(0.1)">+</button>
  </div>
  <div class="comic-container zoom-wrapper" id="zoomTarget">
    ${coverImageRef ? `<div class="cover"><img src="${coverImageRef}" /></div>` : ''}
    ${panels.map(p => {
        const imgRef = p.imageId ? `images/${imageFileMap[p.imageId] || ''}` : '';
        return `<div class="panel">
        <img src="${imgRef}" />
        ${buildPanelDialogueHtml(p, textLayout)}
      </div>`;
      }).join('')}
  </div>
  <script>
    const zoom = document.getElementById('zoom');
    const target = document.getElementById('zoomTarget');
    const applyZoom = () => { target.style.transform = 'scale(' + zoom.value + ')'; };
    zoom.addEventListener('input', applyZoom);
    const adjustZoom = (delta) => { zoom.value = Math.min(2, Math.max(0.5, Number(zoom.value) + delta)); applyZoom(); };
    applyZoom();
  </script>
</body>
</html>`;

      zip.file('comic.html', html);

      zip.file(
        'readme.txt',
        `DreamStream Comic Studio Export\n\nProject: ${projectName}\n\nContents:\n- project.json (full project state, image IDs)\n- images/ (all generated and reference images)\n- artifacts/ (AI prompts, models, timestamps, outputs)\n- report/ (ai usage, cost, storage)\n- comic.html (offline comic viewer with zoom)\n`
      );

      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${safeName || 'comic'}_project.zip`);
    } catch (e) {
      console.error("Export failed", e);
    }
  };

  const getLayoutClass = () => sharedGetLayoutClass(state.layoutType);
  const getPanelClass = (idx: number) => sharedGetPanelClass(state.layoutType, idx);

  return (
    <div className="h-[calc(100vh-180px)] flex flex-col md:flex-row gap-6 animate-fade-in">
      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col gap-6">
        <div id="comic-render-area" className="flex-1 bg-white rounded-xl border-4 border-black shadow-comic p-8 overflow-y-auto custom-scrollbar">
          {state.coverImageUrl && (
            <div className="mb-6 border-4 border-black rounded-lg overflow-hidden shadow-comic">
              <img src={state.coverImageUrl} alt={`${projectName} cover`} className="w-full h-auto object-cover" />
            </div>
          )}
          <div className={gridTemplate ? 'relative w-full' : getLayoutClass()}
            style={gridTemplate ? { paddingBottom: `${gridTemplate.panelSlots.reduce((max, s) => Math.max(max, s.y + s.height), 0)}%` } : undefined}>
            {panels.map((panel, idx) => {
              const slot = gridTemplate?.panelSlots[idx];
              return (
                <div
                  key={panel.id}
                  className={`relative group border-4 ${panel.failureReason ? 'border-red-400' : 'border-black'} rounded-lg overflow-hidden shadow-comic cursor-pointer ${gridTemplate ? '' : getPanelClass(idx)}`}
                  style={slot ? {
                    position: 'absolute',
                    left: `${slot.x}%`,
                    top: `${slot.y}%`,
                    width: `${slot.width}%`,
                    height: `${slot.height}%`,
                  } : undefined}
                  onClick={() => setSelectedPanel(panel)}
                >
                  {panel.imageUrl ? (
                    <img src={panel.imageUrl} alt={`Panel ${idx + 1}`} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full min-h-[120px] flex flex-col items-center justify-center bg-slate-100 text-slate-400">
                      <RefreshCw size={24} className="mb-1" />
                      <span className="text-[10px] font-bold uppercase">Failed</span>
                    </div>
                  )}
                  <PanelDialogue panel={panel} layout={textLayout} />
                  {panel.failureReason && (
                    <div className="absolute left-2 top-2 px-2 py-1 text-[10px] font-bold rounded border bg-red-100 text-red-700 border-red-300 max-w-[80%] truncate">
                      ⚠ {panel.failureReason}
                    </div>
                  )}
                  {auditScoresByPanel[panel.id] && !panel.failureReason && (
                    <div className={`absolute left-2 top-2 px-2 py-1 text-[10px] font-bold rounded border ${auditScoresByPanel[panel.id].driftScore > 0.35
                      ? 'bg-red-100 text-red-700 border-red-300'
                      : 'bg-green-100 text-green-700 border-green-300'
                      }`}>
                      Drift {Math.round(auditScoresByPanel[panel.id].driftScore * 100)}%
                    </div>
                  )}

                  {/* Hover Overlay */}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                    <button className="bg-white p-2 rounded-full hover:bg-brand-yellow border-2 border-black" onClick={(e) => { e.stopPropagation(); setSelectedPanel(panel); setShowRegenModal(true); }} aria-label="Regenerate panel"><RefreshCw size={16} /></button>
                    <button className="bg-white p-2 rounded-full hover:bg-brand-yellow border-2 border-black" onClick={(e) => { e.stopPropagation(); setSelectedPanel(panel); setShowBubbleEditor(true); }} aria-label="Edit bubbles"><Edit2 size={16} /></button>
                  </div>

                  {selectedPanel?.id === panel.id && <div className="absolute inset-0 ring-4 ring-brand-yellow ring-offset-2 pointer-events-none" />}
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white border-4 border-black rounded-xl p-4 shadow-comic flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase text-slate-500">Estimate (Auto-updating)</div>
            <div className="text-lg font-display">
              {isCostLoading ? "Updating..." : costReport ? `$${costReport.cost_summary.totalCost.toFixed(4)}` : "n/a"}
            </div>
            <div className="text-[11px] font-mono text-slate-500">
              {costUpdatedAt ? `Updated ${new Date(costUpdatedAt).toLocaleTimeString()}` : "Waiting for data..."}
            </div>
            {auditSummary && (
              <div className="text-[11px] text-slate-600 mt-1 max-w-xl">{auditSummary}</div>
            )}
            {regenError && (
              <div className="text-[11px] text-red-600 mt-1">{regenError}</div>
            )}
          </div>
          {costReport && (
            <div className="text-xs font-mono text-slate-600 space-y-1">
              <div>Estimated CT: {estimatedCt?.toLocaleString()}</div>
              {comicCost && <div>Actual CT: {comicCost.totalActualCt.toLocaleString()}</div>}
              {comicCost && <div>Actual USD: ${comicCost.totalBillableUsd.toFixed(4)}</div>}
              <div>Tokens: {costReport.ai_usage.totalTokens}</div>
              <div>Artifacts: {costReport.ai_usage.totalArtifacts}</div>
            </div>
          )}
        </div>

        {/* Model & Layout Info Bar */}
        <div className="bg-slate-50 border-2 border-slate-200 rounded-lg px-4 py-2 flex flex-wrap items-center gap-4 text-xs font-mono text-slate-600">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-brand-blue" />
            <span className="font-bold text-slate-700">Model:</span> {activeModel?.label || 'Default'}
          </div>
          {gridTemplate ? (
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-brand-yellow" />
              <span className="font-bold text-slate-700">Layout:</span> {gridTemplate.title}
            </div>
          ) : state.layoutType ? (
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-brand-yellow" />
              <span className="font-bold text-slate-700">Layout:</span> {state.layoutType}
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-bold text-slate-700">Panels:</span> {panels.length}
          </div>
        </div>

        {/* Action Bar */}
        <div className="min-h-24 bg-white border-4 border-black rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-comic">
          <div className="flex items-center gap-4">
            <Button variant="secondary" onClick={() => setShowRegenModal(true)} disabled={!selectedPanel} isLoading={isRegenerating} icon={<RefreshCw className="w-4 h-4" />}>Edit / Regenerate</Button>
            <Button variant="outline" onClick={() => setShowHistoryModal(true)} disabled={!selectedPanel || (selectedPanel.imageIdHistory?.length || 0) <= 1} icon={<History className="w-4 h-4" />}>History</Button>
            <Button variant="outline" onClick={onReturnToPreview} icon={<ArrowLeftRight className="w-4 h-4" />}>Back To Preview</Button>
            <Button variant="outline" onClick={handleRunContinuityAudit} isLoading={auditLoading}>
              Continuity Audit
            </Button>
            <Button
              variant="outline"
              onClick={handleFixFlaggedPanels}
              disabled={!Object.values(auditScoresByPanel).some((score) => score.driftScore > 0.35)}
            >
              Fix Flagged
            </Button>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={handleShare} className="flex items-center gap-2 text-sm font-bold text-slate-600 hover:text-black">
              <Share2 size={16} /> {shareLink ? "Link Copied!" : "Share"}
            </button>
            {versions.length > 0 && (
              <div className="relative">
                <Button variant="outline" onClick={() => setShowVersionPicker(!showVersionPicker)}>
                  Versions ({versions.length})
                </Button>
                {showVersionPicker && (
                  <div className="absolute bottom-full mb-2 right-0 bg-white border-2 border-black rounded-lg shadow-comic p-2 z-50 w-72 max-h-56 overflow-y-auto">
                    <div className="text-xs font-bold text-slate-500 uppercase mb-2 px-2">Version History</div>
                    {versions.map(v => (
                      <button
                        key={v.id}
                        onClick={() => {
                          onUpdateProject({ state: v.state });
                          setShowVersionPicker(false);
                        }}
                        className="w-full text-left p-2 hover:bg-slate-100 rounded text-xs transition-colors"
                      >
                        <div className="font-bold truncate">{v.name}</div>
                        <div className="text-slate-500">{new Date(v.createdAt).toLocaleString()}</div>
                        {v.reason && <div className="text-[10px] text-slate-400 italic">{v.reason}</div>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={handleDownloadProjectData} variant="outline">Project ZIP</Button>
              <Button onClick={handleDownloadHTML} variant="outline" icon={<FileCode className="w-4 h-4" />}>HTML</Button>
              <Button onClick={handleDownloadPDF} icon={<Download className="w-4 h-4" />} className="bg-brand-yellow">PDF</Button>
            </div>
          </div>
        </div>
      </div>

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
    </div>
  );
};
