import React, { useEffect, useMemo, useState } from 'react';
import { X, Download, ThumbsUp, ThumbsDown, Info, RefreshCw, Edit2, Trash2, Check, Globe, Lock } from 'lucide-react';
import JSZip from 'jszip';
import { Project, ProjectComment, AppStep, GenerationArtifact, ImageTag } from '../../types';
import { Button } from '../Button';
import { ModalPortal } from './ModalPortal';
import { exportProject, loadArtifactsForProject } from '../../services/db';
import { parseRatio } from '../../services/imageUtils';
import { estimateTokensFromTextInput } from '../../services/reporting';
import { assignImageTags, collectStateImageEntries } from '../../services/imageTags';
import { MasterGalleryModal, MasterGalleryItem } from './MasterGalleryModal';

interface ProjectInfoModalProps {
  project: Project;
  onClose: () => void;
  onUpdateProject: (projectId: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
}

const STEP_LABELS: Record<number, string> = {
  [AppStep.SCRIPT_INPUT]: 'Script',
  [AppStep.STYLE_SELECTION]: 'Style',
  [AppStep.REFERENCE_BUILDER]: 'World',
  [AppStep.COVER]: 'Cover',
  [AppStep.LAYOUT_SELECTION]: 'Layout',
  [AppStep.COMBINED_PREVIEW]: 'Preview',
  [AppStep.FULL_GENERATION]: 'Build',
  [AppStep.REVIEW_EXPORT]: 'Done'
};

const formatBytes = (bytes?: number) => {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
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

type VoteState = 'like' | 'dislike';

const LOCAL_USER_KEY = 'dreamstream_local_user_id';
const getLocalUserId = () => {
  try {
    const existing = localStorage.getItem(LOCAL_USER_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    localStorage.setItem(LOCAL_USER_KEY, next);
    return next;
  } catch {
    return 'local-user';
  }
};

const getVoteStorageKey = (projectId: string) => `dreamstream_comment_votes_${projectId}`;
const loadVoteMap = (projectId: string): Record<string, VoteState> => {
  try {
    const raw = localStorage.getItem(getVoteStorageKey(projectId));
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, VoteState>;
  } catch {
    return {};
  }
};

const saveVoteMap = (projectId: string, map: Record<string, VoteState>) => {
  try {
    localStorage.setItem(getVoteStorageKey(projectId), JSON.stringify(map));
  } catch {
    // ignore
  }
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

const loadImage = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image.'));
    img.src = dataUrl;
  });

export const ProjectInfoModal: React.FC<ProjectInfoModalProps> = ({ project, onClose, onUpdateProject }) => {
  const [overview, setOverview] = useState(project.state.overview || '');
  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentText, setCommentText] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const localUserId = useMemo(() => getLocalUserId(), []);
  const [commentVotes, setCommentVotes] = useState<Record<string, VoteState>>({});
  const [isPublic, setIsPublic] = useState(!!project.isPublic);
  const [exportData, setExportData] = useState<Awaited<ReturnType<typeof exportProject>> | null>(null);
  const [isLoadingExport, setIsLoadingExport] = useState(false);
  const [exportUpdatedAt, setExportUpdatedAt] = useState<number | null>(null);
  const [pdfSize, setPdfSize] = useState<number | null>(null);
  const [zipSize, setZipSize] = useState<number | null>(null);
  const [isBuildingPdf, setIsBuildingPdf] = useState(false);
  const [isBuildingZip, setIsBuildingZip] = useState(false);
  const [sizeUpdatedAt, setSizeUpdatedAt] = useState<number | null>(null);
  const [sizeSourceUpdatedAt, setSizeSourceUpdatedAt] = useState<number | null>(null);
  const [sizeStatus, setSizeStatus] = useState<'latest' | 'stale' | 'updating'>('stale');
  const hasExport = !!exportData?.project;
  const [artifacts, setArtifacts] = useState<GenerationArtifact[]>([]);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [expandedArtifactId, setExpandedArtifactId] = useState<string | null>(null);
  const [advancedCostOpen, setAdvancedCostOpen] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState('all');
  const [gallerySort, setGallerySort] = useState<'newest' | 'oldest' | 'tag' | 'category'>('newest');
  const [gallerySearch, setGallerySearch] = useState('');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryModalItems, setGalleryModalItems] = useState<MasterGalleryItem[]>([]);

  useEffect(() => {
    setOverview(project.state.overview || '');
  }, [project.id, project.state.overview]);

  useEffect(() => {
    setCommentVotes(loadVoteMap(project.id));
  }, [project.id]);

