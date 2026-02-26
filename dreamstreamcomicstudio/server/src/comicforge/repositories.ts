import crypto from 'node:crypto';
import {
  ComicForgeAssetCard,
  ComicForgeJobSummary,
  ComicForgeStage,
  ComicForgeState,
  createDefaultComicForgeState
} from '../../../types.js';
import { getSupabaseAdmin } from '../services/supabase.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMissingTableError = (error: unknown): boolean => {
  const code = String((error as { code?: string })?.code || '').toUpperCase();
  return code === '42P01' || code === 'PGRST205';
};

const toNotFoundError = (message: string) => {
  const error = new Error(message) as Error & { status?: number; publicCode?: string };
  error.status = 404;
  error.publicCode = 'NOT_FOUND';
  return error;
};

const toForbiddenError = (message: string) => {
  const error = new Error(message) as Error & { status?: number; publicCode?: string };
  error.status = 403;
  error.publicCode = 'FORBIDDEN';
  return error;
};

type ProjectRow = {
  id: string;
  user_id: string;
  state: Record<string, unknown>;
};

type GenerationJobRow = {
  id: string;
  project_id: string;
  task_type: string;
  status: string;
  cost?: number;
  completed_at?: string | null;
  error_message?: string | null;
  output_payload?: Record<string, unknown> | null;
};

const inMemoryAssetCards = new Map<string, ComicForgeAssetCard[]>();
const inMemoryAssetCardProjectIndex = new Map<string, string>();
const inMemoryJobs = new Map<string, ComicForgeJobSummary & { projectId: string; estimatedCostUsd: number; taskType: string }>();
const inMemoryJobEvents = new Map<string, Array<{
  id: string;
  type: 'queued' | 'running' | 'progress' | 'done' | 'failed';
  message: string;
  timestamp: number;
  progress?: number;
  payload?: Record<string, unknown>;
}>>();

export const getProjectOwnedByUser = async (projectId: string, userId: string): Promise<ProjectRow> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('projects')
    .select('id, user_id, state')
    .eq('id', projectId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw toNotFoundError('Project not found.');
  if (data.user_id !== userId) throw toForbiddenError('Project access denied.');

  const state = isRecord(data.state) ? data.state : {};
  return {
    id: data.id,
    user_id: data.user_id,
    state
  };
};

export const readComicForgeState = async (projectId: string, userId: string): Promise<ComicForgeState> => {
  const project = await getProjectOwnedByUser(projectId, userId);
  const comicforge = isRecord(project.state.comicforge)
    ? (project.state.comicforge as ComicForgeState)
    : createDefaultComicForgeState();

  return {
    ...comicforge,
    stage: comicforge.stage || ComicForgeStage.FORMAT_SETUP,
    maxStageReached: comicforge.maxStageReached || ComicForgeStage.FORMAT_SETUP,
    approvals: Array.isArray(comicforge.approvals) ? comicforge.approvals : createDefaultComicForgeState().approvals,
    updatedAt: comicforge.updatedAt || Date.now()
  };
};

export const writeComicForgeState = async (projectId: string, userId: string, nextState: ComicForgeState): Promise<void> => {
  const project = await getProjectOwnedByUser(projectId, userId);
  const admin = getSupabaseAdmin();
  const nextProjectState = {
    ...project.state,
    pipelineMode: 'comicforge',
    comicforge: {
      ...nextState,
      updatedAt: Date.now()
    }
  };

  const { error } = await admin
    .from('projects')
    .update({
      state: nextProjectState,
      updated_at: new Date().toISOString()
    })
    .eq('id', projectId)
    .eq('user_id', userId);

  if (error) throw error;
};

const upsertAssetCardsInMemory = (projectId: string, cards: ComicForgeAssetCard[]) => {
  inMemoryAssetCards.set(projectId, cards);
  cards.forEach((card) => inMemoryAssetCardProjectIndex.set(card.id, projectId));
};

const readAssetCardsInMemory = (projectId: string): ComicForgeAssetCard[] => {
  return inMemoryAssetCards.get(projectId) || [];
};

