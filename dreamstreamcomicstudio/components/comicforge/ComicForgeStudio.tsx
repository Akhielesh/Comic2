import React, { useEffect, useMemo, useState } from 'react';
import {
  COMICFORGE_STAGE_ORDER,
  ComicForgeAssetCard,
  ComicForgeStage,
  ComicForgeState,
  Project,
  createDefaultComicForgeState
} from '../../types';
import { Button } from '../Button';
import { useComicForgeStore } from '../../services/comicforge/store';
import { buildComicForgeProjectPatch, isComicForgeProject } from '../../services/comicforge/stateSync';
import { comicForgeApi } from '../../services/comicforge/api';
import { FormatSetupScreen } from './FormatSetupScreen';
import { ScriptEditorScreen } from './ScriptEditorScreen';
import { StoryArchitectureScreen } from './StoryArchitectureScreen';
import { StyleSelectionScreen } from './StyleSelectionScreen';
import { AssetLibraryScreen } from './AssetLibraryScreen';
import { LayoutSystemScreen } from './LayoutSystemScreen';
import { StoryboardScreen } from './StoryboardScreen';
import { PreviewPackScreen } from './PreviewPackScreen';
import { GenerationScreen } from './GenerationScreen';
import { QCReviewScreen } from './QCReviewScreen';
import { ExportScreen } from './ExportScreen';

