import React, { useState, useEffect } from 'react';
import { Download, Edit2, RefreshCw, X, History, Share2, FileCode, Loader2, ArrowLeftRight } from 'lucide-react';
import { ComicPanel, ComicState, DialogueBlock, TextLayout, ProjectReport } from '../../types';
import { generateImage } from '../../services/imageService';
import { runContinuityAudit } from '../../services/geminiService';
import { Button } from '../Button';
// Lazy loaded components
const ImagePreviewModal = React.lazy(() => import('../modals/ImagePreviewModal').then(module => ({ default: module.ImagePreviewModal })));
const RegenerateModal = React.lazy(() => import('../modals/RegenerateModal').then(module => ({ default: module.RegenerateModal })));
const HistoryModal = React.lazy(() => import('../modals/HistoryModal').then(module => ({ default: module.HistoryModal })));

import { exportProject, getImageUrl, getImageDataUrl } from '../../services/db';
import { ensureDialogueBlocks } from '../../services/dialogueUtils';
import { buildImagePrompt } from '../../services/imagePrompt';
import { parseRatio, resolveAspectRatio } from '../../services/imageUtils';
import { buildProjectReport } from '../../services/reporting';
import { loadArtifactsForProject } from '../../services/db';
import { downloadBlob } from '../../services/download';
import { collectPanelReferenceImageIds, resolvePanelContinuity, validateContinuityState } from '../../services/continuity';

declare const jspdf: any;
declare const html2canvas: any;

interface ReviewExportProps {
  projectId: string;
  projectName: string;
  panels: ComicPanel[];
  state: ComicState;
  onReturnToPreview: () => void;
  onUpdatePanel: (panelId: string, imageId: string, imageUrl: string) => void;
}

const renderPanelText = (panel: ComicPanel, layout: TextLayout) => {
  const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
  if (layout === 'none' || blocks.length === 0) return null;

  if (layout === 'chat_bubbles') {
    return (
      <div className="mt-2 space-y-2">
        {blocks.map(block => (
          <div
            key={block.id}
            className={`max-w-[80%] px-3 py-2 rounded-lg border-2 border-black text-xs font-comic font-bold ${block.side === 'right'
              ? 'ml-auto bg-brand-blue text-white'
              : 'bg-brand-yellow text-black'
              }`}
          >
            {block.speaker ? <span className="mr-1">{block.speaker}:</span> : null}
            {block.text}
          </div>
        ))}
      </div>
    );
  }

  if (layout === 'speech_bubbles') {
    return (
      <div className="absolute inset-0 pointer-events-none">
        {blocks.map((block, idx) => (
          <div
            key={block.id}
            className={`absolute text-[11px] font-comic font-bold bg-white/90 border-2 border-black px-2 py-1 rounded ${block.side === 'right'
              ? 'top-2 right-2'
              : block.side === 'center'
                ? 'top-2 left-1/2 -translate-x-1/2'
                : 'top-2 left-2'
              }`}
            style={{ top: `${8 + idx * 32}px` }}
          >
            {block.speaker ? <span className="mr-1">{block.speaker}:</span> : null}
            {block.text}
          </div>
        ))}
      </div>
    );
  }

  // caption
  return (
    <div className="absolute bottom-2 left-2 right-2 bg-white/90 p-2 text-sm font-comic font-bold text-black border-2 border-black rounded">
      {blocks.map(block => block.text).filter(Boolean).join(' ')}
    </div>
  );
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getDialogueBlocks = (panel: ComicPanel) =>
  ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);

