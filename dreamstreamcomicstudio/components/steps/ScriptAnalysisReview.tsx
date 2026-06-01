import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, RotateCcw, ArrowLeft } from 'lucide-react';
import { Scene } from '../../types';
import { AnalyzeScriptResponse } from '../../apiTypes';
import { Button } from '../Button';
import { segmentScriptForReview } from '../../services/scriptSegmentation';

type ScriptAnalysisReviewProps = {
  script?: string;
  scenes: Scene[];
  diagnostics?: AnalyzeScriptResponse['diagnostics'];
  onApprove: (scenes: Scene[]) => void;
  onReanalyze: () => void;
  onBackToScript: () => void;
};

type SceneValidation = {
  invalidCharacters: string[];
  sourceUnavailable: boolean;
};

const normalizeForMatch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsNormalizedName = (haystack: string, rawName: string) => {
  const target = normalizeForMatch(rawName);
  if (!target) return false;
  const source = normalizeForMatch(haystack);
  if (!source) return false;
  const pattern = new RegExp(`(^|\\s)${escapeRegex(target)}($|\\s)`);
  return pattern.test(source);
};

const containsNormalizedSnippet = (haystack: string, snippet: string) => {
  const target = normalizeForMatch(snippet);
  if (!target) return false;
  const source = normalizeForMatch(haystack);
  if (!source) return false;
  return source.includes(target);
};

const normalizeCharacters = (value: string[]) => {
  const unique = new Set<string>();
  for (const raw of value) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
};

const toCharacterInput = (characters: string[]) => (characters || []).join(', ');

// Guard against blank scene cards: only show scenes that carry some content.
const isRenderableScene = (scene: Scene) => Boolean(
  (scene.synopsis && scene.synopsis.trim())
  || (scene.setting && scene.setting.trim())
  || (scene.rawText && scene.rawText.trim())
  || (scene.characters && scene.characters.length > 0)
);