export const listAssetCards = async (projectId: string): Promise<ComicForgeAssetCard[]> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('asset_cards')
    .select('id, project_id, card_type, name, canonical_description, do_not_change, negative_constraints, allowed_variants, reference_images, consistency_method, hash')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    if (isMissingTableError(error)) {
      return readAssetCardsInMemory(projectId);
    }
    throw error;
  }

  const cards: ComicForgeAssetCard[] = (data || []).map((row) => ({
    id: String((row as Record<string, unknown>).id),
    cardType: String((row as Record<string, unknown>).card_type || 'character') as ComicForgeAssetCard['cardType'],
    name: String((row as Record<string, unknown>).name || ''),
    canonicalDescription: String((row as Record<string, unknown>).canonical_description || ''),
    doNotChange: Array.isArray((row as Record<string, unknown>).do_not_change) ? (row as Record<string, unknown>).do_not_change as string[] : [],
    negativeConstraints: Array.isArray((row as Record<string, unknown>).negative_constraints) ? (row as Record<string, unknown>).negative_constraints as string[] : [],
    allowedVariants: Array.isArray((row as Record<string, unknown>).allowed_variants) ? (row as Record<string, unknown>).allowed_variants as string[] : [],
    referenceImages: Array.isArray((row as Record<string, unknown>).reference_images) ? (row as Record<string, unknown>).reference_images as ComicForgeAssetCard['referenceImages'] : [],
    consistencyMethod: String((row as Record<string, unknown>).consistency_method || 'reference_injection') as ComicForgeAssetCard['consistencyMethod'],
    hash: typeof (row as Record<string, unknown>).hash === 'string' ? String((row as Record<string, unknown>).hash) : undefined,
    status: 'draft'
  }));

  upsertAssetCardsInMemory(projectId, cards);
  return cards;
};

export const createAssetCard = async (projectId: string, card: ComicForgeAssetCard): Promise<ComicForgeAssetCard> => {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('asset_cards')
    .insert({
      id: card.id,
      project_id: projectId,
      card_type: card.cardType,
      name: card.name,
      canonical_description: card.canonicalDescription,
      do_not_change: card.doNotChange,
      negative_constraints: card.negativeConstraints,
      allowed_variants: card.allowedVariants,
      reference_images: card.referenceImages,
      consistency_method: card.consistencyMethod,
      hash: card.hash
    });

  if (error && !isMissingTableError(error)) {
    throw error;
  }

  const nextCards = [...readAssetCardsInMemory(projectId), card];
  upsertAssetCardsInMemory(projectId, nextCards);
  return card;
};

