import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X, Download, ThumbsUp, ThumbsDown, Info, RefreshCw, Edit2, Trash2, Check, Globe, Lock, AlertTriangle } from 'lucide-react';
import JSZip from 'jszip';
import { Project, ProjectComment, AppStep, GenerationArtifact, ImageTag } from '../../types';
import { Button as DsButton, type ButtonProps as DsButtonProps, type ButtonVariant } from '../ds/Button';
import { ModalPortal } from './ModalPortal';
import { IconButton } from '../ds/IconButton';
import { Input, Textarea } from '../ds/Input';
import { Select } from '../ds/Select';
import { Switch } from '../ds/Switch';
import { cn } from '../../lib/utils';
import {
  CHIP,
  CHIP_VARIANT,
  DENSITY,
  DIALOG_TITLE,
  FOCUS_RING,
  OVERLAY,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  SCRIM,
  SECTION_ICON_TILE,
  SECTION_TITLE,
  STATUS_INK,
  STATUS_SURFACE,
  TONE_TEXT,
  Z
} from '../chat/studioDesign';
import { useUsageAllowance } from '../usage/useUsageAllowance';
import { compactUsageShare, costContextFromAllowance, formatCostForUser } from '../../services/costDisplay';
import { aiUsageForExport, artifactsForExport, costSummaryForExport, projectForExport } from '../steps/comicCostDisplay';
import { exportProject, loadArtifactsForProject } from '../../services/db';
import { parseRatio } from '../../services/imageUtils';
import { estimateTokensFromTextInput } from '../../services/reporting';
import { assignImageTags, collectStateImageEntries } from '../../services/imageTags';
import { MasterGalleryModal, MasterGalleryItem } from './MasterGalleryModal';
import { downloadBlob } from '../../services/download';
import { isStudioV4Project } from '../../services/studioDeepLink';
import { isLegacyPdfReady, legacyPdfErrorMessage, loadJsPdf } from '../../services/legacyPdfLoader';

interface ProjectInfoModalProps {
  project: Project;
  onClose: () => void;
  onUpdateProject: (projectId: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
}

const STEP_LABELS: Record<number, string> = {
  [AppStep.SCRIPT_INPUT]: 'Script',
  [AppStep.STORY_PLANNING]: 'Style',
  [AppStep.STYLE_SELECTION]: 'Style',
  [AppStep.REFERENCE_BUILDER]: 'World',
  [AppStep.COVER]: 'Cover',
  [AppStep.LAYOUT_SELECTION]: 'Layout',
  [AppStep.COMBINED_PREVIEW]: 'Layout',
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
  if (typeof dataUrl !== 'string') throw new Error('Invalid image payload.');
  const [meta, base64] = dataUrl.split(',');
  if (!meta || !base64) throw new Error('Invalid image data URL.');
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
    if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
      reject(new Error('Image source missing.'));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image.'));
    img.src = dataUrl;
  });

/**
 * The export row's buttons on the DS Button, keeping the old call shape (size "sm", variant primary /
 * secondary / outline, an `icon`): PF-1 (S2a) rewrites the "Update Sizes" line beside them, so those lines
 * stay byte-identical until the S2b integration, which can inline this. One ink primary (Download PDF), the
 * other files outlined, the size refresh quiet.
 */
const LEGACY_VARIANT: Record<'primary' | 'secondary' | 'outline', ButtonVariant> = { primary: 'default', secondary: 'outline', outline: 'ghost' };
interface ExportButtonProps extends Omit<DsButtonProps, 'variant' | 'size'> {
  variant?: keyof typeof LEGACY_VARIANT;
  size?: 'sm';
  icon?: React.ReactNode;
}
const Button: React.FC<ExportButtonProps> = ({ variant = 'primary', size: _size, icon, children, ...rest }) => (
  <DsButton {...rest} size="sm" variant={LEGACY_VARIANT[variant]}>
    {icon ? (
      <span aria-hidden="true" className="contents">
        {icon}
      </span>
    ) : null}
    {children}
  </DsButton>
);

/** A block inside the dialog: a card on the overlay. */
const BLOCK = `min-w-0 ${RADIUS_PANEL} border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface)] p-4`;
/** A quiet text action (Show Advanced, View): 44 px tall under a coarse pointer. */
const TEXT_ACTION = `inline-flex items-center ${RADIUS_CONTROL} text-xs font-medium text-[var(--ds-ink)] underline underline-offset-2 hover:no-underline ${DENSITY.coarse} ${FOCUS_RING}`;
/** A vote that is on reads as pressed: the active tint, never a hue alone. */
const VOTE = 'aria-pressed:bg-[var(--ds-active)] aria-pressed:text-[var(--ds-ink)]';

