import { Router } from 'express';
import { comicForgePipelineService } from '../comicforge/pipelineService.js';
import type { ComicForgeExportPreset } from '../../../types.js';

export const comicForgeRouter = Router();

const requireUserId = (req: { user?: { id?: string } }) => {
  const userId = req.user?.id;
  if (!userId) {
    const error = new Error('Authentication required.') as Error & { status?: number; publicCode?: string };
    error.status = 401;
    error.publicCode = 'UNAUTHORIZED';
    throw error;
  }
  return userId;
};

const sendOk = (res: { json: (payload: unknown) => void }, stage: string, data: Record<string, unknown>) => {
  res.json({
    ok: true,
    stage,
    data
  });
};

const COMICFORGE_EXPORT_PRESETS = new Set<ComicForgeExportPreset>([
  'webtoon_episode',
  'tapas_episode',
  'print_a4_300dpi',
  'print_us_letter_300dpi',
  'digital_pdf',
  'social_cover_crop',
  'character_card_export'
]);

comicForgeRouter.post('/projects/:projectId/format-lock', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.formatLock({
      userId,
      projectId: req.params.projectId
    }, req.body || {});
    sendOk(res, result.stage, { formatSpec: result.formatSpec });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/analyze-script', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const rawScriptText = typeof req.body?.rawScriptText === 'string' ? req.body.rawScriptText.trim() : '';
    if (!rawScriptText) {
      return res.status(400).json({ error: { code: 'RAW_SCRIPT_REQUIRED', message: 'rawScriptText is required.' } });
    }
    const result = await comicForgePipelineService.analyzeScript({ userId, projectId: req.params.projectId }, { rawScriptText });
    sendOk(res, result.stage, {
      analysis: result.analysis,
      unresolvedFlags: result.unresolvedFlags,
      assetCards: result.assetCards
    });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/resolve-ambiguity', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const flagId = typeof req.body?.flagId === 'string' ? req.body.flagId.trim() : '';
    const resolution = typeof req.body?.resolution === 'string' ? req.body.resolution.trim() : '';
    if (!flagId || !resolution) {
      return res.status(400).json({ error: { code: 'INVALID_RESOLUTION', message: 'flagId and resolution are required.' } });
    }
    const result = await comicForgePipelineService.resolveAmbiguity(
      { userId, projectId: req.params.projectId },
      { flagId, resolution }
    );
    sendOk(res, result.stage, {
      analysis: result.analysis,
      unresolvedFlags: result.unresolvedFlags
    });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/build-architecture', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const pacingPreference = req.body?.pacingPreference;
    if (pacingPreference !== 'fast_action' && pacingPreference !== 'balanced' && pacingPreference !== 'slow_emotional') {
      return res.status(400).json({ error: { code: 'INVALID_PACING_PREFERENCE', message: 'pacingPreference is required.' } });
    }
    const result = await comicForgePipelineService.buildArchitecture(
      { userId, projectId: req.params.projectId },
      {
        pacingPreference,
        targetPageCountOverride: typeof req.body?.targetPageCountOverride === 'number' ? req.body.targetPageCountOverride : undefined
      }
    );
    sendOk(res, result.stage, { architecture: result.architecture });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/suggest-styles', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.suggestStyles(
      { userId, projectId: req.params.projectId },
      {
        customStyleHint: typeof req.body?.customStyleHint === 'string' ? req.body.customStyleHint : undefined
      }
    );
    sendOk(res, result.stage, { recommendations: result.recommendations });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/build-style-bible', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const selectedStyle = typeof req.body?.selectedStyle === 'string' ? req.body.selectedStyle.trim() : '';
    if (!selectedStyle) {
      return res.status(400).json({ error: { code: 'SELECTED_STYLE_REQUIRED', message: 'selectedStyle is required.' } });
    }
    const result = await comicForgePipelineService.buildStyleBible(
      { userId, projectId: req.params.projectId },
      {
        selectedStyle,
        customPromptOverride: typeof req.body?.customPromptOverride === 'string' ? req.body.customPromptOverride : undefined
      }
    );
    sendOk(res, result.stage, { styleBible: result.styleBible });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.get('/projects/:projectId/asset-cards', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.listAssetCards({ userId, projectId: req.params.projectId });
    sendOk(res, result.stage, { cards: result.cards });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/asset-cards', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const cardType = req.body?.cardType;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const canonicalDescription = typeof req.body?.canonicalDescription === 'string' ? req.body.canonicalDescription.trim() : '';
    if (!cardType || !name || !canonicalDescription) {
      return res.status(400).json({ error: { code: 'INVALID_ASSET_CARD', message: 'cardType, name, canonicalDescription are required.' } });
    }
    const result = await comicForgePipelineService.createAssetCard(
      { userId, projectId: req.params.projectId },
      {
        cardType,
        name,
        canonicalDescription,
        doNotChange: Array.isArray(req.body?.doNotChange) ? req.body.doNotChange : [],
        negativeConstraints: Array.isArray(req.body?.negativeConstraints) ? req.body.negativeConstraints : [],
        allowedVariants: Array.isArray(req.body?.allowedVariants) ? req.body.allowedVariants : []
      }
    );
    sendOk(res, result.stage, { card: result.card });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.patch('/asset-cards/:assetCardId', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.patchAssetCard(
      { userId, projectId: 'unused' },
      req.params.assetCardId,
      req.body || {}
    );
    sendOk(res, result.stage, { card: result.card });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/asset-cards/:assetCardId/generate-refs', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.generateAssetRefs(
      { userId, projectId: 'unused' },
      req.params.assetCardId,
      {
        angles: Array.isArray(req.body?.angles) ? req.body.angles : undefined
      }
    );
    sendOk(res, result.stage, { card: result.card });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/extract-layout', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.extractLayout(
      { userId, projectId: req.params.projectId },
      {
        referenceImageUrl: typeof req.body?.referenceImageUrl === 'string' ? req.body.referenceImageUrl : undefined,
        layoutHint: typeof req.body?.layoutHint === 'string' ? req.body.layoutHint : undefined
      }
    );
    sendOk(res, result.stage, { layoutTemplate: result.layoutTemplate });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/build-lettering-rules', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.buildLetteringRules(
      { userId, projectId: req.params.projectId },
      req.body || {}
    );
    sendOk(res, result.stage, { letteringRules: result.letteringRules });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/pages/:pageId/balloon-zones', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.generateBalloonZones(
      { userId, projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : '' },
      req.params.pageId
    );
    sendOk(res, result.stage, { balloonZones: result.balloonZones });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/generate-thumbnails', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.generateThumbnails({ userId, projectId: req.params.projectId });
    sendOk(res, result.stage, { job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/validate-storyboard', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.validateStoryboard({ userId, projectId: req.params.projectId });
    sendOk(res, result.stage, { validation: result.validation });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.get('/projects/:projectId/preview-pack', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.previewPack({ userId, projectId: req.params.projectId });
    sendOk(res, result.stage, { preview: result.preview });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/generate', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const quality = req.body?.quality;
    if (quality !== 'draft' && quality !== 'final') {
      return res.status(400).json({ error: { code: 'INVALID_QUALITY', message: 'quality must be draft or final.' } });
    }
    const result = await comicForgePipelineService.generate({ userId, projectId: req.params.projectId }, { quality });
    sendOk(res, result.stage, { job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/panels/:panelId/regenerate', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
    const quality = req.body?.quality;
    if (!projectId || (quality !== 'draft' && quality !== 'final')) {
      return res.status(400).json({ error: { code: 'INVALID_REGENERATE_REQUEST', message: 'projectId and valid quality are required.' } });
    }
    const result = await comicForgePipelineService.regeneratePanel(
      { userId, projectId },
      req.params.panelId,
      {
        quality,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined
      }
    );
    sendOk(res, result.stage, { job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/pages/:pageId/assemble', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
    if (!projectId) {
      return res.status(400).json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'projectId is required.' } });
    }
    const result = await comicForgePipelineService.assemblePage({ userId, projectId }, req.params.pageId);
    sendOk(res, result.stage, { job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/pages/:pageId/render-lettering', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
    if (!projectId) {
      return res.status(400).json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'projectId is required.' } });
    }
    const result = await comicForgePipelineService.renderLettering({ userId, projectId }, req.params.pageId);
    sendOk(res, result.stage, { job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/pages/:pageId/run-qc', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
    if (!projectId) {
      return res.status(400).json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'projectId is required.' } });
    }
    const result = await comicForgePipelineService.runQc({ userId, projectId }, req.params.pageId);
    sendOk(res, result.stage, { report: result.report, job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.patch('/panel-lettering/:panelLetteringId', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
    if (!projectId) {
      return res.status(400).json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'projectId is required.' } });
    }
    const result = await comicForgePipelineService.patchPanelLettering(
      { userId, projectId },
      req.params.panelLetteringId,
      { elements: Array.isArray(req.body?.elements) ? req.body.elements : [] }
    );
    sendOk(res, result.stage, { letteringId: result.letteringId, elements: result.elements });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.post('/projects/:projectId/export', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const preset = req.body?.preset;
    if (typeof preset !== 'string' || !COMICFORGE_EXPORT_PRESETS.has(preset as ComicForgeExportPreset)) {
      return res.status(400).json({ error: { code: 'PRESET_REQUIRED', message: 'preset is required.' } });
    }
    const result = await comicForgePipelineService.exportProject(
      { userId, projectId: req.params.projectId },
      {
        preset: preset as ComicForgeExportPreset,
        pageRange: req.body?.pageRange,
        upscaleIfNeeded: Boolean(req.body?.upscaleIfNeeded)
      }
    );
    sendOk(res, result.stage, { job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.get('/jobs/:jobId/status', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = typeof req.query?.projectId === 'string' ? req.query.projectId : '';
    const result = await comicForgePipelineService.getJobStatus({ userId, projectId }, req.params.jobId);
    sendOk(res, result.stage, { job: result.job });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.get('/jobs/:jobId/events', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const projectId = typeof req.query?.projectId === 'string' ? req.query.projectId : '';

    if (req.query?.stream === '1') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let closed = false;
      req.on('close', () => {
        closed = true;
      });

      const started = Date.now();
      while (!closed && Date.now() - started < 55_000) {
        const result = await comicForgePipelineService.getJobEvents({ userId, projectId }, req.params.jobId);
        res.write(`data: ${JSON.stringify({ ok: true, stage: result.stage, data: { events: result.events } })}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      if (!closed) {
        res.write('event: done\\ndata: {}\\n\\n');
      }
      res.end();
      return;
    }

    const result = await comicForgePipelineService.getJobEvents({ userId, projectId }, req.params.jobId);
    sendOk(res, result.stage, { events: result.events });
  } catch (error) {
    next(error);
  }
});

comicForgeRouter.get('/projects/:projectId/cost-tracker', async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const result = await comicForgePipelineService.getCostTracker({ userId, projectId: req.params.projectId });
    sendOk(res, result.stage, { cost: result.cost });
  } catch (error) {
    next(error);
  }
});
