import { AppStep, Project } from "../types";
import { buildProjectReport } from "./reporting";
import { loadArtifactsForProject } from "./db";

const collectImageIds = (project: Project) => {
  const ids = new Set<string>();
  const add = (id?: string) => {
    if (id) ids.add(id);
  };
  project.state.panels.forEach((panel) => {
    add(panel.imageId);
    panel.imageIdHistory?.forEach(add);
  });
  project.state.styleVariants.forEach((variant) => add(variant.imageId));
  project.state.characters.forEach((c) => {
    add(c.imageId);
    c.referenceImageIds?.forEach(add);
  });
  project.state.items.forEach((i) => {
    add(i.imageId);
    i.referenceImageIds?.forEach(add);
  });
  project.state.locations.forEach((l) => {
    add(l.imageId);
    l.referenceImageIds?.forEach(add);
  });
  add(project.state.coverImageId);
  add(project.state.coverTemplateImageId);
  return ids;
};

export type ProjectSummary = {
  id: string;
  name: string;
  step: number;
  stepLabel?: string;
  updatedAt: number;
  scenes: number;
  panels: number;
  isGenerating: boolean;
  generationProgress?: number;
  generationStep?: string;
  cost?: { currency: string; totalCost: number; estimatedArtifacts?: number };
  artifacts: number;
  layoutType?: string;
  textLayout?: string;
  styleCategory?: string;
  styleAspectRatio?: string;
  imageResolution?: string;
  coverReady?: boolean;
  overview?: string;
  scriptLength?: number;
  lastUpdatedAt?: number;
  storage?: {
    imageCount?: number;
    imageBytes?: number;
    panelsCount?: number;
    artifactsCount?: number;
    indexedDb?: Record<string, unknown>;
  };
  comments: { count: number; likes: number; dislikes: number };
};

export const summarizeProject = async (project: Project): Promise<ProjectSummary> => {
  const artifacts = await loadArtifactsForProject(project.id);
  const report = await buildProjectReport(project, artifacts, {}, project.state.pricingConfig);
  const comments = project.state.comments || [];
  const likes = comments.reduce((acc, c) => acc + (c.likes || 0), 0);
  const dislikes = comments.reduce((acc, c) => acc + (c.dislikes || 0), 0);
  const imageIds = collectImageIds(project);

  return {
    id: project.id,
    name: project.name,
    step: project.state.step,
    stepLabel: AppStep[project.state.step],
    updatedAt: project.updatedAt,
    scenes: project.state.scenes.length,
    panels: project.state.panels.length,
    isGenerating: !!project.state.generationStatus?.isActive,
    generationProgress: project.state.generationStatus?.progress,
    generationStep: project.state.generationStatus?.currentStepDescription,
    cost: {
      currency: report.cost_summary.currency,
      totalCost: report.cost_summary.totalCost,
      estimatedArtifacts: report.cost_summary.estimatedArtifactCount
    },
    artifacts: report.ai_usage.totalArtifacts,
    layoutType: project.state.layoutType,
    textLayout: project.state.textLayout,
    styleCategory: project.state.styleCategory,
    styleAspectRatio: project.state.styleAspectRatio,
    imageResolution: project.state.imageResolution,
    coverReady: !!project.state.coverImageId,
    overview: project.state.overview || "",
    scriptLength: project.state.script.length,
    lastUpdatedAt: project.updatedAt,
    storage: {
      imageCount: report.storage.imageCount || imageIds.size,
      imageBytes: report.storage.imageBytes || undefined,
      panelsCount: report.storage.panelsCount,
      artifactsCount: report.storage.artifactsCount,
      indexedDb: report.storage.indexedDb
    },
    comments: { count: comments.length, likes, dislikes }
  };
};

