import React, { useEffect, useState } from "react";
import { X, Eye, EyeOff, Copy, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "./Button";
import { FluxKeyInput } from "./FluxKeyInput";
import { IMAGE_MODELS } from "../services/imageModels";
import { clearImageCache, getDbStats } from "../services/db";
import { getFluxKeyInfo, getSettingsState, setSettingsState } from "../services/appSettings";
import { getDebugState, subscribeDebugState } from "../services/debugStore";

interface SettingsModalProps {
  onClose: () => void;
  onReloadProjects: () => void;
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

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, onReloadProjects }) => {
  const [dbStats, setDbStats] = useState<Awaited<ReturnType<typeof getDbStats>> | null>(null);
  const [settings, setSettings] = useState(() => getSettingsState());
  const [geminiKey, setGeminiKey] = useState<string | null>(null);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [fluxKey, setFluxKey] = useState<string | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState({
    keys: true,
    models: false,
    routing: false,
    storage: false
  });
  const [showFluxInput, setShowFluxInput] = useState(false);
  const [showGeminiInput, setShowGeminiInput] = useState(false);
  const [debugState, setDebugState] = useState(getDebugState());

  useEffect(() => {
    try {
      const stored = localStorage.getItem("dreamstream_api_key");
      if (stored) setGeminiKey(stored);
    } catch {
      setGeminiKey(null);
    }
    const fluxInfo = getFluxKeyInfo();
    setFluxKey(fluxInfo.key);
  }, []);

  useEffect(() => {
    getDbStats().then(setDbStats).catch(() => setDbStats(null));
  }, []);

  useEffect(() => {
    return subscribeDebugState(setDebugState);
  }, []);

  const toggleSetting = (key: "showGeminiKey" | "showFluxKey") => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    setSettingsState(next);
  };

  const handleSaveGemini = () => {
    const trimmed = geminiKeyInput.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem("dreamstream_api_key", trimmed);
      setGeminiKey(trimmed);
      setGeminiKeyInput("");
    } catch {
      // ignore
    }
  };

  const handleClearGemini = () => {
    try {
      localStorage.removeItem("dreamstream_api_key");
      setGeminiKey(null);
    } catch {
      // ignore
    }
  };

  const handleCopy = async (value: string | null) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ignore
    }
  };

  const fluxDebug = debugState.flux;
  const geminiDebug = debugState.gemini;
  const fluxStatus = fluxKey ? "Ready" : "Missing";
  const geminiStatus = geminiKey ? "Ready" : "Missing";

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
            <SectionHeader title="API Keys" sectionKey="keys" />
            {sectionsOpen.keys && (
              <div className="space-y-4">
                <div className="bg-white border-2 border-black rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold uppercase">Pixazo Flux Schnell</div>
                    <div className="flex items-center gap-2 text-xs font-bold">
                      {fluxKey ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <AlertTriangle className="w-4 h-4 text-red-500" />}
                      {fluxStatus}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-600">
                    <span>Key: {settings.showFluxKey && fluxKey ? fluxKey : fluxKey ? `••••${fluxKey.slice(-4)}` : "none"}</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleSetting("showFluxKey")}
                        className="text-xs font-bold flex items-center gap-1"
                      >
                        {settings.showFluxKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        {settings.showFluxKey ? "Hide" : "Show"}
                      </button>
                      <button
                        onClick={() => handleCopy(fluxKey)}
                        className="text-xs font-bold flex items-center gap-1"
                      >
                        <Copy className="w-3 h-3" /> Copy
                      </button>
                      <button
                        onClick={() => setShowFluxInput((prev) => !prev)}
                        className="text-xs font-bold underline"
                      >
                        {showFluxInput ? "Close" : fluxKey ? "Change Key" : "Add Key"}
                      </button>
                    </div>
                  </div>
                  {fluxDebug?.lastError && (
                    <div className="text-[11px] text-red-600 font-mono">Last error: {String(fluxDebug.lastError).slice(0, 140)}</div>
                  )}
                  {showFluxInput && (
                    <FluxKeyInput
                      compact
                      onStatusChange={() => {
                        const info = getFluxKeyInfo();
                        setFluxKey(info.key);
                      }}
                    />
                  )}
                </div>

                <div className="bg-white border-2 border-black rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold uppercase">Gemini API Key</div>
                    <div className="flex items-center gap-2 text-xs font-bold">
                      {geminiKey ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <AlertTriangle className="w-4 h-4 text-red-500" />}
                      {geminiStatus}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-600">
                    <span>Key: {settings.showGeminiKey && geminiKey ? geminiKey : geminiKey ? `••••${geminiKey.slice(-4)}` : "none"}</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleSetting("showGeminiKey")}
                        className="text-xs font-bold flex items-center gap-1"
                      >
                        {settings.showGeminiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        {settings.showGeminiKey ? "Hide" : "Show"}
                      </button>
                      <button
                        onClick={() => handleCopy(geminiKey)}
                        className="text-xs font-bold flex items-center gap-1"
                      >
                        <Copy className="w-3 h-3" /> Copy
                      </button>
                      <button
                        onClick={() => setShowGeminiInput((prev) => !prev)}
                        className="text-xs font-bold underline"
                      >
                        {showGeminiInput ? "Close" : geminiKey ? "Change Key" : "Add Key"}
                      </button>
                    </div>
                  </div>
                  {geminiDebug?.lastError && (
                    <div className="text-[11px] text-red-600 font-mono">Last error: {String(geminiDebug.lastError).slice(0, 140)}</div>
                  )}
                  {showGeminiInput && (
                    <div className="space-y-2">
                      <input
                        type={settings.showGeminiKey ? "text" : "password"}
                        value={geminiKeyInput}
                        onChange={(e) => setGeminiKeyInput(e.target.value)}
                        placeholder="Paste Gemini key"
                        className="w-full border-2 border-black rounded px-3 py-2 text-sm"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSaveGemini}>Save</Button>
                        <Button size="sm" variant="secondary" onClick={handleClearGemini}>Clear</Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader title="Image Models" sectionKey="models" />
            {sectionsOpen.models && (
              <div className="grid md:grid-cols-2 gap-3">
                {IMAGE_MODELS.map((model) => (
                  <div key={model.id} className="border-2 border-black rounded-lg p-3 bg-slate-50">
                    <div className="text-sm font-bold">{model.label}</div>
                    <div className="text-[11px] text-slate-500">{model.id}</div>
                  </div>
                ))}
                {COMING_SOON_MODELS.map((name) => (
                  <div key={name} className="border-2 border-black rounded-lg p-3 bg-white/60 opacity-70">
                    <div className="text-sm font-bold">{name}</div>
                    <div className="text-[11px] text-slate-500">Coming soon</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader title="Model Routing (Coming Soon)" sectionKey="routing" />
            {sectionsOpen.routing && (
              <div className="grid md:grid-cols-2 gap-3">
                {FEATURE_ROUTING.map((feature) => (
                  <div key={feature.id} className="border-2 border-black rounded-lg p-3 bg-slate-50">
                    <div className="text-xs font-bold uppercase">{feature.label}</div>
                    <select disabled className="mt-2 w-full border-2 border-black rounded px-3 py-2 text-sm opacity-70">
                      <option>Coming soon</option>
                    </select>
                  </div>
                ))}
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
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