export const ReviewExport: React.FC<ReviewExportProps> = ({ projectId, projectName, panels, state, onReturnToPreview, onUpdatePanel }) => {
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

  const textLayout = state.textLayout || 'caption';

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
    const validation = validateContinuityState(state);
    if ((state.continuity?.lockLevel === 'strict' || !state.continuity) && !validation.isValid) {
      setRegenError('Continuity lock is blocking regeneration. Resolve required references in Preview first.');
      return;
    }
    setRegenError(null);
    setIsRegenerating(true);
    setShowRegenModal(false);
    try {
      const panelIndex = panels.findIndex((p) => p.id === targetPanel.id);
      const continuityRefIds = collectPanelReferenceImageIds(state, targetPanel);
      const previousIds = panels
        .slice(Math.max(0, panelIndex - 2), panelIndex)
        .map((p) => p.imageId)
        .filter((id): id is string => !!id);
      const referenceIds = Array.from(new Set([...continuityRefIds, ...previousIds]));
      const ratioConfig = resolveAspectRatio(state, state.styleAspectRatio);
      const sceneCharacters = state.scenes.find(s => s.id === targetPanel.sceneId)?.characters.join(', ');
      const panelContinuity = resolvePanelContinuity(state, targetPanel);
      const requiredEntityNames = panelContinuity.requiredEntityIds
        .map((entityId) => state.continuity?.bible.entities.find((entity) => entity.id === entityId)?.name)
        .filter((name): name is string => !!name)
        .join(', ');
      const lockedLocation = panelContinuity.locationId
        ? state.continuity?.bible.entities.find((entity) => entity.id === panelContinuity.locationId)?.name
        : undefined;
      const prompt = buildImagePrompt({
        stage: "panel_regen",
        stylePrompt: state.stylePrompt,
        layoutType: state.layoutType === 'custom' ? state.customLayoutPrompt : state.layoutType,
        sceneAction: targetPanel.description,
        characters: sceneCharacters,
        continuitySummary: state.continuitySummary || undefined,
        instructions,
        requiredEntityNames: requiredEntityNames || undefined,
        lockedLocation,
        continuityLock: panelContinuity.continuityNotes || 'strict lock'
      });
      const generated = await generateImage(
        prompt,
        ratioConfig.modelRatio,
        state.imageResolution,
        referenceIds,
        projectId,
        {
          stage: 'panel_regen',
          cropToRatio: ratioConfig.cropRatio,
          meta: {
            source: {
              type: 'panel',
              id: targetPanel.id,
              label: `Scene ${targetPanel.sceneId} Panel ${panelIndex + 1}`
            },
            sceneId: targetPanel.sceneId,
            panelIndex,
            regen: true
          }
        }
      );
      if (generated?.imageUrl) {
        onUpdatePanel(targetPanel.id, generated.imageId, generated.imageUrl);
        setSelectedPanel(prev => prev ? {
          ...prev,
          imageId: generated.imageId,
          imageUrl: generated.imageUrl,
          imageIdHistory: [...(prev.imageIdHistory || []), generated.imageId],
          imageUrlHistory: [...(prev.imageUrlHistory || []), generated.imageUrl]
        } : null);
      }
    } catch (e) {
      console.error(e);
      setRegenError((e as Error)?.message || 'Regeneration failed.');
    } finally {
      setIsRegenerating(false);
    }
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
          .bubble{position:absolute;left:10px;right:10px;bottom:10px;background:#fff;padding:8px;border:2px solid #000;border-radius:8px;font-weight:bold;font-size:14px;}
          .chat{display:flex;flex-direction:column;gap:8px;padding:10px;}
          .chat .left{align-self:flex-start;background:#f9e547;color:#000;padding:6px 10px;border:2px solid #000;border-radius:10px;max-width:80%;font-size:13px;font-weight:bold;}
          .chat .right{align-self:flex-end;background:#2867ff;color:#fff;padding:6px 10px;border:2px solid #000;border-radius:10px;max-width:80%;font-size:13px;font-weight:bold;}
          .zoom-wrapper{transform-origin:top center;}
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
      const dialogue = (p.dialogueBlocks && p.dialogueBlocks.length > 0)
        ? p.dialogueBlocks.map(b => escapeHtml(b.text)).join(' ')
        : escapeHtml(p.dialogue || '');
      return `<div class="panel">
              <img src="${p.dataUrl || ''}" />
              ${textLayout === 'chat_bubbles'
          ? `<div class="chat">${getDialogueBlocks(p).map(b => `<div class="${b.side === 'right' ? 'right' : 'left'}">${escapeHtml(b.text)}</div>`).join('')}</div>`
          : textLayout === 'none' ? '' : `<div class="bubble">${dialogue}</div>`}
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
    .bubble{position:absolute;left:10px;right:10px;bottom:10px;background:#fff;padding:8px;border:2px solid #000;border-radius:8px;font-weight:bold;font-size:14px;}
    .chat{display:flex;flex-direction:column;gap:8px;padding:10px;}
    .chat .left{align-self:flex-start;background:#f9e547;color:#000;padding:6px 10px;border:2px solid #000;border-radius:10px;max-width:80%;font-size:13px;font-weight:bold;}
    .chat .right{align-self:flex-end;background:#2867ff;color:#fff;padding:6px 10px;border:2px solid #000;border-radius:10px;max-width:80%;font-size:13px;font-weight:bold;}
    .zoom-wrapper{transform-origin:top center;}
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
        const dialogue = (p.dialogueBlocks && p.dialogueBlocks.length > 0)
          ? p.dialogueBlocks.map(b => escapeHtml(b.text)).join(' ')
          : escapeHtml(p.dialogue || '');
        const imgRef = p.imageId ? `images/${imageFileMap[p.imageId] || ''}` : '';
        return `<div class="panel">
        <img src="${imgRef}" />
        ${textLayout === 'chat_bubbles'
            ? `<div class="chat">${getDialogueBlocks(p).map(b => `<div class="${b.side === 'right' ? 'right' : 'left'}">${escapeHtml(b.text)}</div>`).join('')}</div>`
            : textLayout === 'none' ? '' : `<div class="bubble">${dialogue}</div>`}
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

  const getLayoutClass = () => {
    switch (state.layoutType) {
      case 'webtoon': return 'flex flex-col items-center gap-4';
      case 'strip': return 'flex flex-col items-center gap-2';
      case 'graphic_novel': return 'grid grid-cols-3 gap-4 auto-rows-fr';
      case 'conversation_grid': return 'grid grid-cols-2 gap-4 auto-rows-fr';
      case 'splash_insets': return 'grid grid-cols-3 gap-4 auto-rows-[200px]';
      case 'golden_ratio': return 'grid grid-cols-3 gap-4 auto-rows-[180px]';
      case 'diagonal_action': return 'grid grid-cols-2 gap-4 auto-rows-[200px]';
      case 'storyboard': return 'grid grid-cols-3 gap-2 auto-rows-[150px]';
      case 'manga': return 'grid grid-cols-2 gap-4 auto-rows-fr';
      case 'cinematic': return 'grid grid-cols-1 gap-4';
      case 'grid':
      case 'custom':
      default:
        return `grid grid-cols-2 gap-4 auto-rows-fr`;
    }
  };

  const getPanelClass = (idx: number) => {
    switch (state.layoutType) {
      case 'splash_insets':
        return idx === 0 ? 'col-span-3 row-span-2' : 'col-span-1 row-span-1';
      case 'golden_ratio':
        return idx === 0 ? 'col-span-2 row-span-2' : 'col-span-1 row-span-1';
      case 'diagonal_action':
        return idx % 3 === 0 ? 'col-span-2 row-span-1' : 'col-span-1 row-span-1';
      case 'graphic_novel':
        return idx % 4 === 0 ? 'col-span-2 row-span-1' : 'col-span-1 row-span-1';
      default:
        return 'col-span-1 row-span-1';
    }
  };

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
          <div className={getLayoutClass()}>
            {panels.map((panel, idx) => (
              <div
                key={panel.id}
                className={`relative group border-4 border-black rounded-lg overflow-hidden shadow-comic cursor-pointer ${getPanelClass(idx)}`}
                onClick={() => setSelectedPanel(panel)}
              >
                <img src={panel.imageUrl} alt={`Panel ${idx + 1}`} className="w-full h-full object-cover" />
                {renderPanelText(panel, textLayout)}
                {auditScoresByPanel[panel.id] && (
                  <div className={`absolute left-2 top-2 px-2 py-1 text-[10px] font-bold rounded border ${
                    auditScoresByPanel[panel.id].driftScore > 0.35
                      ? 'bg-red-100 text-red-700 border-red-300'
                      : 'bg-green-100 text-green-700 border-green-300'
                  }`}>
                    Drift {Math.round(auditScoresByPanel[panel.id].driftScore * 100)}%
                  </div>
                )}

                {/* Hover Overlay */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button className="bg-white p-2 rounded-full hover:bg-brand-yellow border-2 border-black" onClick={(e) => { e.stopPropagation(); setSelectedPanel(panel); setShowRegenModal(true); }} aria-label="Edit panel"><Edit2 size={16} /></button>
                </div>

                {selectedPanel?.id === panel.id && <div className="absolute inset-0 ring-4 ring-brand-yellow ring-offset-2 pointer-events-none" />}
              </div>
            ))}
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
              <div>Tokens: {costReport.ai_usage.totalTokens}</div>
              <div>Artifacts: {costReport.ai_usage.totalArtifacts}</div>
            </div>
          )}
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
            <div className="flex gap-2">
              <Button onClick={handleDownloadProjectData} variant="outline">Project ZIP</Button>
              <Button onClick={handleDownloadHTML} variant="outline" icon={<FileCode className="w-4 h-4" />}>HTML</Button>
              <Button onClick={handleDownloadPDF} icon={<Download className="w-4 h-4" />} className="bg-brand-yellow">PDF</Button>
            </div>
          </div>
        </div>
      </div>

      {/* History Modal */}
      {/* History Modal */}
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
    </div>
  );
};
