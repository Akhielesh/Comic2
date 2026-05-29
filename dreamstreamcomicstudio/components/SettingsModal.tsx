import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { encryptKey } from "../services/crypto";
import { X, Eye, EyeOff, Copy, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "./Button";
import { FluxKeyInput } from "./FluxKeyInput";
import { KeyManager } from "./KeyManager";
import { OpenRouterKeyInput } from "./OpenRouterKeyInput";
import {
  IMAGE_MODELS,
  getAllowedImageModelsForPlan,
  getDefaultImageModelForPlan,
  isImageModelAllowedForPlan
} from "../services/imageModels";
import { clearImageCache, getDbStats } from "../services/db";
import { getFluxKeyInfo, getSettingsState, setSettingsState } from "../services/appSettings";
import { getDebugState, subscribeDebugState } from "../services/debugStore";
import { getBillingSummary } from "../services/billing";
import { getPlanTierFromBillingSummary } from "../services/modelEntitlements";

interface SettingsModalProps {
  onClose: () => void;
  onReloadProjects: () => void;
  onUpdateSettings?: () => void;
}

const COMING_SOON_MODELS = [
  "Flux Dev",
  "Flux Pro",
  "SDXL Turbo",
  "SD3 Large",
  "Playground v2"
];

const FEATURE_ROUTING = [
  { id: "script_analysis", label: "Script Analysis" },
  { id: "story_builder", label: "Story Builder" },
  { id: "panel_breakdown", label: "Panel Breakdown" },
  { id: "image_generation", label: "Image Generation" }
];

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, onReloadProjects, onUpdateSettings }) => {
  const [dbStats, setDbStats] = useState<Awaited<ReturnType<typeof getDbStats>> | null>(null);
  const [settings, setSettings] = useState(() => getSettingsState());
  const [planTier, setPlanTier] = useState<string>("free");
  const [fluxKey, setFluxKey] = useState<string | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState({
    keys: true,
    models: false,
    routing: false,
    storage: false
  });
  const [debugState, setDebugState] = useState(getDebugState());

  useEffect(() => {
    getDbStats().then(setDbStats).catch(() => setDbStats(null));
  }, []);

  useEffect(() => {
    let active = true;
    const loadPlan = async () => {
      try {
        const summary = await getBillingSummary();
        if (!active) return;
        setPlanTier(getPlanTierFromBillingSummary(summary));
      } catch {
        if (!active) return;
        setPlanTier("free");
      }
    };
    void loadPlan();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return subscribeDebugState(setDebugState);
  }, []);

  const allowedImageModels = getAllowedImageModelsForPlan(planTier);
  const fallbackImageModel = getDefaultImageModelForPlan(planTier);
  const effectiveDefaultImageModel = isImageModelAllowedForPlan(settings.defaultImageModel || "", planTier)
    ? (settings.defaultImageModel as string)
    : fallbackImageModel.id;

  const effectiveCoverModel = isImageModelAllowedForPlan(settings.modelRouting?.cover || "", planTier)
    ? (settings.modelRouting?.cover as string)
    : effectiveDefaultImageModel;
  const effectivePanelModel = isImageModelAllowedForPlan(settings.modelRouting?.panel || "", planTier)
    ? (settings.modelRouting?.panel as string)
    : effectiveDefaultImageModel;

  useEffect(() => {
    if (effectiveDefaultImageModel === settings.defaultImageModel &&
      effectiveCoverModel === (settings.modelRouting?.cover || settings.defaultImageModel) &&
      effectivePanelModel === (settings.modelRouting?.panel || settings.defaultImageModel)
    ) {
      return;
    }
    const next = {
      ...settings,
      defaultImageModel: effectiveDefaultImageModel,
      modelRouting: {
        ...(settings.modelRouting || {}),
        cover: effectiveCoverModel,
        panel: effectivePanelModel
      }
    };
    setSettings(next);
    setSettingsState(next);
    if (onUpdateSettings) onUpdateSettings();
  }, [
    effectiveDefaultImageModel,
    effectiveCoverModel,
    effectivePanelModel,
    onUpdateSettings,
    settings
  ]);


  const toggleSetting = (key: "showGeminiKey" | "showFluxKey") => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    setSettingsState(next);
    if (onUpdateSettings) onUpdateSettings();
  };



  const fluxDebug = debugState.flux;
  const geminiDebug = debugState.gemini;
  const fluxStatus = fluxKey ? "Ready" : "Missing";

  const SectionHeader = ({ title, sectionKey }: { title: string; sectionKey: keyof typeof sectionsOpen }) => (
    <button
      className="w-full flex items-center justify-between text-left px-4 py-3 border-2 border-black rounded-lg bg-slate-50"
      onClick={() => setSectionsOpen((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }))}
    >
      <span className="font-display text-lg">{title}</span>
      {sectionsOpen[sectionKey] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white border-4 border-black rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-comic">
        <div className="flex items-center justify-between p-4 border-b-4 border-black">
          <h2 className="text-2xl font-display">Settings</h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-100">
            <X />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <section className="space-y-3">
            {/* RENAMED SECTION FOR VISIBILITY */}
            <SectionHeader title="API Keys & Models" sectionKey="keys" />
            {sectionsOpen.keys && (
              <div className="space-y-4 animate-fade-in">
                <div className="flex justify-end px-1">
                  <a href="/docs/setup_keys.md" target="_blank" className="text-[11px] font-bold text-blue-600 underline hover:text-blue-800">
                    Need help getting keys?
                  </a>
                </div>

                {/* OpenRouter unified-gateway key (BYOK) */}
                <div className="pt-2">
                  <OpenRouterKeyInput />
                </div>

                {/* New Key Manager for Model-Specific Keys */}
                <div className="pt-2">
                  <KeyManager planTier={planTier} />
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader title="Image Models" sectionKey="models" />
            {sectionsOpen.models && (
              <div className="grid md:grid-cols-2 gap-3 animate-fade-in">
                {IMAGE_MODELS.map(model => (
                  <div
                    key={model.id}
                    onClick={() => {
                      if (!isImageModelAllowedForPlan(model.id, planTier)) return;
                      const next = { ...settings, defaultImageModel: model.id };
                      setSettings(next);
                      setSettingsState(next);
                      if (onUpdateSettings) onUpdateSettings();
                    }}
                    className={`p-3 border-2 rounded-lg transition-all ${!isImageModelAllowedForPlan(model.id, planTier) ? 'opacity-50 cursor-not-allowed border-slate-200' : 'cursor-pointer'} ${effectiveDefaultImageModel === model.id ? 'border-brand-blue bg-brand-blue/20 ring-2 ring-brand-blue/50' : 'border-slate-200 hover:border-black'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${effectiveDefaultImageModel === model.id ? 'border-brand-blue bg-brand-blue' : 'border-slate-300'}`}>
                        {effectiveDefaultImageModel === model.id && <div className="w-2 h-2 bg-white rounded-full" />}
                      </div>
                      <div className="font-bold text-sm">{model.label}</div>
                    </div>
                    <div className="text-xs text-slate-500 ml-6">
                      {model.provider === 'flux' ? 'Fast generation, good for styles.' : 'High detail, follows complex prompts.'}
                      {model.isFree && <span className="ml-2 text-green-600 font-bold">FREE</span>}
                      {!isImageModelAllowedForPlan(model.id, planTier) && <span className="ml-2 text-amber-700 font-bold">PRO</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader title="Model Routing" sectionKey="routing" />
            {sectionsOpen.routing && (
              <div className="space-y-3 animate-fade-in">
                <div className="p-4 bg-slate-50 border-2 border-slate-200 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-sm">Cover Art</span>
                    <select
                      value={effectiveCoverModel}
                      onChange={(e) => {
                        const next = { ...settings, modelRouting: { ...(settings.modelRouting || {}), cover: e.target.value } };
                        setSettings(next);
                        setSettingsState(next);
                        if (onUpdateSettings) onUpdateSettings();
                      }}
                      className="text-xs border-2 border-slate-300 rounded px-2 py-1 bg-white"
                    >
                      {allowedImageModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm">Panels</span>
                    <select
                      value={effectivePanelModel}
                      onChange={(e) => {
                        const next = { ...settings, modelRouting: { ...(settings.modelRouting || {}), panel: e.target.value } };
                        setSettings(next);
                        setSettingsState(next);
                        if (onUpdateSettings) onUpdateSettings();
                      }}
                      className="text-xs border-2 border-slate-300 rounded px-2 py-1 bg-white"
                    >
                      {allowedImageModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader title="Storage & Health" sectionKey="storage" />
            {sectionsOpen.storage && (
              <>
                <div className="grid md:grid-cols-5 gap-3 text-xs font-bold">
                  <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                    Projects: {dbStats?.projects ?? "—"}
                  </div>
                  <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                    Images: {dbStats?.images ?? "—"}
                  </div>
                  <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                    Artifacts: {dbStats?.artifacts ?? "—"}
                  </div>
                  <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                    Test Runs: {dbStats?.testRuns ?? "—"}
                  </div>
                  <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                    Test Images: {dbStats?.testImages ?? "—"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={onReloadProjects}>Reload Projects</Button>
                  <Button size="sm" variant="secondary" onClick={() => { clearImageCache(); }}>
                    Rebuild Cache
                  </Button>
                </div>
                {dbStats?.storage && (
                  <div className="text-[11px] text-slate-500">
                    Storage: {dbStats.storage.usage ?? 0} / {dbStats.storage.quota ?? 0} bytes
                  </div>
                )}

                <div className="mt-4 pt-4 border-t-2 border-slate-200">
                  <h4 className="text-xs font-bold uppercase mb-2 text-slate-500">Legacy Data</h4>
                  <div className="flex items-center justify-between bg-yellow-50 p-3 rounded-lg border-2 border-yellow-200">
                    <div className="text-xs text-yellow-800">
                      Missing your old projects? They are still on this device.
                    </div>
                    <Button size="sm" onClick={async () => {
                      if (!confirm("This will upload all local projects to your cloud account. Continue?")) return;
                      try {
                        const { migrateLegacyData } = await import("../services/db");
                        const result = await migrateLegacyData();
                        alert(`Migration Complete! Moved ${result.projects} projects.`);
                        onReloadProjects();
                      } catch (e) {
                        alert("Migration failed. See console for details.");
                      }
                    }}>
                      Migrate Local Data
                    </Button>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