/** One labelled figure (a stat, a size, a cost). `boxed` sets it in its own tile. */
const Fact: React.FC<{ label: string; boxed?: boolean; children: React.ReactNode }> = ({ label, boxed, children }) => (
  <div className={cn('min-w-0', boxed && cn('border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-2 py-1.5', RADIUS_CONTROL))}>
    <dt className="text-[var(--ds-muted)]">{label}</dt>
    <dd className="m-0 font-mono font-medium tabular-nums text-[var(--ds-ink)] [overflow-wrap:anywhere]">{children}</dd>
  </div>
);

export const ProjectInfoModal: React.FC<ProjectInfoModalProps> = ({ project, onClose, onUpdateProject }) => {
  const [overview, setOverview] = useState(project.state.overview || '');
  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentText, setCommentText] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const localUserId = useMemo(() => getLocalUserId(), []);
  const [commentVotes, setCommentVotes] = useState<Record<string, VoteState>>({});
  const [isPublic, setIsPublic] = useState(!!project.isPublic);
  // Comic Studio (v4) comics are published only from the studio Share sheet (server-side;
  // the database refuses client is_public changes on them), so no toggle here.
  const isStudioComic = isStudioV4Project(project);
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
  /** The project snapshot (`id:updatedAt`) the automatic size refresh last ran for: once per snapshot. */
  const autoRefreshedFor = useRef<string | null>(null);
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
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  // Governed users never see dollars (P1-LIMITS): the usage status decides how cost reads here and in the ZIP
  // (read on mount and focus by the shared store, never polled).
  const allowance = useUsageAllowance();
  const costCtx = useMemo(() => costContextFromAllowance(allowance), [allowance]);
  /** A cost for this reader: dollars for admins and own-key use, a share of their usage for everyone governed. */
  const costText = (value: unknown, currency?: string): string => {
    const amount = Number(value);
    const usd = Number.isFinite(amount) ? amount : 0;
    return costCtx.governed ? formatCostForUser(usd, costCtx) : `${currency || '$'}${usd.toFixed(4)}`;
  };
  /** The same in a narrow spot (a list row, a table cell): "≈2%", or a dash while a governed share is unknown. */
  const costCell = (value: unknown, currency?: string): string => {
    if (!costCtx.governed) return costText(value, currency);
    return compactUsageShare(costText(value)) ?? '—';
  };

  // A centred modal dialog: focus moves in when it opens and back when it closes; Escape closes it (the
  // gallery, while open on top, takes Escape itself).
  const titleId = `project-info-${useId().replace(/:/g, '')}`;
  const closeRef = useRef<HTMLButtonElement>(null);
  const galleryOpenRef = useRef(galleryOpen);
  galleryOpenRef.current = galleryOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || galleryOpenRef.current) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, []);

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
          setExportNotice(null);
        }
      } catch (e) {
        console.warn('Failed to load export payload for ProjectInfoModal.', e);
        if (active) setExportNotice('Some export data could not be loaded. Downloads may be limited.');
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
        console.warn('Failed to load generation artifacts for ProjectInfoModal.', e);
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
    const jsPDF = await loadJsPdf();
    const ratioValue = parseRatio(project.state.customAspectRatioEnabled && project.state.customAspectRatio
      ? project.state.customAspectRatio
      : project.state.styleAspectRatio) || 1;
    const orientation = ratioValue < 1 ? 'p' : 'l';
    const pdf = new jsPDF(orientation, 'mm', 'a4');

    const images: string[] = [];
    const cover = getCoverImageUrl(dataOverride);
    if (cover) images.push(cover);
    images.push(...getPanelImageUrls(dataOverride));

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    let renderedImageCount = 0;

    for (let i = 0; i < images.length; i += 1) {
      const dataUrl = images[i];
      if (!dataUrl) continue;
      try {
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
        if (renderedImageCount > 0) pdf.addPage();
        pdf.addImage(dataUrl, format, x, y, targetWidth, targetHeight);
        renderedImageCount += 1;
      } catch (error) {
        console.warn('Skipping image during PDF build; failed to load source.', { index: i, source: dataUrl, error });
      }
    }

    if (renderedImageCount === 0) throw new Error('No renderable images found for PDF export.');

    return pdf.output('blob');
  };

  const buildProjectZip = async (dataOverride?: Awaited<ReturnType<typeof exportProject>> | null) => {
    const data = dataOverride || exportData;
    if (!data?.project) throw new Error('Project data missing');

    const zip = new JSZip();
    const safeName = project.name.replace(/[^a-zA-Z0-9-_]+/g, '_');

    zip.file('project.json', JSON.stringify(projectForExport(data.project, costCtx), null, 2));

    const imagesFolder = zip.folder('images');
    const imageFileMap: Record<string, string> = {};
    if (imagesFolder) {
      Object.entries(data.images).forEach(([id, dataUrl]) => {
        try {
          if (typeof dataUrl !== 'string' || !dataUrl.trim()) return;
          const { mimeType, base64 } = parseDataUrl(dataUrl);
          const ext = getExtensionFromMime(mimeType);
          const filename = `${id}.${ext}`;
          imageFileMap[id] = filename;
          imagesFolder.file(filename, base64, { base64: true });
        } catch (error) {
          console.warn('Skipping invalid image during ZIP export.', { id, error });
        }
      });
    }

    const artifactsFolder = zip.folder('artifacts');
    if (artifactsFolder) {
      artifactsFolder.file('artifacts.json', JSON.stringify(artifactsForExport(data.artifacts, costCtx), null, 2));
    }

    const reportFolder = zip.folder('report');
    if (reportFolder && data.report) {
      reportFolder.file('ai_usage.json', JSON.stringify(aiUsageForExport(data.report.ai_usage, costCtx), null, 2));
      reportFolder.file('cost_summary.json', JSON.stringify(costSummaryForExport(data.report.cost_summary, costCtx), null, 2));
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
      setExportNotice(null);
      setIsBuildingPdf(true);
      const data = await ensureExportData();
      const blob = await buildPdfBlob(data);
      setPdfSize(blob.size);
      setSizeUpdatedAt(Date.now());
      setSizeSourceUpdatedAt(project.updatedAt);
      setSizeStatus('latest');
      downloadBlob(blob, `${project.name.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'comic'}_comic.pdf`);
    } catch (e) {
      console.warn('PDF export failed in ProjectInfoModal.', e);
      setExportNotice(legacyPdfErrorMessage(e));
    } finally {
      setIsBuildingPdf(false);
    }
  };

  const handleDownloadHtml = async () => {
    try {
      setExportNotice(null);
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
      downloadBlob(blob, `${project.name.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'comic'}.html`);
    } catch (e) {
      console.warn('HTML export failed in ProjectInfoModal.', e);
      setExportNotice('HTML export failed. Please retry.');
    }
  };

  const handleDownloadZip = async () => {
    try {
      setExportNotice(null);
      setIsBuildingZip(true);
      const data = await ensureExportData();
      const { blob, filename } = await buildProjectZip(data);
      setZipSize(blob.size);
      setSizeUpdatedAt(Date.now());
      setSizeSourceUpdatedAt(project.updatedAt);
      setSizeStatus('latest');
      downloadBlob(blob, filename);
    } catch (e) {
      console.warn('ZIP export failed in ProjectInfoModal.', e);
      setExportNotice('ZIP export failed. Some image sources may be invalid.');
    } finally {
      setIsBuildingZip(false);
    }
  };

  const handleRefreshSizes = async (options: { auto?: boolean } = {}) => {
    // The automatic refresh never fetches the PDF tools: it sizes the PDF only once an export loaded them.
    const sizePdf = !options.auto || isLegacyPdfReady('jspdf');
    try {
      setExportNotice(null);
      setIsBuildingPdf(sizePdf);
      setIsBuildingZip(true);
      setSizeStatus('updating');
      const data = await ensureExportData();
      const [pdfBlob, zipResult] = await Promise.all([sizePdf ? buildPdfBlob(data) : Promise.resolve(null), buildProjectZip(data)]);
      if (pdfBlob) setPdfSize(pdfBlob.size);
      setZipSize(zipResult.blob.size);
      setSizeUpdatedAt(Date.now());
      setSizeSourceUpdatedAt(project.updatedAt);
      setSizeStatus('latest');
    } catch (e) {
      console.warn('Failed to refresh export sizes.', e);
      setExportNotice('Unable to refresh file sizes right now.');
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

  // One automatic size refresh per project snapshot, 1.2 s after the sizes go stale. The snapshot is
  // marked only when the timer fires: marking it in state before the timer re-rendered the effect, whose
  // cleanup cancelled the timer, so the refresh never ran. It sizes the ZIP; the PDF only once an export
  // loaded the PDF tools (D6, PF-1 #2).
  useEffect(() => {
    const snapshot = `${project.id}:${project.updatedAt}`;
    if (sizeStatus !== 'stale' || autoRefreshedFor.current === snapshot) return;
    const handle = setTimeout(() => {
      autoRefreshedFor.current = snapshot;
      void handleRefreshSizes({ auto: true });
    }, 1200);
    return () => clearTimeout(handle);
  }, [sizeStatus, project.id, project.updatedAt]);

  return (
    <ModalPortal>
      <div className={cn('fixed inset-0 flex items-center justify-center p-3 sm:p-4', Z.scrim, SCRIM)} onClick={onClose} data-testid="project-info">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={cn('relative max-h-[90dvh] w-full min-w-0 max-w-5xl overflow-y-auto p-4 sm:p-6', OVERLAY)}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-6 flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span aria-hidden className={SECTION_ICON_TILE}>
                <Info className="size-4" />
              </span>
              <div className="min-w-0">
                <p className={OVERLINE}>Project info</p>
                <h2 id={titleId} className={cn(DIALOG_TITLE, 'truncate')}>{project.name}</h2>
              </div>
            </div>
            <IconButton ref={closeRef} label="Close project info" onClick={onClose} className="shrink-0 text-[var(--ds-muted)]">
              <X />
            </IconButton>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="min-w-0 space-y-6">
              <section aria-labelledby={`${titleId}-overview`} className={BLOCK}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 id={`${titleId}-overview`} className={OVERLINE}>Overview</h3>
                  {isStudioComic ? (
                  <span
                    className={cn(CHIP, CHIP_VARIANT.outline, 'gap-1.5 px-3 py-1 text-xs')}
                    title="Comic Studio comics are published from the studio's Share sheet."
                    data-testid="studio-publish-hint"
                  >
                    {isPublic ? <Globe size={14} aria-hidden /> : <Lock size={14} aria-hidden />}
                    {isPublic ? 'Public' : 'Private'} · Publish from the studio
                  </span>
                  ) : (
                  // A setting, not a status: a switch with one constant name ("Public in the Library") whose state is
                  // aria-checked and the track (never a name that flips between Public and Private).
                  <label
                    className={cn('inline-flex min-w-0 cursor-pointer items-center gap-2 text-xs font-medium text-[var(--ds-ink)]', DENSITY.coarse)}
                    title={isPublic ? "Visible in the Library" : "Only visible to you"}
                  >
                    <Switch
                      checked={isPublic}
                      onCheckedChange={(next) => {
                        setIsPublic(next);
                        onUpdateProject(project.id, (prev) => {
                          const existingPublishedAt = prev.publishedAt ?? prev.state.publishedAt;
                          const publishedAt = next ? (existingPublishedAt ?? Date.now()) : existingPublishedAt;
                          return {
                            isPublic: next,
                            publishedAt,
                            state: {
                              ...prev.state,
                              publishedAt
                            }
                          };
                        });
                      }}
                    />
                    <span className="min-w-0">Public in the Library</span>
                  </label>
                  )}
                </div>
                <Textarea
                  value={overview}
                  onChange={(e) => setOverview(e.target.value)}
                  aria-label="Overview"
                  placeholder="Write a quick overview for this comic..."
                  className="mt-2 min-h-[120px]"
                />
                <div className="mt-3 flex justify-end">
                  <DsButton size="sm" variant="outline" onClick={handleSaveOverview}>Save Overview</DsButton>
                </div>
              </section>

              <section aria-labelledby={`${titleId}-stats`} className={BLOCK}>
                <h3 id={`${titleId}-stats`} className={OVERLINE}>Project Stats</h3>
                <dl className="m-0 mt-3 grid grid-cols-2 gap-3 text-sm">
                  <Fact label="Step">{STEP_LABELS[project.state.step] || 'Unknown'}</Fact>
                  <Fact label="Scenes">{project.state.scenes.length}</Fact>
                  <Fact label="Panels">{project.state.panels.length}</Fact>
                  <Fact label="Updated">{new Date(project.updatedAt).toLocaleString()}</Fact>
                  <Fact label="Layout">{project.state.layoutType}</Fact>
                  <Fact label="Text">{project.state.textLayout || 'caption'}</Fact>
                </dl>
              </section>

              <section aria-labelledby={`${titleId}-cost`} className={BLOCK} data-testid="project-cost">
                <h3 id={`${titleId}-cost`} className={OVERLINE}>{costCtx.governed ? 'Usage' : 'Cost & Usage'}</h3>
                {isLoadingExport ? (
                  <p className="mt-3 text-sm text-[var(--ds-muted)]">Loading report…</p>
                ) : (
                  <div className="mt-3 space-y-3 text-sm">
                    <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Fact label={costCtx.governed ? 'This comic' : 'Total Cost'}>{costSummary.totalCost !== undefined ? costText(costSummary.totalCost, costSummary.currency) : 'n/a'}</Fact>
                      {imageCost !== undefined && <Fact label={costCtx.governed ? 'Images' : 'Image Cost'}>{costText(imageCost, costSummary.currency)}</Fact>}
                      {textCost !== undefined && <Fact label={costCtx.governed ? 'Writing' : 'Text Cost'}>{costText(textCost, costSummary.currency)}</Fact>}
                      <Fact label="Artifacts">{usageSummary.totalArtifacts ?? 'n/a'}</Fact>
                      <Fact label="Tokens">{usageSummary.totalTokens ?? 'n/a'}</Fact>
                      <Fact label="Estimated Items">{costSummary.estimatedArtifactCount ?? 0}</Fact>
                    </dl>
                    <button
                      type="button"
                      aria-expanded={advancedCostOpen}
                      onClick={() => setAdvancedCostOpen((prev) => !prev)}
                      className={TEXT_ACTION}
                    >
                      {advancedCostOpen ? 'Hide Advanced' : 'Show Advanced'}
                    </button>
                    {advancedCostOpen && (
                      <div className="space-y-4">
                        <div>
                          <h4 className={cn(OVERLINE, 'mb-2')}>{costCtx.governed ? 'Per-Artifact Usage' : 'Per-Artifact Costs'}</h4>
                          <div className={cn('max-h-48 overflow-y-auto border border-[var(--ds-hairline)]', RADIUS_CONTROL)}>
                            {reportArtifacts.length === 0 && (
                              <p className="m-0 p-2 text-xs text-[var(--ds-muted)]">{costCtx.governed ? 'No artifact usage available.' : 'No artifact costs available.'}</p>
                            )}
                            {reportArtifacts.slice(0, 50).map((artifact: any) => {
                              const tag = artifact.outputImageId ? project.state.imageTags?.[artifact.outputImageId]?.tag : undefined;
                              return (
                                <div key={artifact.id} className="flex min-w-0 items-center justify-between gap-2 border-b border-[var(--ds-hairline-soft)] px-2 py-1.5 text-[11px] last:border-b-0">
                                  <div className="min-w-0">
                                    <div className="font-medium uppercase [overflow-wrap:anywhere]">{artifact.stage || 'unknown'} · {artifact.type}</div>
                                    <div className="text-[var(--ds-muted)] [overflow-wrap:anywhere]">{artifact.model}</div>
                                    {tag && <div className="text-[var(--ds-muted)]">{tag}</div>}
                                  </div>
                                  <div className="shrink-0 text-right font-mono tabular-nums">
                                    <div>{artifact.totalTokens ?? 'n/a'} tok</div>
                                    <div>{artifact.cost?.value !== undefined ? costCell(artifact.cost?.value, artifact.cost?.currency || costSummary.currency) : 'n/a'}</div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div>
                          <h4 className={cn(OVERLINE, 'mb-2')}>{costCtx.governed ? 'Repeated Sources' : 'Multiple Cost Occurrences'}</h4>
                          {multipleCostGroups.length === 0 && (
                            <p className="m-0 text-xs text-[var(--ds-muted)]">No repeated cost sources detected.</p>
                          )}
                          {multipleCostGroups.map((group) => (
                            <div key={group.id} className={cn('mb-2 flex min-w-0 items-center justify-between gap-2 border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-2 py-1 text-[11px] font-medium', RADIUS_CONTROL)}>
                              <div className="min-w-0 [overflow-wrap:anywhere]">{group.label}</div>
                              <div className="shrink-0 font-mono tabular-nums">{group.count}x · {costCell(group.cost, costSummary.currency)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>

            <div className="min-w-0 space-y-6">
              <section aria-labelledby={`${titleId}-files`} className={BLOCK}>
                <h3 id={`${titleId}-files`} className={OVERLINE}>Storage & Files</h3>
                {exportNotice && (
                  <p role="status" className={cn('m-0 mt-3 flex items-start gap-2 border px-3 py-2 text-xs font-medium', RADIUS_CONTROL, STATUS_SURFACE.attention)}>
                    <AlertTriangle aria-hidden className={cn('mt-px size-3.5 shrink-0', STATUS_INK.attention)} />
                    <span className="min-w-0">{exportNotice}</span>
                  </p>
                )}
                {isLoadingExport ? (
                  <p className="mt-3 text-sm text-[var(--ds-muted)]">Loading storage…</p>
                ) : (
                  <dl className="m-0 mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                    <Fact label="Images">{storageSummary.imageCount ?? 0}</Fact>
                    <Fact label="Image Bytes">{formatBytes(storageSummary.imageBytes)}</Fact>
                    <Fact label="Project ZIP Size">{zipSize ? formatBytes(zipSize) : 'n/a'}</Fact>
                    <Fact label="PDF Size">{pdfSize ? formatBytes(pdfSize) : 'n/a'}</Fact>
                    <Fact label="Last Updated">{sizeUpdatedAt ? new Date(sizeUpdatedAt).toLocaleString() : 'n/a'}</Fact>
                    <Fact label="Status">{sizeStatus === 'latest' ? 'Latest' : sizeStatus === 'updating' ? 'Updating' : 'Stale'}</Fact>
                  </dl>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={handleDownloadPdf} icon={<Download className="w-4 h-4" />} disabled={!hasExport || isBuildingPdf}>Download PDF</Button>
                  <Button size="sm" variant="secondary" onClick={handleDownloadHtml} icon={<Download className="w-4 h-4" />} disabled={!hasExport}>Download HTML</Button>
                  <Button size="sm" variant="secondary" onClick={handleDownloadZip} icon={<Download className="w-4 h-4" />} disabled={!hasExport || isBuildingZip}>Download ZIP</Button>
                  <Button size="sm" variant="outline" onClick={() => void handleRefreshSizes()} icon={<RefreshCw className="w-4 h-4" />} disabled={!hasExport}>Update Sizes</Button>
                  {sizeStatus === 'latest' && (
                    <span className="self-center text-xs font-medium text-[var(--ds-muted)]">Latest</span>
                  )}
                </div>
              </section>

              <section aria-labelledby={`${titleId}-reviews`} className={BLOCK}>
                <h3 id={`${titleId}-reviews`} className={OVERLINE}>User Reviews</h3>
                <div className="mt-3 space-y-3">
                  {comments.length === 0 && (
                    <p className="m-0 text-sm text-[var(--ds-muted)]">No reviews yet. Be the first!</p>
                  )}
                  {comments.map((comment) => {
                    const canEdit = !comment.authorId || comment.authorId === localUserId;
                    const isEditing = editingCommentId === comment.id;
                    const isLiked = commentVotes[comment.id] === 'like';
                    const isDisliked = commentVotes[comment.id] === 'dislike';
                    const hasEdit = !!comment.updatedAt && comment.updatedAt !== comment.createdAt;
                    const timestamp = new Date(comment.updatedAt || comment.createdAt).toLocaleString();

                    return (
                      <article key={comment.id} className={cn('border border-[var(--ds-hairline-soft)] bg-[var(--ds-raised)] p-3', RADIUS_CONTROL)}>
                        <div className="flex min-w-0 items-start justify-between gap-2 text-xs text-[var(--ds-muted)]">
                          <div className="min-w-0 font-medium text-[var(--ds-ink)] [overflow-wrap:anywhere]">{comment.author || 'Anonymous'}</div>
                          <div className="shrink-0 text-right">
                            <div>{timestamp}</div>
                            {hasEdit && <div className="text-[11px]">Edited</div>}
                          </div>
                        </div>
                        {isEditing ? (
                          <div className="mt-2 space-y-2">
                            <Textarea
                              value={editingCommentText}
                              onChange={(e) => setEditingCommentText(e.target.value)}
                              aria-label="Edit your review"
                            />
                            <div className="flex flex-wrap gap-2">
                              <DsButton size="sm" onClick={handleSaveEdit}>
                                <Check aria-hidden /> Save
                              </DsButton>
                              <DsButton
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingCommentId(null);
                                  setEditingCommentText('');
                                }}
                              >
                                Cancel
                              </DsButton>
                            </div>
                          </div>
                        ) : (
                          <p className="m-0 mt-2 text-sm text-[var(--ds-ink)] [overflow-wrap:anywhere]">{comment.text}</p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-1">
                          <DsButton
                            size="sm"
                            variant="ghost"
                            aria-pressed={isLiked}
                            aria-label={`Like (${comment.likes ?? 0})`}
                            onClick={() => handleVote(comment.id, 'like')}
                            className={VOTE}
                          >
                            <ThumbsUp aria-hidden /> <span className="tabular-nums">{comment.likes}</span>
                          </DsButton>
                          <DsButton
                            size="sm"
                            variant="ghost"
                            aria-pressed={isDisliked}
                            aria-label={`Dislike (${comment.dislikes ?? 0})`}
                            onClick={() => handleVote(comment.id, 'dislike')}
                            className={VOTE}
                          >
                            <ThumbsDown aria-hidden /> <span className="tabular-nums">{comment.dislikes}</span>
                          </DsButton>
                          {canEdit && !isEditing && (
                            <>
                              <DsButton size="sm" variant="ghost" onClick={() => handleStartEdit(comment)}>
                                <Edit2 aria-hidden /> Edit
                              </DsButton>
                              <DsButton size="sm" variant="ghost" onClick={() => handleDeleteComment(comment.id)} className={TONE_TEXT.danger}>
                                <Trash2 aria-hidden /> Delete
                              </DsButton>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className="mt-4 space-y-2 border-t border-[var(--ds-hairline-soft)] pt-4">
                  <Input
                    value={commentAuthor}
                    onChange={(e) => setCommentAuthor(e.target.value)}
                    aria-label="Your name (optional)"
                    placeholder="Your name (optional)"
                  />
                  <Textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    aria-label="Your review"
                    placeholder="Write a quick review..."
                    className="min-h-[80px]"
                  />
                  <div className="flex justify-end">
                    <DsButton size="sm" variant="outline" onClick={handleAddComment}>Post Review</DsButton>
                  </div>
                </div>
              </section>
            </div>
          </div>
          <div className="mt-6 space-y-6">
            <section aria-labelledby={`${titleId}-gallery`} className={BLOCK}>
              <div className="mb-3 flex min-w-0 flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className={OVERLINE}>Images</p>
                  <h3 id={`${titleId}-gallery`} className={SECTION_TITLE}>Mastery Gallery</h3>
                </div>
                <span className={cn(CHIP, CHIP_VARIANT.outline, 'tabular-nums')}>{filteredGallery.length} images</span>
              </div>
              <div className="mb-3 flex min-w-0 flex-col gap-2 md:flex-row">
                <Input
                  value={gallerySearch}
                  onChange={(e) => setGallerySearch(e.target.value)}
                  aria-label="Search the images"
                  placeholder="Search tags, labels, usage..."
                  className="flex-1"
                />
                <Select
                  value={galleryFilter}
                  onChange={(e) => setGalleryFilter(e.target.value)}
                  aria-label="Category"
                  wrapperClassName="md:w-48"
                >
                  <option value="all">All Categories</option>
                  {galleryCategories.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </Select>
                <Select
                  value={gallerySort}
                  onChange={(e) => setGallerySort(e.target.value as typeof gallerySort)}
                  aria-label="Sort"
                  wrapperClassName="md:w-40"
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="tag">Tag</option>
                  <option value="category">Category</option>
                </Select>
              </div>
              {filteredGallery.length === 0 ? (
                <p className="m-0 text-sm text-[var(--ds-muted)]">No images match your filters yet.</p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-3 lg:grid-cols-4">
                  {filteredGallery.map((item, idx) => (
                    <li key={item.imageId} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => openGalleryModal(filteredGallery, idx)}
                        className={cn('w-full min-w-0 border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-2 text-left hover:bg-[var(--ds-hover)] motion-safe:transition-colors', RADIUS_CONTROL, FOCUS_RING)}
                      >
                        <img src={item.url} alt={item.tag || item.label || 'gallery'} className={cn('h-32 w-full object-cover', RADIUS_CONTROL)} />
                        <span className="mt-2 block truncate text-[11px] font-medium">{item.tag || item.category || 'UNTAGGED'}</span>
                        <span className="block truncate text-[11px] text-[var(--ds-muted)]">{item.usedIn?.[0] || item.label || item.category}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby={`${titleId}-log`} className={BLOCK}>
              <div className="mb-3 flex min-w-0 flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className={OVERLINE}>Generation Log</p>
                  <h3 id={`${titleId}-log`} className={SECTION_TITLE}>Production Runs</h3>
                </div>
                <span className={cn(CHIP, CHIP_VARIANT.outline, 'tabular-nums')}>{isLoadingArtifacts ? 'Loading…' : `${artifacts.length} events`}</span>
              </div>

              <dl className="m-0 mb-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                <Fact label="Events" boxed>{artifactSummary.total}</Fact>
                <Fact label="Success" boxed>{Math.round(artifactSummary.successRate * 100)}%</Fact>
                <Fact label="Errors" boxed>{artifactSummary.errors}</Fact>
                <Fact label="Tokens" boxed>{artifactSummary.tokens}</Fact>
              </dl>

              <div className="mb-4">
                <h4 className={cn(OVERLINE, 'mb-2')}>Recent Errors</h4>
                {artifactSummary.recentErrors.length === 0 && (
                  <p className="m-0 text-xs text-[var(--ds-muted)]">No recent errors.</p>
                )}
                {artifactSummary.recentErrors.map((artifact) => (
                  <div key={artifact.id} className={cn('mb-2 border px-2 py-1.5 text-[11px]', RADIUS_CONTROL, STATUS_SURFACE.error)}>
                    <div className={cn('font-medium uppercase', STATUS_INK.error)}>{artifact.stage || artifact.type}</div>
                    <div className="[overflow-wrap:anywhere]">{artifact.error || 'Unknown error'}</div>
                  </div>
                ))}
              </div>

              <div className={cn('overflow-x-auto border border-[var(--ds-hairline)]', RADIUS_CONTROL)}>
                <table className="w-full text-[11px]">
                  <thead className="bg-[var(--ds-well)] text-[var(--ds-muted)]">
                    <tr>
                      <th className="p-2 text-left font-medium">Time</th>
                      <th className="p-2 text-left font-medium">Stage</th>
                      <th className="p-2 text-left font-medium">Type</th>
                      <th className="p-2 text-left font-medium">Duration</th>
                      <th className="p-2 text-left font-medium">API</th>
                      <th className="p-2 text-left font-medium">Save</th>
                      <th className="p-2 text-left font-medium">Provider</th>
                      <th className="p-2 text-left font-medium">Model</th>
                      <th className="p-2 text-left font-medium">Prompt</th>
                      <th className="p-2 text-left font-medium">Tokens</th>
                      <th className="p-2 text-left font-medium">{costCtx.governed ? 'Usage' : 'Cost'}</th>
                      <th className="p-2 text-left font-medium">Output</th>
                      <th className="p-2 text-left font-medium">Status</th>
                      <th className="p-2 text-left font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {artifacts.length === 0 && (
                      <tr>
                        <td className="p-3 text-center text-[var(--ds-muted)]" colSpan={14}>
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
                          <tr className="border-t border-[var(--ds-hairline-soft)]">
                            <td className="p-2 tabular-nums">{new Date(artifact.timestamp).toLocaleTimeString()}</td>
                            <td className="p-2 font-medium uppercase">{artifact.stage || 'unknown'}</td>
                            <td className="p-2">{artifact.type}</td>
                            <td className="p-2 tabular-nums">{duration ? `${duration} ms` : '—'}</td>
                            <td className="p-2 tabular-nums">{artifact.timings?.apiMs ?? '—'}</td>
                            <td className="p-2 tabular-nums">{artifact.timings?.saveMs ?? '—'}</td>
                            <td className="p-2">{artifact.provider || '—'}</td>
                            <td className="p-2">{artifact.model}</td>
                            <td className="p-2" title={artifact.prompt}>{promptPreview}</td>
                            <td className="p-2 tabular-nums">{tokens}</td>
                            <td className="p-2 tabular-nums">{costValue !== undefined ? costCell(costValue, currency) : '—'}</td>
                            <td className="p-2">{outputTag}</td>
                            <td className={cn('p-2 font-medium', status === 'Failed' ? TONE_TEXT.danger : TONE_TEXT.success)}>{status}</td>
                            <td className="p-2">
                              <button
                                type="button"
                                aria-expanded={expandedArtifactId === artifact.id}
                                onClick={() => setExpandedArtifactId(expandedArtifactId === artifact.id ? null : artifact.id)}
                                className={TEXT_ACTION}
                              >
                                {expandedArtifactId === artifact.id ? 'Hide' : 'View'}
                              </button>
                            </td>
                          </tr>
                          {expandedArtifactId === artifact.id && (
                            <tr className="border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)]">
                              <td colSpan={14} className="p-3">
                                <pre className="whitespace-pre-wrap text-[11px] [overflow-wrap:anywhere]" data-testid="artifact-json">{JSON.stringify((artifactsForExport([artifact], costCtx) as unknown[])[0], null, 2)}</pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
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