interface ComicForgeStudioProps {
  projects: Project[];
  activeProject?: Project;
  onCreateProject: (name: string) => Project;
  onOpenProject: (id: string) => void;
  onUpdateProject: (id: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  onBack: () => void;
}

const labelByStage: Record<ComicForgeStage, string> = {
  [ComicForgeStage.FORMAT_SETUP]: 'Format',
  [ComicForgeStage.SCRIPT_ANALYSIS]: 'Script',
  [ComicForgeStage.STORY_ARCHITECTURE]: 'Architecture',
  [ComicForgeStage.STYLE_SELECTION]: 'Style',
  [ComicForgeStage.ASSET_LIBRARY]: 'Assets',
  [ComicForgeStage.LAYOUT_SYSTEM]: 'Layout',
  [ComicForgeStage.STORYBOARD]: 'Storyboard',
  [ComicForgeStage.PREVIEW_PACK]: 'Preview',
  [ComicForgeStage.GENERATION]: 'Generate',
  [ComicForgeStage.QC_REVIEW]: 'QC',
  [ComicForgeStage.EXPORT]: 'Export'
};

const getApproval = (state: ComicForgeState, stage: ComicForgeStage) =>
  state.approvals.find((entry) => entry.stage === stage)?.approved || false;

const firstPageId = 'page-1';

export const ComicForgeStudio: React.FC<ComicForgeStudioProps> = ({
  projects,
  activeProject,
  onCreateProject,
  onOpenProject,
  onUpdateProject,
  onBack
}) => {
  const [newProjectName, setNewProjectName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const forgeProjects = useMemo(
    () => projects.filter((project) => project.state.pipelineMode === 'comicforge'),
    [projects]
  );

  const {
    state,
    setState,
    setStage,
    approveStage,
    isStageUnlocked,
    lastJob,
    setLastJob,
    initializeFromProject
  } = useComicForgeStore();

  const activeForgeProject = activeProject && isComicForgeProject(activeProject) ? activeProject : undefined;

  useEffect(() => {
    if (!activeForgeProject) return;
    initializeFromProject(activeForgeProject);
  }, [activeForgeProject?.id]);

  const persistState = (project: Project, nextState: ComicForgeState) => {
    onUpdateProject(project.id, buildComicForgeProjectPatch(project, nextState));
  };

  const applyState = (updater: (prev: ComicForgeState) => ComicForgeState) => {
    const prev = useComicForgeStore.getState().state;
    const next = updater(prev);
    setState(next);
    if (activeForgeProject) {
      persistState(activeForgeProject, next);
    }
  };

  const approveAndPersist = (stage: ComicForgeStage) => {
    approveStage(stage);
    const next = useComicForgeStore.getState().state;
    if (activeForgeProject) {
      persistState(activeForgeProject, next);
    }
  };

  const setStageAndPersist = (stage: ComicForgeStage) => {
    if (!isStageUnlocked(stage)) return;
    setStage(stage);
    const next = useComicForgeStore.getState().state;
    if (activeForgeProject) {
      persistState(activeForgeProject, next);
    }
  };

  const handleCreateComicForgeProject = () => {
    const name = newProjectName.trim() || 'ComicForge Project';
    const created = onCreateProject(name);
    onUpdateProject(created.id, {
      state: {
        ...created.state,
        pipelineMode: 'comicforge',
        comicforge: createDefaultComicForgeState()
      }
    });
    onOpenProject(created.id);
    setNewProjectName('');
  };

  if (!activeForgeProject) {
    return (
      <div className="max-w-6xl mx-auto p-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-display">ComicForge Studio</h1>
            <p className="font-comic text-slate-600">Isolated experimental PRD flow.</p>
          </div>
          <Button variant="secondary" onClick={onBack}>Back to Dashboard</Button>
        </div>

        <div className="border-4 border-black rounded-xl bg-white p-6 space-y-4">
          <h2 className="text-2xl font-display">Create ComicForge Project</h2>
          <div className="flex gap-3 flex-wrap">
            <input
              className="flex-1 min-w-[280px] border-2 border-black rounded-lg px-3 py-2"
              placeholder="Project title"
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
            />
            <Button onClick={handleCreateComicForgeProject}>Create</Button>
          </div>
        </div>

        <div className="border-4 border-black rounded-xl bg-white p-6 space-y-4">
          <h2 className="text-2xl font-display">Existing ComicForge Projects</h2>
          {forgeProjects.length === 0 ? (
            <p className="text-sm text-slate-600">No ComicForge-mode projects yet.</p>
          ) : (
            <div className="grid md:grid-cols-2 gap-3">
              {forgeProjects.map((project) => (
                <button
                  key={project.id}
                  className="text-left border-2 border-black rounded-lg p-3 hover:bg-slate-50"
                  onClick={() => onOpenProject(project.id)}
                >
                  <div className="font-bold">{project.name}</div>
                  <div className="text-xs text-slate-600">Updated {new Date(project.updatedAt).toLocaleString()}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display">ComicForge Studio</h1>
          <p className="font-comic text-slate-600">Project: {activeForgeProject.name}</p>
        </div>
        <Button variant="secondary" onClick={onBack}>Dashboard</Button>
      </div>

      <div className="border-4 border-black rounded-xl bg-white p-4 overflow-x-auto">
        <div className="flex gap-2 min-w-max">
          {COMICFORGE_STAGE_ORDER.map((stage) => {
            const active = stage === state.stage;
            const approved = getApproval(state, stage);
            const unlocked = isStageUnlocked(stage);
            return (
              <button
                key={stage}
                onClick={() => setStageAndPersist(stage)}
                disabled={!unlocked}
                className={`px-3 py-2 border-2 rounded-lg text-xs font-bold uppercase ${active ? 'border-brand-blue bg-blue-50' : approved ? 'border-green-700 bg-green-50' : 'border-black bg-white'} ${!unlocked ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {labelByStage[stage]}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="border-2 border-red-700 bg-red-50 text-red-800 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <div className="border-4 border-black rounded-xl bg-white p-6">
        {state.stage === ComicForgeStage.FORMAT_SETUP && (
          <FormatSetupScreen
            formatSpec={state.formatSpec}
            approved={getApproval(state, ComicForgeStage.FORMAT_SETUP)}
            onSubmit={async (input) => {
              setError(null);
              try {
                const response = await comicForgeApi.formatLock(activeForgeProject.id, input);
                applyState((prev) => ({
                  ...prev,
                  stage: ComicForgeStage.FORMAT_SETUP,
                  formatSpec: response.data.formatSpec,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.FORMAT_SETUP)}
          />
        )}

        {state.stage === ComicForgeStage.SCRIPT_ANALYSIS && (
          <ScriptEditorScreen
            initialScript={state.scriptInput}
            analysis={state.analysis}
            approved={getApproval(state, ComicForgeStage.SCRIPT_ANALYSIS)}
            onAnalyze={async (rawScriptText) => {
              setError(null);
              try {
                const response = await comicForgeApi.analyzeScript(activeForgeProject.id, { rawScriptText });
                applyState((prev) => ({
                  ...prev,
                  scriptInput: rawScriptText,
                  analysis: response.data.analysis,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.SCRIPT_ANALYSIS)}
          />
        )}

        {state.stage === ComicForgeStage.STORY_ARCHITECTURE && (
          <StoryArchitectureScreen
            architecture={state.architecture}
            approved={getApproval(state, ComicForgeStage.STORY_ARCHITECTURE)}
            onBuild={async (input) => {
              setError(null);
              try {
                const response = await comicForgeApi.buildArchitecture(activeForgeProject.id, input);
                applyState((prev) => ({
                  ...prev,
                  architecture: response.data.architecture,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.STORY_ARCHITECTURE)}
          />
        )}

        {state.stage === ComicForgeStage.STYLE_SELECTION && (
          <StyleSelectionScreen
            recommendations={state.styleRecommendations}
            styleBible={state.styleBible}
            approved={getApproval(state, ComicForgeStage.STYLE_SELECTION)}
            onSuggest={async (input) => {
              setError(null);
              try {
                const response = await comicForgeApi.suggestStyles(activeForgeProject.id, input);
                applyState((prev) => ({
                  ...prev,
                  styleRecommendations: response.data.recommendations,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onBuildStyleBible={async (input) => {
              setError(null);
              try {
                const response = await comicForgeApi.buildStyleBible(activeForgeProject.id, input);
                applyState((prev) => ({
                  ...prev,
                  styleBible: response.data.styleBible,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.STYLE_SELECTION)}
          />
        )}

        {state.stage === ComicForgeStage.ASSET_LIBRARY && (
          <AssetLibraryScreen
            cards={state.assetCards || []}
            approved={getApproval(state, ComicForgeStage.ASSET_LIBRARY)}
            onRefresh={async () => {
              setError(null);
              try {
                const response = await comicForgeApi.listAssetCards(activeForgeProject.id);
                applyState((prev) => ({
                  ...prev,
                  assetCards: response.data.cards,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onCreateCard={async (input) => {
              setError(null);
              try {
                const response = await comicForgeApi.createAssetCard(activeForgeProject.id, input);
                applyState((prev) => ({
                  ...prev,
                  assetCards: [...(prev.assetCards || []), response.data.card as ComicForgeAssetCard],
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onGenerateRefs={async (assetCardId) => {
              setError(null);
              try {
                const response = await comicForgeApi.generateRefs(assetCardId, {});
                applyState((prev) => ({
                  ...prev,
                  assetCards: (prev.assetCards || []).map((card) => card.id === assetCardId ? response.data.card : card),
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.ASSET_LIBRARY)}
          />
        )}

        {state.stage === ComicForgeStage.LAYOUT_SYSTEM && (
          <LayoutSystemScreen
            layoutTemplate={state.layoutTemplate}
            approved={getApproval(state, ComicForgeStage.LAYOUT_SYSTEM)}
            onExtractLayout={async (input) => {
              setError(null);
              try {
                const response = await comicForgeApi.extractLayout(activeForgeProject.id, input);
                applyState((prev) => ({
                  ...prev,
                  layoutTemplate: response.data.layoutTemplate,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onBuildLetteringRules={async (input) => {
              setError(null);
              try {
                await comicForgeApi.buildLetteringRules(activeForgeProject.id, input);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.LAYOUT_SYSTEM)}
          />
        )}

        {state.stage === ComicForgeStage.STORYBOARD && (
          <StoryboardScreen
            latestJob={lastJob}
            validation={state.storyboardValidation}
            approved={getApproval(state, ComicForgeStage.STORYBOARD)}
            onGenerateThumbnails={async () => {
              setError(null);
              try {
                const response = await comicForgeApi.generateThumbnails(activeForgeProject.id, { quality: 'thumbnail' });
                setLastJob(response.data.job);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onValidateStoryboard={async () => {
              setError(null);
              try {
                const response = await comicForgeApi.validateStoryboard(activeForgeProject.id);
                applyState((prev) => ({
                  ...prev,
                  storyboardValidation: response.data.validation,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.STORYBOARD)}
          />
        )}

        {state.stage === ComicForgeStage.PREVIEW_PACK && (
          <PreviewPackScreen
            preview={state.previewPack}
            approved={getApproval(state, ComicForgeStage.PREVIEW_PACK)}
            onRefresh={async () => {
              setError(null);
              try {
                const response = await comicForgeApi.getPreviewPack(activeForgeProject.id);
                applyState((prev) => ({
                  ...prev,
                  previewPack: response.data.preview,
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.PREVIEW_PACK)}
          />
        )}

        {state.stage === ComicForgeStage.GENERATION && (
          <GenerationScreen
            latestJob={lastJob}
            approved={getApproval(state, ComicForgeStage.GENERATION)}
            onGenerate={async (quality) => {
              setError(null);
              try {
                const response = await comicForgeApi.generate(activeForgeProject.id, { quality });
                setLastJob(response.data.job);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.GENERATION)}
          />
        )}

        {state.stage === ComicForgeStage.QC_REVIEW && (
          <QCReviewScreen
            reports={state.qcReports || []}
            approved={getApproval(state, ComicForgeStage.QC_REVIEW)}
            onRunQc={async () => {
              setError(null);
              try {
                const response = await comicForgeApi.runQc(firstPageId, { pageId: firstPageId });
                applyState((prev) => ({
                  ...prev,
                  qcReports: [...(prev.qcReports || []), response.data.report],
                  updatedAt: Date.now()
                }));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={() => approveAndPersist(ComicForgeStage.QC_REVIEW)}
          />
        )}

        {state.stage === ComicForgeStage.EXPORT && (
          <ExportScreen
            latestJob={lastJob}
            onExport={async ({ preset, upscaleIfNeeded }) => {
              setError(null);
              try {
                const response = await comicForgeApi.exportProject(activeForgeProject.id, { preset, upscaleIfNeeded });
                setLastJob(response.data.job);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        )}
      </div>
    </div>
  );
};