  useEffect(() => {
    let active = true;
    const loadExport = async () => {
      setIsLoadingExport(true);
      try {
        const data = await exportProject(project.id);
        if (active) {
          setExportData(data);
          setExportUpdatedAt(project.updatedAt);
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (active) setIsLoadingExport(false);
      }
    };
    loadExport();
    return () => {
      active = false;
    };
  }, [project.id, project.updatedAt]);

  useEffect(() => {
    let active = true;
    const handle = setTimeout(async () => {
      setIsLoadingArtifacts(true);
      try {
        const data = await loadArtifactsForProject(project.id);
        if (active) setArtifacts(data.sort((a, b) => b.timestamp - a.timestamp));
      } catch (e) {
        console.error(e);
      } finally {
        if (active) setIsLoadingArtifacts(false);
      }
    }, 400);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [project.id, project.updatedAt]);

  const comments = project.state.comments || [];

  const report = exportData?.report as any;
  const costSummary = report?.cost_summary || {};
  const usageSummary = report?.ai_usage || {};
  const storageSummary = report?.storage || {};
  const costByType = costSummary.byType || {};
  const imageCost = costByType?.image?.cost;
  const textCost = costByType?.text?.cost;

  const reportArtifacts = (report?.ai_usage?.artifacts || []) as Array<{
    id: string;
    totalTokens?: number;
    cost?: { value: number; currency: string };
    outputImageId?: string;
    inputImageIds?: string[];
    meta?: Record<string, unknown>;
  }>;
  const reportArtifactMap = useMemo(() => {
    const map = new Map<string, (typeof reportArtifacts)[number]>();
    reportArtifacts.forEach((artifact) => map.set(artifact.id, artifact));
    return map;
  }, [reportArtifacts]);

  const getArtifactTokens = (artifact: GenerationArtifact) => {
    const promptTokens = artifact.usage?.promptTokens ?? estimateTokensFromTextInput(artifact.prompt);
    const candidatesTokens = artifact.usage?.candidatesTokens ?? estimateTokensFromTextInput(artifact.responseText);
    const totalTokens = artifact.usage?.totalTokens ?? promptTokens + candidatesTokens;
    return { promptTokens, candidatesTokens, totalTokens };
  };

  const artifactSummary = useMemo(() => {
    const total = artifacts.length;
    const errors = artifacts.filter((artifact) => artifact.success === false || artifact.error).length;
    const tokens = artifacts.reduce((sum, artifact) => sum + getArtifactTokens(artifact).totalTokens, 0);
    const successRate = total ? (total - errors) / total : 0;
    const recentErrors = artifacts
      .filter((artifact) => artifact.success === false || artifact.error)
      .slice(0, 5);
    return {
      total,
      errors,
      tokens,
      successRate,
      recentErrors
    };
  }, [artifacts]);

  const multipleCostGroups = useMemo(() => {
    const groups = new Map<string, { id: string; label: string; count: number; cost: number; tokens: number }>();
    reportArtifacts.forEach((artifact: any) => {
      const source = artifact?.meta?.source;
      if (!source?.id) return;
      const key = String(source.id);
      const existing = groups.get(key) || {
        id: key,
        label: source.label || source.type || key,
        count: 0,
        cost: 0,
        tokens: 0
      };
      existing.count += 1;
      existing.cost += artifact?.cost?.value || 0;
      existing.tokens += artifact?.totalTokens || 0;
      groups.set(key, existing);
    });
    return Array.from(groups.values())
      .filter((item) => item.count > 1)
      .sort((a, b) => b.cost - a.cost);
  }, [reportArtifacts]);

  const handleSaveOverview = () => {
    const trimmed = overview.trim();
    onUpdateProject(project.id, (prev) => ({
      state: { ...prev.state, overview: trimmed }
    }));
  };

  const handleAddComment = () => {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    const newComment: ProjectComment = {
      id: crypto.randomUUID(),
      authorId: localUserId,
      author: commentAuthor.trim() || undefined,
      text: trimmed,
      createdAt: Date.now(),
      likes: 0,
      dislikes: 0
    };
    onUpdateProject(project.id, (prev) => ({
      state: { ...prev.state, comments: [...(prev.state.comments || []), newComment] }
    }));
    setCommentText('');
    setCommentAuthor('');
  };

  const handleVote = (commentId: string, nextVote: VoteState) => {
    const currentVote = commentVotes[commentId];
    let likeDelta = 0;
    let dislikeDelta = 0;

    if (currentVote === 'like') likeDelta -= 1;
    if (currentVote === 'dislike') dislikeDelta -= 1;

    const finalVote = currentVote === nextVote ? null : nextVote;
    if (finalVote === 'like') likeDelta += 1;
    if (finalVote === 'dislike') dislikeDelta += 1;

    onUpdateProject(project.id, (prev) => ({
      state: {
        ...prev.state,
        comments: (prev.state.comments || []).map((comment) => {
          if (comment.id !== commentId) return comment;
          return {
            ...comment,
            likes: Math.max(0, (comment.likes || 0) + likeDelta),
            dislikes: Math.max(0, (comment.dislikes || 0) + dislikeDelta)
          };
        })
      }
    }));

    const nextMap = { ...commentVotes };
    if (finalVote) {
      nextMap[commentId] = finalVote;
    } else {
      delete nextMap[commentId];
    }
    setCommentVotes(nextMap);
    saveVoteMap(project.id, nextMap);
  };

  const handleStartEdit = (comment: ProjectComment) => {
    setEditingCommentId(comment.id);
    setEditingCommentText(comment.text);
  };

  const handleSaveEdit = () => {
    if (!editingCommentId) return;
    const trimmed = editingCommentText.trim();
    if (!trimmed) return;
    onUpdateProject(project.id, (prev) => ({
      state: {
        ...prev.state,
        comments: (prev.state.comments || []).map((comment) => {
          if (comment.id !== editingCommentId) return comment;
          return { ...comment, text: trimmed, updatedAt: Date.now() };
        })
      }
    }));
    setEditingCommentId(null);
    setEditingCommentText('');
  };

  const handleDeleteComment = (commentId: string) => {
    onUpdateProject(project.id, (prev) => ({
      state: {
        ...prev.state,
        comments: (prev.state.comments || []).filter((comment) => comment.id !== commentId)
      }
    }));
    if (commentVotes[commentId]) {
      const nextMap = { ...commentVotes };
      delete nextMap[commentId];
      setCommentVotes(nextMap);
      saveVoteMap(project.id, nextMap);
    }
  };

  const stateImageUrlMap = useMemo(() => {
    const map: Record<string, string> = {};
    const add = (id?: string, url?: string) => {
      if (id && url && !map[id]) map[id] = url;
    };
    add(project.state.coverImageId, project.state.coverImageUrl);
    add(project.state.coverTemplateImageId, project.state.coverTemplateImageUrl);
    project.state.styleVariants.forEach((variant) => add(variant.imageId, variant.imageUrl));
    project.state.characters.forEach((entity) => add(entity.imageId, entity.imageUrl));
    project.state.items.forEach((entity) => add(entity.imageId, entity.imageUrl));
    project.state.locations.forEach((entity) => add(entity.imageId, entity.imageUrl));
    project.state.panels.forEach((panel) => {
      add(panel.imageId, panel.imageUrl);
      if (panel.imageIdHistory && panel.imageUrlHistory) {
        panel.imageIdHistory.forEach((id, idx) => add(id, panel.imageUrlHistory?.[idx]));
      }
    });
    return map;
  }, [
    project.state.coverImageId,
    project.state.coverImageUrl,
    project.state.coverTemplateImageId,
    project.state.coverTemplateImageUrl,
    project.state.styleVariants,
    project.state.characters,
    project.state.items,
    project.state.locations,
    project.state.panels
  ]);

  const resolveImageUrl = (
    imageId?: string,
    fallbackUrl?: string,
    dataOverride?: Awaited<ReturnType<typeof exportProject>> | null
  ) => {
    const data = dataOverride || exportData;
    if (imageId && data?.images?.[imageId]) return data.images[imageId];
    if (imageId && stateImageUrlMap[imageId]) return stateImageUrlMap[imageId];
    return fallbackUrl;
  };

  const getCoverImageUrl = (dataOverride?: Awaited<ReturnType<typeof exportProject>> | null) =>
    resolveImageUrl(project.state.coverImageId, project.state.coverImageUrl, dataOverride);

  const getPanelImageUrls = (dataOverride?: Awaited<ReturnType<typeof exportProject>> | null) =>
    project.state.panels
      .map((panel) => resolveImageUrl(panel.imageId, panel.imageUrl, dataOverride))
      .filter((url): url is string => !!url);

  const buildUsedIn = (tag?: ImageTag) => {
    const used: string[] = [];
    if (tag?.source?.label) used.push(tag.source.label);
    if (tag?.source?.type && !used.includes(tag.source.type)) {
      used.push(tag.source.type.replace(/_/g, ' '));
    }
    if (tag?.label && !used.includes(tag.label)) used.push(tag.label);
    return used;
  };

  const galleryItems = useMemo<MasterGalleryItem[]>(() => {
    const tagMap = project.state.imageTags || {};
    const ids = new Set<string>(Object.keys(tagMap));
    artifacts.forEach((artifact) => {
      if (artifact.outputImageId) ids.add(artifact.outputImageId);
    });
    const items = Array.from(ids).map((imageId) => {
      const url = resolveImageUrl(imageId);
      if (!url) return null;
      const tag = tagMap[imageId];
      return {
        imageId,
        url,
        tag: tag?.tag,
        label: tag?.label,
        category: tag?.category,
        usedIn: buildUsedIn(tag)
      } as MasterGalleryItem;
    });
    return items.filter((item): item is MasterGalleryItem => !!item);
  }, [project.state.imageTags, artifacts, exportData, stateImageUrlMap]);

  const galleryCategories = useMemo(() => {
    const values = new Set<string>();
    galleryItems.forEach((item) => {
      if (item.category) values.add(item.category);
    });
    return Array.from(values).sort();
  }, [galleryItems]);

  const filteredGallery = useMemo(() => {
    let items = [...galleryItems];
    if (galleryFilter !== 'all') {
      items = items.filter((item) => item.category === galleryFilter);
    }
    const search = gallerySearch.trim().toLowerCase();
    if (search) {
      items = items.filter((item) => {
        const hay = [item.tag, item.label, item.category, ...(item.usedIn || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(search);
      });
    }
    if (gallerySort === 'tag') {
      items.sort((a, b) => (a.tag || '').localeCompare(b.tag || ''));
    } else if (gallerySort === 'category') {
      items.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
    } else if (gallerySort === 'oldest') {
      items.sort((a, b) => {
        const tagA = project.state.imageTags?.[a.imageId]?.createdAt || 0;
        const tagB = project.state.imageTags?.[b.imageId]?.createdAt || 0;
        return tagA - tagB;
      });
    } else {
      items.sort((a, b) => {
        const tagA = project.state.imageTags?.[a.imageId]?.createdAt || 0;
        const tagB = project.state.imageTags?.[b.imageId]?.createdAt || 0;
        return tagB - tagA;
      });
    }
    return items;
  }, [galleryItems, galleryFilter, gallerySearch, gallerySort, project.state.imageTags]);

  const openGalleryModal = (items: MasterGalleryItem[], index: number) => {
    setGalleryModalItems(items);
    setGalleryIndex(index);
    setGalleryOpen(true);
  };

  const buildPdfBlob = async (dataOverride?: Awaited<ReturnType<typeof exportProject>> | null) => {
    const jspdf = (window as any).jspdf;
    if (!jspdf?.jsPDF) throw new Error('jsPDF not loaded');
    const ratioValue = parseRatio(project.state.customAspectRatioEnabled && project.state.customAspectRatio
      ? project.state.customAspectRatio
      : project.state.styleAspectRatio) || 1;
    const orientation = ratioValue < 1 ? 'p' : 'l';
    const pdf = new jspdf.jsPDF(orientation, 'mm', 'a4');

    const images: string[] = [];
    const cover = getCoverImageUrl(dataOverride);
    if (cover) images.push(cover);
    images.push(...getPanelImageUrls(dataOverride));

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();

    for (let i = 0; i < images.length; i += 1) {
      const dataUrl = images[i];
      if (!dataUrl) continue;
      const img = await loadImage(dataUrl);
      const imgRatio = img.width / img.height;
      let targetWidth = pdfWidth;
      let targetHeight = pdfWidth / imgRatio;
      if (targetHeight > pdfHeight) {
        targetHeight = pdfHeight;
        targetWidth = pdfHeight * imgRatio;
      }
      const x = (pdfWidth - targetWidth) / 2;
      const y = (pdfHeight - targetHeight) / 2;
      const format = dataUrl.includes('image/jpeg') ? 'JPEG' : 'PNG';
      if (i > 0) pdf.addPage();
      pdf.addImage(dataUrl, format, x, y, targetWidth, targetHeight);
    }

    return pdf.output('blob');
  };

  const buildProjectZip = async (dataOverride?: Awaited<ReturnType<typeof exportProject>> | null) => {
    const data = dataOverride || exportData;
    if (!data?.project) throw new Error('Project data missing');

    const zip = new JSZip();
    const safeName = project.name.replace(/[^a-zA-Z0-9-_]+/g, '_');

    zip.file('project.json', JSON.stringify(data.project, null, 2));

    const imagesFolder = zip.folder('images');
    const imageFileMap: Record<string, string> = {};
    if (imagesFolder) {
      Object.entries(data.images).forEach(([id, dataUrl]) => {
        const { mimeType, base64 } = parseDataUrl(dataUrl as string);
        const ext = getExtensionFromMime(mimeType);
        const filename = `${id}.${ext}`;
        imageFileMap[id] = filename;
        imagesFolder.file(filename, base64, { base64: true });
      });
    }

    const artifactsFolder = zip.folder('artifacts');
    if (artifactsFolder) {
      artifactsFolder.file('artifacts.json', JSON.stringify(data.artifacts, null, 2));
    }

    const reportFolder = zip.folder('report');
    if (reportFolder && data.report) {
      reportFolder.file('ai_usage.json', JSON.stringify(data.report.ai_usage, null, 2));
      reportFolder.file('cost_summary.json', JSON.stringify(data.report.cost_summary, null, 2));
      reportFolder.file('storage.json', JSON.stringify(data.report.storage, null, 2));
    }

    const tagMap = project.state.imageTags || {};
    const galleryEntries = Object.keys(imageFileMap).map((imageId) => {
      const tag = tagMap[imageId];
      return {
        imageId,
        filename: `images/${imageFileMap[imageId]}`,
        tag: tag?.tag,
        category: tag?.category,
        usedIn: buildUsedIn(tag)
      };
    });
    zip.file('gallery.json', JSON.stringify(galleryEntries, null, 2));

    const coverImageRef = project.state.coverImageId ? `images/${imageFileMap[project.state.coverImageId] || ''}` : '';
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(project.name)}</title>
  <style>
    body{margin:0;padding:20px;background:#eee;font-family:Arial,sans-serif;}
    .comic-container{max-width:900px;margin:0 auto;background:white;padding:20px;box-shadow:0 4px 6px rgba(0,0,0,0.1);} 
    .cover{margin-bottom:24px;border:4px solid #000;overflow:hidden;}
    .cover img{width:100%;display:block;}
    .panel{margin-bottom:20px;border:2px solid black;position:relative;overflow:hidden;}
    .panel img{width:100%;display:block;}
  </style>
</head>
<body>
  <div class="comic-container">
    ${coverImageRef ? `<div class="cover"><img src="${coverImageRef}" /></div>` : ''}
    ${project.state.panels.map(p => {
      const imgRef = p.imageId ? `images/${imageFileMap[p.imageId] || ''}` : '';
      return `<div class="panel"><img src="${imgRef}" /></div>`;
    }).join('')}
  </div>
</body>
</html>`;

    zip.file('comic.html', html);

    zip.file(
      'readme.txt',
      `DreamStream Comic Studio Export\n\nProject: ${project.name}\n\nContents:\n- project.json (full project state, image IDs)\n- images/ (all generated and reference images)\n- artifacts/ (AI prompts, models, timestamps, outputs)\n- report/ (ai usage, cost, storage)\n- gallery.json (mastery gallery index)\n- comic.html (offline comic viewer)\n`
    );

    const blob = await zip.generateAsync({ type: 'blob' });
    return { blob, filename: `${safeName || 'comic'}_project.zip` };
  };

  const ensureExportData = async () => {
    if (exportData && exportUpdatedAt === project.updatedAt) return exportData;
    setIsLoadingExport(true);
    try {
      const data = await exportProject(project.id);
      setExportData(data);
      setExportUpdatedAt(project.updatedAt);
      return data;
    } finally {
      setIsLoadingExport(false);
    }
  };

  const handleDownloadPdf = async () => {
    try {
      setIsBuildingPdf(true);
      const data = await ensureExportData();
      const blob = await buildPdfBlob(data);
      setPdfSize(blob.size);
      setSizeUpdatedAt(Date.now());
      setSizeSourceUpdatedAt(project.updatedAt);
      setSizeStatus('latest');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'comic'}_comic.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    } finally {
      setIsBuildingPdf(false);
    }
  };

  const handleDownloadHtml = async () => {
    try {
      const data = exportData;
      const cover = getCoverImageUrl(data);
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(project.name)}</title>
  <style>
    body{margin:0;padding:20px;background:#eee;font-family:Arial,sans-serif;}
    .comic-container{max-width:900px;margin:0 auto;background:white;padding:20px;box-shadow:0 4px 6px rgba(0,0,0,0.1);} 
    .cover{margin-bottom:24px;border:4px solid #000;overflow:hidden;}
    .cover img{width:100%;display:block;}
    .panel{margin-bottom:20px;border:2px solid black;position:relative;overflow:hidden;}
    .panel img{width:100%;display:block;}
  </style>
</head>
<body>
  <div class="comic-container">
    ${cover ? `<div class="cover"><img src="${cover}" /></div>` : ''}
    ${project.state.panels.map(p => {
        const imgRef = resolveImageUrl(p.imageId, p.imageUrl, data);
        return `<div class="panel"><img src="${imgRef || ''}" /></div>`;
      }).join('')}
  </div>
</body>
</html>`;

      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'comic'}.html`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDownloadZip = async () => {
    try {
      setIsBuildingZip(true);
      const data = await ensureExportData();
      const { blob, filename } = await buildProjectZip(data);
      setZipSize(blob.size);
      setSizeUpdatedAt(Date.now());
      setSizeSourceUpdatedAt(project.updatedAt);
      setSizeStatus('latest');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    } finally {
      setIsBuildingZip(false);
    }
  };

  const handleRefreshSizes = async () => {
    try {
      setIsBuildingPdf(true);
      setIsBuildingZip(true);
      setSizeStatus('updating');
      const data = await ensureExportData();
      const [pdfBlob, zipResult] = await Promise.all([buildPdfBlob(data), buildProjectZip(data)]);
      setPdfSize(pdfBlob.size);
      setZipSize(zipResult.blob.size);
      setSizeUpdatedAt(Date.now());
      setSizeSourceUpdatedAt(project.updatedAt);
      setSizeStatus('latest');
    } catch (e) {
      console.error(e);
      setSizeStatus('stale');
    } finally {
      setIsBuildingPdf(false);
      setIsBuildingZip(false);
    }
  };

  useEffect(() => {
    const currentTags = project.state.imageTags || {};
    const currentCounters = project.state.imageTagCounters || {};
    const entries = collectStateImageEntries(project.state);
    const missing = artifacts
      .map((artifact) => artifact.outputImageId)
      .filter((id): id is string => !!id && !currentTags[id]);
    missing.forEach((id) => {
      entries.push({
        imageId: id,
        category: 'ORPHAN',
        label: 'Artifact Output',
        source: { type: 'artifact', id, label: 'Artifact Output' }
      });
    });
    if (entries.length === 0) return;
    const { tags, counters, added } = assignImageTags(currentTags, currentCounters, entries);
    if (added.length === 0) return;
    onUpdateProject(project.id, (prev) => ({
      state: { ...prev.state, imageTags: tags, imageTagCounters: counters }
    }));
  }, [artifacts, project.id, project.state, project.state.imageTags, project.state.imageTagCounters, onUpdateProject]);

  useEffect(() => {
    if (!sizeSourceUpdatedAt) {
      setSizeStatus('stale');
      return;
    }
    if (project.updatedAt > sizeSourceUpdatedAt) {
      setSizeStatus('stale');
    } else {
      setSizeStatus('latest');
    }
  }, [project.updatedAt, sizeSourceUpdatedAt]);

  useEffect(() => {
    if (sizeStatus !== 'stale') return;
    const handle = setTimeout(() => {
      void handleRefreshSizes();
    }, 1200);
    return () => clearTimeout(handle);
  }, [sizeStatus, project.updatedAt]);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="relative max-w-5xl w-full max-h-[90vh] overflow-y-auto bg-white border-4 border-black rounded-2xl shadow-comic p-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center">
                <Info className="w-5 h-5" />
              </div>
              <div>
                <div className="text-xs font-bold uppercase text-slate-500">Project Info</div>
                <h2 className="font-display text-2xl">{project.name}</h2>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-brand-red">
              <X className="w-6 h-6" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-6">
              <div className="border-4 border-black rounded-xl p-4 bg-slate-50 shadow-comic">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-bold uppercase text-slate-500">Overview</div>
                  <button
                    onClick={() => {
                      const next = !isPublic;
                      setIsPublic(next);
                      onUpdateProject(project.id, { isPublic: next });
                    }}
                    className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold border-2 border-black transition-all ${isPublic ? 'bg-green-400 shadow-[2px_2px_0px_0px_#000]' : 'bg-slate-200 opacity-70'
                      }`}
                    title={isPublic ? "Visible in Public Gallery" : "Only visible to you"}
                  >
                    {isPublic ? <Globe size={14} /> : <Lock size={14} />}
                    {isPublic ? 'Public' : 'Private'}
                  </button>
                </div>
                <textarea
                  value={overview}
                  onChange={(e) => setOverview(e.target.value)}
                  placeholder="Write a quick overview for this comic..."
                  className="w-full mt-2 border-2 border-black rounded-lg p-3 text-sm font-comic min-h-[120px]"
                />
                <div className="mt-3 flex justify-end">
                  <Button size="sm" onClick={handleSaveOverview}>Save Overview</Button>
                </div>
              </div>

              <div className="border-4 border-black rounded-xl p-4 bg-white shadow-comic">
                <div className="text-xs font-bold uppercase text-slate-500">Project Stats</div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm font-bold">
                  <div>Step: <span className="font-mono">{STEP_LABELS[project.state.step] || 'Unknown'}</span></div>
                  <div>Scenes: <span className="font-mono">{project.state.scenes.length}</span></div>
                  <div>Panels: <span className="font-mono">{project.state.panels.length}</span></div>
                  <div>Updated: <span className="font-mono">{new Date(project.updatedAt).toLocaleString()}</span></div>
                  <div>Layout: <span className="font-mono">{project.state.layoutType}</span></div>
                  <div>Text: <span className="font-mono">{project.state.textLayout || 'caption'}</span></div>
                </div>
              </div>

              <div className="border-4 border-black rounded-xl p-4 bg-white shadow-comic">
                <div className="text-xs font-bold uppercase text-slate-500">Cost & Usage</div>
                {isLoadingExport ? (
                  <div className="mt-3 text-sm font-comic text-slate-500">Loading report…</div>
                ) : (
                  <div className="mt-3 space-y-2 text-sm font-bold">
                    <div>Total Cost: <span className="font-mono">{costSummary.totalCost !== undefined ? `${costSummary.currency || '$'}${Number(costSummary.totalCost).toFixed(4)}` : 'n/a'}</span></div>
                    {imageCost !== undefined && (
                      <div>Image Cost: <span className="font-mono">{`${costSummary.currency || '$'}${Number(imageCost).toFixed(4)}`}</span></div>
                    )}
                    {textCost !== undefined && (
                      <div>Text Cost: <span className="font-mono">{`${costSummary.currency || '$'}${Number(textCost).toFixed(4)}`}</span></div>
                    )}
                    <div>Artifacts: <span className="font-mono">{usageSummary.totalArtifacts ?? 'n/a'}</span></div>
                    <div>Tokens: <span className="font-mono">{usageSummary.totalTokens ?? 'n/a'}</span></div>
                    <div>Estimated Items: <span className="font-mono">{costSummary.estimatedArtifactCount ?? 0}</span></div>
                    <button
                      onClick={() => setAdvancedCostOpen((prev) => !prev)}
                      className="mt-2 text-xs font-bold underline"
                    >
                      {advancedCostOpen ? 'Hide Advanced' : 'Show Advanced'}
                    </button>
                    {advancedCostOpen && (
                      <div className="mt-3 space-y-3">
                        <div>
                          <div className="text-xs font-bold uppercase text-slate-500 mb-2">Per-Artifact Costs</div>
                          <div className="max-h-48 overflow-y-auto border-2 border-black rounded-lg">
                            {reportArtifacts.length === 0 && (
                              <div className="p-2 text-xs text-slate-500 font-comic">No artifact costs available.</div>
                            )}
                            {reportArtifacts.slice(0, 50).map((artifact: any) => {
                              const tag = artifact.outputImageId ? project.state.imageTags?.[artifact.outputImageId]?.tag : undefined;
                              return (
                                <div key={artifact.id} className="flex items-center justify-between px-2 py-1 text-[11px] border-b border-black/10">
                                  <div>
                                    <div className="font-bold uppercase">{artifact.stage || 'unknown'} · {artifact.type}</div>
                                    <div className="text-slate-500">{artifact.model}</div>
                                    {tag && <div className="text-slate-500">{tag}</div>}
                                  </div>
                                  <div className="text-right font-mono">
                                    <div>{artifact.totalTokens ?? 'n/a'} tok</div>
                                    <div>{artifact.cost?.value !== undefined ? `${artifact.cost?.currency || costSummary.currency || '$'}${Number(artifact.cost?.value).toFixed(4)}` : 'n/a'}</div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-bold uppercase text-slate-500 mb-2">Multiple Cost Occurrences</div>
                          {multipleCostGroups.length === 0 && (
                            <div className="text-xs text-slate-500 font-comic">No repeated cost sources detected.</div>
                          )}
                          {multipleCostGroups.map((group) => (
                            <div key={group.id} className="flex items-center justify-between text-[11px] font-bold border-2 border-black rounded px-2 py-1 bg-slate-50 mb-2">
                              <div>{group.label}</div>
                              <div className="font-mono">{group.count}x · {costSummary.currency || '$'}{group.cost.toFixed(4)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-6">
              <div className="border-4 border-black rounded-xl p-4 bg-white shadow-comic">
                <div className="text-xs font-bold uppercase text-slate-500">Storage & Files</div>
                {isLoadingExport ? (
                  <div className="mt-3 text-sm font-comic text-slate-500">Loading storage…</div>
                ) : (
                  <div className="mt-3 space-y-2 text-sm font-bold">
                    <div>Images: <span className="font-mono">{storageSummary.imageCount ?? 0}</span></div>
                    <div>Image Bytes: <span className="font-mono">{formatBytes(storageSummary.imageBytes)}</span></div>
                    <div>Project ZIP Size: <span className="font-mono">{zipSize ? formatBytes(zipSize) : 'n/a'}</span></div>
                    <div>PDF Size: <span className="font-mono">{pdfSize ? formatBytes(pdfSize) : 'n/a'}</span></div>
                    <div>Last Updated: <span className="font-mono">{sizeUpdatedAt ? new Date(sizeUpdatedAt).toLocaleString() : 'n/a'}</span></div>
                    <div>Status: <span className="font-mono">{sizeStatus === 'latest' ? 'Latest' : sizeStatus === 'updating' ? 'Updating' : 'Stale'}</span></div>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={handleDownloadPdf} icon={<Download className="w-4 h-4" />} disabled={!hasExport || isBuildingPdf}>Download PDF</Button>
                  <Button size="sm" variant="secondary" onClick={handleDownloadHtml} icon={<Download className="w-4 h-4" />} disabled={!hasExport}>Download HTML</Button>
                  <Button size="sm" variant="secondary" onClick={handleDownloadZip} icon={<Download className="w-4 h-4" />} disabled={!hasExport || isBuildingZip}>Download ZIP</Button>
                  <Button size="sm" variant="outline" onClick={handleRefreshSizes} icon={<RefreshCw className="w-4 h-4" />} disabled={!hasExport}>Update Sizes</Button>
                  {sizeStatus === 'latest' && (
                    <span className="text-xs font-bold text-slate-500 self-center">Latest</span>
                  )}
                </div>
              </div>

              <div className="border-4 border-black rounded-xl p-4 bg-slate-50 shadow-comic">
                <div className="text-xs font-bold uppercase text-slate-500">User Reviews</div>
                <div className="mt-3 space-y-3">
                  {comments.length === 0 && (
                    <div className="text-sm font-comic text-slate-500">No reviews yet. Be the first!</div>
                  )}
                  {comments.map((comment) => {
                    const canEdit = !comment.authorId || comment.authorId === localUserId;
                    const isEditing = editingCommentId === comment.id;
                    const isLiked = commentVotes[comment.id] === 'like';
                    const isDisliked = commentVotes[comment.id] === 'dislike';
                    const hasEdit = !!comment.updatedAt && comment.updatedAt !== comment.createdAt;
                    const timestamp = new Date(comment.updatedAt || comment.createdAt).toLocaleString();

                    return (
                      <div key={comment.id} className="bg-white border-2 border-black rounded-lg p-3">
                        <div className="flex items-start justify-between text-xs font-bold text-slate-500">
                          <div>{comment.author || 'Anonymous'}</div>
                          <div className="text-right">
                            <div>{timestamp}</div>
                            {hasEdit && <div className="text-[10px] uppercase">Edited</div>}
                          </div>
                        </div>
                        {isEditing ? (
                          <div className="mt-2 space-y-2">
                            <textarea
                              value={editingCommentText}
                              onChange={(e) => setEditingCommentText(e.target.value)}
                              className="w-full border-2 border-black rounded px-2 py-1 text-sm"
                            />
                            <div className="flex gap-2">
                              <button onClick={handleSaveEdit} className="px-2 py-1 text-xs font-bold border-2 border-black rounded bg-brand-yellow">
                                <Check className="w-3 h-3 inline-block mr-1" /> Save
                              </button>
                              <button
                                onClick={() => {
                                  setEditingCommentId(null);
                                  setEditingCommentText('');
                                }}
                                className="px-2 py-1 text-xs font-bold border-2 border-black rounded"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2 text-sm font-comic text-black">{comment.text}</div>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-bold">
                          <button
                            onClick={() => handleVote(comment.id, 'like')}
                            className={`flex items-center gap-1 ${isLiked ? 'text-brand-blue' : ''}`}
                          >
                            <ThumbsUp className="w-4 h-4" /> {comment.likes}
                          </button>
                          <button
                            onClick={() => handleVote(comment.id, 'dislike')}
                            className={`flex items-center gap-1 ${isDisliked ? 'text-brand-red' : ''}`}
                          >
                            <ThumbsDown className="w-4 h-4" /> {comment.dislikes}
                          </button>
                          {canEdit && !isEditing && (
                            <>
                              <button onClick={() => handleStartEdit(comment)} className="flex items-center gap-1">
                                <Edit2 className="w-3 h-3" /> Edit
                              </button>
                              <button onClick={() => handleDeleteComment(comment.id)} className="flex items-center gap-1 text-brand-red">
                                <Trash2 className="w-3 h-3" /> Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 border-t-2 border-black pt-4 space-y-2">
                  <input
                    value={commentAuthor}
                    onChange={(e) => setCommentAuthor(e.target.value)}
                    placeholder="Your name (optional)"
                    className="w-full border-2 border-black rounded px-3 py-2 text-xs"
                  />
                  <textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Write a quick review..."
                    className="w-full border-2 border-black rounded px-3 py-2 text-sm min-h-[80px]"
                  />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleAddComment}>Post Review</Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-6 space-y-6">
            <div className="border-4 border-black rounded-xl p-4 bg-white shadow-comic">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-xs font-bold uppercase text-slate-500">Mastery Gallery</div>
                  <div className="font-display text-xl">Mastery Gallery</div>
                </div>
                <div className="text-xs font-bold">{filteredGallery.length} images</div>
              </div>
              <div className="flex flex-col md:flex-row gap-2 mb-3">
                <input
                  value={gallerySearch}
                  onChange={(e) => setGallerySearch(e.target.value)}
                  placeholder="Search tags, labels, usage..."
                  className="flex-1 border-2 border-black rounded px-3 py-2 text-xs font-bold"
                />
                <select
                  value={galleryFilter}
                  onChange={(e) => setGalleryFilter(e.target.value)}
                  className="border-2 border-black rounded px-2 py-2 text-xs font-bold"
                >
                  <option value="all">All Categories</option>
                  {galleryCategories.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                <select
                  value={gallerySort}
                  onChange={(e) => setGallerySort(e.target.value as typeof gallerySort)}
                  className="border-2 border-black rounded px-2 py-2 text-xs font-bold"
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="tag">Tag</option>
                  <option value="category">Category</option>
                </select>
              </div>
              {filteredGallery.length === 0 ? (
                <div className="text-sm font-comic text-slate-500">No images match your filters yet.</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {filteredGallery.map((item, idx) => (
                    <button
                      key={item.imageId}
                      onClick={() => openGalleryModal(filteredGallery, idx)}
                      className="border-2 border-black rounded-lg p-2 bg-slate-50 hover:bg-white transition-all text-left"
                    >
                      <img src={item.url} alt={item.tag || item.label || 'gallery'} className="w-full h-32 object-cover rounded" />
                      <div className="mt-2 text-[11px] font-bold">{item.tag || item.category || 'UNTAGGED'}</div>
                      <div className="text-[10px] text-slate-500 truncate">{item.usedIn?.[0] || item.label || item.category}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="border-4 border-black rounded-xl p-4 bg-white shadow-comic">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-xs font-bold uppercase text-slate-500">Generation Log</div>
                  <div className="font-display text-xl">Production Runs</div>
                </div>
                <div className="text-xs font-bold">{isLoadingArtifacts ? 'Loading…' : `${artifacts.length} events`}</div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-bold mb-4">
                <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Events: {artifactSummary.total}</div>
                <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Success: {Math.round(artifactSummary.successRate * 100)}%</div>
                <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Errors: {artifactSummary.errors}</div>
                <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Tokens: {artifactSummary.tokens}</div>
              </div>

              <div className="mb-4">
                <div className="text-xs font-bold uppercase text-slate-500 mb-2">Recent Errors</div>
                {artifactSummary.recentErrors.length === 0 && (
                  <div className="text-xs text-slate-500 font-comic">No recent errors.</div>
                )}
                {artifactSummary.recentErrors.map((artifact) => (
                  <div key={artifact.id} className="border-2 border-black rounded px-2 py-1 bg-red-50 text-[11px] mb-2">
                    <div className="font-bold uppercase">{artifact.stage || artifact.type}</div>
                    <div>{artifact.error || 'Unknown error'}</div>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-[11px] border-2 border-black">
                  <thead className="bg-slate-100 border-b-2 border-black">
                    <tr>
                      <th className="p-2 text-left">Time</th>
                      <th className="p-2 text-left">Stage</th>
                      <th className="p-2 text-left">Type</th>
                      <th className="p-2 text-left">Duration</th>
                      <th className="p-2 text-left">API</th>
                      <th className="p-2 text-left">Save</th>
                      <th className="p-2 text-left">Provider</th>
                      <th className="p-2 text-left">Model</th>
                      <th className="p-2 text-left">Prompt</th>
                      <th className="p-2 text-left">Tokens</th>
                      <th className="p-2 text-left">Cost</th>
                      <th className="p-2 text-left">Output</th>
                      <th className="p-2 text-left">Status</th>
                      <th className="p-2 text-left">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {artifacts.length === 0 && (
                      <tr>
                        <td className="p-3 text-center text-slate-500 font-comic" colSpan={14}>
                          No generation artifacts yet.
                        </td>
                      </tr>
                    )}
                    {artifacts.map((artifact) => {
                      const tokens = getArtifactTokens(artifact).totalTokens;
                      const reportRow = reportArtifactMap.get(artifact.id);
                      const costValue = reportRow?.cost?.value;
                      const currency = reportRow?.cost?.currency || costSummary.currency || '$';
                      const outputTag = artifact.outputImageId
                        ? project.state.imageTags?.[artifact.outputImageId]?.tag || artifact.outputImageId
                        : '—';
                      const promptPreview = artifact.prompt
                        ? artifact.prompt.length > 60
                          ? `${artifact.prompt.slice(0, 60)}…`
                          : artifact.prompt
                        : '—';
                      const status = artifact.success === false || artifact.error ? 'Failed' : 'OK';
                      const duration = artifact.timings?.durationMs ?? artifact.timings?.totalMs;

                      return (
                        <React.Fragment key={artifact.id}>
                          <tr className="border-t border-black">
                            <td className="p-2">{new Date(artifact.timestamp).toLocaleTimeString()}</td>
                            <td className="p-2 uppercase font-bold">{artifact.stage || 'unknown'}</td>
                            <td className="p-2">{artifact.type}</td>
                            <td className="p-2">{duration ? `${duration} ms` : '—'}</td>
                            <td className="p-2">{artifact.timings?.apiMs ?? '—'}</td>
                            <td className="p-2">{artifact.timings?.saveMs ?? '—'}</td>
                            <td className="p-2">{artifact.provider || '—'}</td>
                            <td className="p-2">{artifact.model}</td>
                            <td className="p-2" title={artifact.prompt}>{promptPreview}</td>
                            <td className="p-2">{tokens}</td>
                            <td className="p-2">{costValue !== undefined ? `${currency}${Number(costValue).toFixed(4)}` : '—'}</td>
                            <td className="p-2">{outputTag}</td>
                            <td className={`p-2 ${status === 'Failed' ? 'text-brand-red' : 'text-green-700'}`}>{status}</td>
                            <td className="p-2">
                              <button
                                onClick={() => setExpandedArtifactId(expandedArtifactId === artifact.id ? null : artifact.id)}
                                className="text-xs font-bold underline"
                              >
                                {expandedArtifactId === artifact.id ? 'Hide' : 'View'}
                              </button>
                            </td>
                          </tr>
                          {expandedArtifactId === artifact.id && (
                            <tr className="bg-slate-50 border-t border-black">
                              <td colSpan={14} className="p-3">
                                <pre className="text-[11px] whitespace-pre-wrap">{JSON.stringify(artifact, null, 2)}</pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
      {galleryOpen && (
        <MasterGalleryModal
          items={galleryModalItems}
          initialIndex={galleryIndex}
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </ModalPortal>
  );
};