export const ScriptAnalysisReview: React.FC<ScriptAnalysisReviewProps> = ({
  script,
  scenes,
  diagnostics,
  onApprove,
  onReanalyze,
  onBackToScript
}) => {
  const [localScenes, setLocalScenes] = useState<Scene[]>(() => (scenes || []).filter(isRenderableScene));
  const [characterInputs, setCharacterInputs] = useState<Record<number, string>>(() =>
    Object.fromEntries((scenes || []).filter(isRenderableScene).map((scene) => [scene.id, toCharacterInput(scene.characters || [])]))
  );
  const [submitAttempted, setSubmitAttempted] = useState(false);

  useEffect(() => {
    const cleaned = (scenes || []).filter(isRenderableScene);
    setLocalScenes(cleaned);
    setCharacterInputs(Object.fromEntries(cleaned.map((scene) => [scene.id, toCharacterInput(scene.characters || [])])));
    setSubmitAttempted(false);
  }, [scenes]);

  const scriptSegments = useMemo(() => segmentScriptForReview(script || ''), [script]);

  const sourceByScene = useMemo(() => {
    const map = new Map<number, { display: string; validation: string }>();
    for (let index = 0; index < localScenes.length; index += 1) {
      const scene = localScenes[index];
      const primary = String(scene.rawText || '').trim();
      const directMatch = scriptSegments.find((segment) => {
        if (primary && containsNormalizedSnippet(segment, primary)) return true;
        if (scene.synopsis && containsNormalizedSnippet(segment, scene.synopsis)) return true;
        if (scene.setting && containsNormalizedSnippet(segment, scene.setting)) return true;
        const hasCharacterMatch = (scene.characters || []).some((name) => containsNormalizedName(segment, name));
        return hasCharacterMatch;
      });
      const indexed = String(scriptSegments[index] || '').trim();
      const fullScript = String(script || '').trim();
      const fallback = String(directMatch || indexed || fullScript).trim();
      map.set(scene.id, {
        display: primary || fallback,
        validation: [primary, fallback].filter(Boolean).join('\n')
      });
    }
    return map;
  }, [localScenes, scriptSegments, script]);

  const validationByScene = useMemo(() => {
    const map = new Map<number, SceneValidation>();
    for (const scene of localScenes) {
      const source = sourceByScene.get(scene.id)?.validation || '';
      const sourceUnavailable = !source.trim();
      const invalidCharacters = (scene.characters || []).filter((name) => !containsNormalizedName(source, name));
      map.set(scene.id, { invalidCharacters, sourceUnavailable });
    }
    return map;
  }, [localScenes, sourceByScene]);

  const totalInvalidCharacters = useMemo(() => {
    let count = 0;
    validationByScene.forEach((entry) => {
      count += entry.invalidCharacters.length;
    });
    return count;
  }, [validationByScene]);

  const unavailableSourceCount = useMemo(() => {
    let count = 0;
    validationByScene.forEach((entry) => {
      if (entry.sourceUnavailable) count += 1;
    });
    return count;
  }, [validationByScene]);

  const updateScene = (sceneId: number, updates: Partial<Scene>) => {
    setLocalScenes((prev) => prev.map((scene) => (
      scene.id === sceneId ? { ...scene, ...updates } : scene
    )));
  };

  const handleCharactersChange = (sceneId: number, value: string) => {
    setCharacterInputs((prev) => ({ ...prev, [sceneId]: value }));
    const parsed = normalizeCharacters(value.split(',').map((entry) => entry.trim()));
    updateScene(sceneId, { characters: parsed });
  };

  const handleApprove = () => {
    setSubmitAttempted(true);
    if (totalInvalidCharacters > 0 || unavailableSourceCount > 0) return;

    const cleaned = localScenes.map((scene, index) => ({
      ...scene,
      id: index + 1,
      synopsis: scene.synopsis.trim(),
      setting: scene.setting.trim(),
      rawText: (sourceByScene.get(scene.id)?.display || scene.rawText || '').trim(),
      characters: normalizeCharacters(scene.characters || [])
    }));

    onApprove(cleaned);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in">
      <div className="bg-white border-4 border-black rounded-xl shadow-comic p-6 space-y-3">
        <h2 className="text-3xl font-display">Review Script Understanding</h2>
        <p className="text-sm font-comic text-slate-600">
          Confirm what the AI understood before continuing. Scene packaging edits are allowed, but character names must exist in each scene excerpt.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-bold">
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Scenes: {localScenes.length}</div>
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Segments: {diagnostics?.segmentCount ?? (scriptSegments.length || '—')}</div>
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Fallback scenes: {diagnostics?.fallbackSceneCount ?? diagnostics?.rawExcerptFallbackCount ?? 0}</div>
          <div className="border-2 border-black rounded px-2 py-1 bg-slate-50">Core drops: {diagnostics?.coreEntityDrops ?? diagnostics?.ungroundedCharactersDropped ?? 0}</div>
        </div>
        {submitAttempted && (totalInvalidCharacters > 0 || unavailableSourceCount > 0) && (
          <div className="border-2 border-brand-red bg-red-50 rounded px-3 py-2 text-sm font-bold text-brand-red flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {unavailableSourceCount > 0
              ? 'Source excerpt unavailable for one or more scenes. Reanalyze or return to script.'
              : 'Remove or fix ungrounded characters before continuing.'}
          </div>
        )}
      </div>

      <div className="space-y-4">
        {localScenes.map((scene) => {
          const validation = validationByScene.get(scene.id);
          return (
            <div key={scene.id} className="bg-white border-4 border-black rounded-xl shadow-comic p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="font-display text-2xl">Scene {scene.id}</div>
                {validation && validation.invalidCharacters.length === 0 && !validation.sourceUnavailable ? (
                  <div className="text-xs font-bold text-green-700 flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" /> Core entities grounded
                  </div>
                ) : (
                  <div className="text-xs font-bold text-brand-red flex items-center gap-1">
                    <AlertCircle className="w-4 h-4" /> Needs character grounding fix
                  </div>
                )}
              </div>

              <div>
                <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">Source Excerpt (locked)</div>
                <pre className="text-xs whitespace-pre-wrap bg-slate-50 border-2 border-black rounded p-3 font-mono">{sourceByScene.get(scene.id)?.display || 'Source excerpt unavailable.'}</pre>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">Synopsis</div>
                  <textarea
                    value={scene.synopsis}
                    onChange={(event) => updateScene(scene.id, { synopsis: event.target.value })}
                    rows={3}
                    className="w-full border-2 border-black rounded p-2 text-sm"
                  />
                </div>
                <div>
                  <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">Setting</div>
                  <textarea
                    value={scene.setting}
                    onChange={(event) => updateScene(scene.id, { setting: event.target.value })}
                    rows={3}
                    className="w-full border-2 border-black rounded p-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">Characters (comma separated)</div>
                <input
                  value={characterInputs[scene.id] || ''}
                  onChange={(event) => handleCharactersChange(scene.id, event.target.value)}
                  className="w-full border-2 border-black rounded p-2 text-sm"
                />
                {validation && validation.invalidCharacters.length > 0 && (
                  <div className="mt-2 text-xs font-bold text-brand-red">
                    Not found in this scene excerpt: {validation.invalidCharacters.join(', ')}
                  </div>
                )}
                {validation?.sourceUnavailable && (
                  <div className="mt-2 text-xs font-bold text-brand-red">
                    Source excerpt unavailable for this scene. Reanalyze script to continue.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white border-4 border-black rounded-xl shadow-comic p-4 flex flex-wrap gap-3 justify-end">
        <Button variant="secondary" onClick={onBackToScript} icon={<ArrowLeft className="w-4 h-4" />}>
          Back To Script
        </Button>
        <Button variant="secondary" onClick={onReanalyze} icon={<RotateCcw className="w-4 h-4" />}>
          Reanalyze
        </Button>
        <Button onClick={handleApprove}>
          Approve & Continue
        </Button>
      </div>

    </div>
  );
};