export const summarizeAllProjects = async (projects: Project[]): Promise<ProjectSummary[]> => {
  const summaries: ProjectSummary[] = [];
  for (const project of projects) {
    try {
      summaries.push(await summarizeProject(project));
    } catch {
      summaries.push({
        id: project.id,
        name: project.name,
        step: project.state.step,
        stepLabel: AppStep[project.state.step],
        updatedAt: project.updatedAt,
        scenes: project.state.scenes.length,
        panels: project.state.panels.length,
        isGenerating: !!project.state.generationStatus?.isActive,
        generationProgress: project.state.generationStatus?.progress,
        generationStep: project.state.generationStatus?.currentStepDescription,
        artifacts: 0,
        layoutType: project.state.layoutType,
        textLayout: project.state.textLayout,
        styleCategory: project.state.styleCategory,
        styleAspectRatio: project.state.styleAspectRatio,
        imageResolution: project.state.imageResolution,
        coverReady: !!project.state.coverImageId,
        overview: project.state.overview || "",
        scriptLength: project.state.script.length,
        lastUpdatedAt: project.updatedAt,
        comments: { count: project.state.comments?.length || 0, likes: 0, dislikes: 0 }
      });
    }
  }
  return summaries;
};

export const buildProjectSnapshot = (project: Project) => {
  const sampleScenes = project.state.scenes.slice(0, 5).map((scene) => ({
    id: scene.id,
    synopsis: scene.synopsis?.slice(0, 240),
    setting: scene.setting,
    characters: scene.characters
  }));
  const samplePanels = project.state.panels.slice(0, 6).map((panel) => ({
    id: panel.id,
    sceneId: panel.sceneId,
    description: panel.description?.slice(0, 200),
    dialogue: panel.dialogue?.slice(0, 160),
    hasImage: !!panel.imageId || !!panel.imageUrl
  }));
  const sampleCharacters = project.state.characters.slice(0, 6).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description?.slice(0, 160)
  }));
  const sampleItems = project.state.items.slice(0, 6).map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description?.slice(0, 140)
  }));
  const sampleLocations = project.state.locations.slice(0, 6).map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description?.slice(0, 140)
  }));
  const comments = project.state.comments || [];
  const recentComments = comments.slice(-5).map((comment) => ({
    id: comment.id,
    author: comment.author,
    text: comment.text?.slice(0, 160),
    likes: comment.likes,
    dislikes: comment.dislikes,
    createdAt: comment.createdAt
  }));

  return {
    id: project.id,
    name: project.name,
    step: project.state.step,
    stepLabel: AppStep[project.state.step],
    updatedAt: project.updatedAt,
    overview: project.state.overview || "",
    scriptChecklist: project.state.scriptChecklist,
    scriptLength: project.state.script.length,
    scriptPreview: project.state.script.slice(0, 600),
    style: {
      category: project.state.styleCategory,
      prompt: project.state.stylePrompt?.slice(0, 240),
      aspectRatio: project.state.styleAspectRatio,
      customAspectRatio: project.state.customAspectRatioEnabled ? project.state.customAspectRatio : undefined,
      resolution: project.state.imageResolution
    },
    layout: {
      type: project.state.layoutType,
      customLayoutPrompt: project.state.customLayoutPrompt?.slice(0, 200),
      textLayout: project.state.textLayout || "caption"
    },
    cover: {
      ready: !!project.state.coverImageId || !!project.state.coverImageUrl,
      templateId: project.state.coverTemplateId,
      prompt: project.state.coverPrompt?.slice(0, 200)
    },
    generationStatus: project.state.generationStatus,
    counts: {
      scenes: project.state.scenes.length,
      panels: project.state.panels.length,
      characters: project.state.characters.length,
      items: project.state.items.length,
      locations: project.state.locations.length,
      styleVariants: project.state.styleVariants.length
    },
    samples: {
      scenes: sampleScenes,
      panels: samplePanels,
      characters: sampleCharacters,
      items: sampleItems,
      locations: sampleLocations
    },
    comments: {
      count: comments.length,
      recent: recentComments
    }
  };
};