export const updateAssetCard = async (assetCardId: string, patch: Partial<ComicForgeAssetCard>): Promise<ComicForgeAssetCard> => {
  let projectId = inMemoryAssetCardProjectIndex.get(assetCardId);
  let cards = projectId ? readAssetCardsInMemory(projectId) : [];
  let existing = cards.find((card) => card.id === assetCardId);

  if (!existing) {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('asset_cards')
      .select('id, project_id, card_type, name, canonical_description, do_not_change, negative_constraints, allowed_variants, reference_images, consistency_method, hash')
      .eq('id', assetCardId)
      .maybeSingle();

    if (error) {
      if (isMissingTableError(error)) {
        throw toNotFoundError('Asset card not found.');
      }
      throw error;
    }

    if (!data) {
      throw toNotFoundError('Asset card not found.');
    }

    projectId = String((data as Record<string, unknown>).project_id || '');
    existing = {
      id: String((data as Record<string, unknown>).id),
      cardType: String((data as Record<string, unknown>).card_type || 'character') as ComicForgeAssetCard['cardType'],
      name: String((data as Record<string, unknown>).name || ''),
      canonicalDescription: String((data as Record<string, unknown>).canonical_description || ''),
      doNotChange: Array.isArray((data as Record<string, unknown>).do_not_change) ? (data as Record<string, unknown>).do_not_change as string[] : [],
      negativeConstraints: Array.isArray((data as Record<string, unknown>).negative_constraints) ? (data as Record<string, unknown>).negative_constraints as string[] : [],
      allowedVariants: Array.isArray((data as Record<string, unknown>).allowed_variants) ? (data as Record<string, unknown>).allowed_variants as string[] : [],
      referenceImages: Array.isArray((data as Record<string, unknown>).reference_images) ? (data as Record<string, unknown>).reference_images as ComicForgeAssetCard['referenceImages'] : [],
      consistencyMethod: String((data as Record<string, unknown>).consistency_method || 'reference_injection') as ComicForgeAssetCard['consistencyMethod'],
      hash: typeof (data as Record<string, unknown>).hash === 'string' ? String((data as Record<string, unknown>).hash) : undefined,
      status: 'draft'
    };
    cards = readAssetCardsInMemory(projectId);
  }

  if (!projectId) {
    throw toNotFoundError('Asset card not found.');
  }

  const nextCard: ComicForgeAssetCard = {
    ...existing,
    ...patch,
    id: existing.id
  };

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('asset_cards')
    .update({
      card_type: nextCard.cardType,
      name: nextCard.name,
      canonical_description: nextCard.canonicalDescription,
      do_not_change: nextCard.doNotChange,
      negative_constraints: nextCard.negativeConstraints,
      allowed_variants: nextCard.allowedVariants,
      reference_images: nextCard.referenceImages,
      consistency_method: nextCard.consistencyMethod,
      hash: nextCard.hash,
      updated_at: new Date().toISOString()
    })
    .eq('id', assetCardId);

  if (error && !isMissingTableError(error)) {
    throw error;
  }

  upsertAssetCardsInMemory(
    projectId,
    cards.map((card) => (card.id === assetCardId ? nextCard : card))
  );

  return nextCard;
};

export const createGenerationJob = async (input: {
  projectId: string;
  taskType: string;
  modelUsed: string;
  estimatedCostUsd: number;
  inputPayload?: Record<string, unknown>;
  entityId?: string;
  entityType?: string;
}): Promise<ComicForgeJobSummary> => {
  const id = crypto.randomUUID();
  const now = Date.now();
  const summary: ComicForgeJobSummary = {
    id,
    taskType: input.taskType,
    status: 'queued',
    progress: 0,
    createdAt: now
  };

  const rowPayload = {
    id,
    project_id: input.projectId,
    entity_id: input.entityId || null,
    entity_type: input.entityType || null,
    task_type: input.taskType,
    model_used: input.modelUsed,
    status: 'queued',
    cost: input.estimatedCostUsd,
    input_payload: input.inputPayload || {},
    output_payload: {},
    error_message: null,
    created_at: new Date(now).toISOString()
  };

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('generation_jobs')
    .insert(rowPayload);

  if (error && !isMissingTableError(error)) {
    throw error;
  }

  inMemoryJobs.set(id, {
    ...summary,
    projectId: input.projectId,
    estimatedCostUsd: input.estimatedCostUsd,
    taskType: input.taskType
  });

  appendJobEvent(id, {
    type: 'queued',
    message: 'Job queued',
    timestamp: now,
    progress: 0
  });

  return summary;
};

export const updateGenerationJob = async (jobId: string, patch: Partial<ComicForgeJobSummary> & {
  outputPayload?: Record<string, unknown>;
  errorMessage?: string;
}): Promise<ComicForgeJobSummary> => {
  const existing = inMemoryJobs.get(jobId);
  if (!existing) throw toNotFoundError('Job not found.');

  const next: ComicForgeJobSummary & { projectId: string; estimatedCostUsd: number; taskType: string } = {
    ...existing,
    ...patch,
    id: existing.id,
    taskType: existing.taskType,
    status: (patch.status || existing.status) as ComicForgeJobSummary['status']
  };

  inMemoryJobs.set(jobId, next);

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('generation_jobs')
    .update({
      status: next.status,
      output_payload: patch.outputPayload || existing.result || {},
      error_message: patch.errorMessage || null,
      completed_at: next.status === 'done' || next.status === 'failed' ? new Date().toISOString() : null
    })
    .eq('id', jobId);

  if (error && !isMissingTableError(error)) {
    throw error;
  }

  appendJobEvent(jobId, {
    type: next.status === 'done' ? 'done' : next.status === 'failed' ? 'failed' : next.status === 'running' ? 'running' : 'progress',
    message: next.status,
    progress: next.progress,
    timestamp: Date.now(),
    payload: patch.outputPayload
  });

  return {
    id: next.id,
    taskType: next.taskType,
    status: next.status,
    progress: next.progress,
    createdAt: next.createdAt,
    completedAt: next.completedAt,
    errorMessage: next.errorMessage,
    result: next.result
  };
};

export const getGenerationJob = async (jobId: string): Promise<ComicForgeJobSummary | null> => {
  const inMemory = inMemoryJobs.get(jobId);
  if (inMemory) {
    return {
      id: inMemory.id,
      taskType: inMemory.taskType,
      status: inMemory.status,
      progress: inMemory.progress,
      createdAt: inMemory.createdAt,
      completedAt: inMemory.completedAt,
      errorMessage: inMemory.errorMessage,
      result: inMemory.result
    };
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('generation_jobs')
    .select('id, project_id, task_type, status, cost, completed_at, error_message, output_payload')
    .eq('id', jobId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }

  if (!data) return null;
  const row = data as GenerationJobRow;
  return {
    id: row.id,
    taskType: row.task_type,
    status: (row.status === 'done' || row.status === 'failed' || row.status === 'running' ? row.status : 'queued') as ComicForgeJobSummary['status'],
    createdAt: Date.now(),
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
    errorMessage: row.error_message || undefined,
    result: row.output_payload || undefined
  };
};

export const appendJobEvent = (jobId: string, event: {
  type: 'queued' | 'running' | 'progress' | 'done' | 'failed';
  message: string;
  timestamp: number;
  progress?: number;
  payload?: Record<string, unknown>;
}) => {
  const current = inMemoryJobEvents.get(jobId) || [];
  current.push({
    id: crypto.randomUUID(),
    ...event
  });
  inMemoryJobEvents.set(jobId, current);
};

export const listJobEvents = (jobId: string) => inMemoryJobEvents.get(jobId) || [];

export const getProjectCostTracker = async (projectId: string) => {
  const inMemory = Array.from(inMemoryJobs.values()).filter((job) => job.projectId === projectId);
  const byTaskType = inMemory.reduce<Record<string, number>>((acc, job) => {
    acc[job.taskType] = Number(((acc[job.taskType] || 0) + job.estimatedCostUsd).toFixed(6));
    return acc;
  }, {});

  const estimatedUsd = Number(inMemory.reduce((sum, job) => sum + job.estimatedCostUsd, 0).toFixed(6));

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('generation_jobs')
    .select('task_type, cost')
    .eq('project_id', projectId);

  if (error && !isMissingTableError(error)) {
    throw error;
  }

  const persistedRows = (data || []) as Array<{ task_type?: string; cost?: number }>;
  const persistedByTaskType = persistedRows.reduce<Record<string, number>>((acc, row) => {
    const key = row.task_type || 'unknown';
    const value = Number(row.cost || 0);
    acc[key] = Number(((acc[key] || 0) + value).toFixed(6));
    return acc;
  }, {});

  const mergedByTaskType = { ...byTaskType };
  for (const [taskType, value] of Object.entries(persistedByTaskType)) {
    mergedByTaskType[taskType] = Number(((mergedByTaskType[taskType] || 0) + value).toFixed(6));
  }

  const actualUsd = Number(Object.values(mergedByTaskType).reduce((sum, value) => sum + value, 0).toFixed(6));

  return {
    currency: 'USD',
    estimatedUsd,
    actualUsd,
    byTaskType: mergedByTaskType
  };
};
