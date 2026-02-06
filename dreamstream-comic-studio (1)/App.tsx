
import React, { useState, useEffect } from 'react';
import { ProjectDashboard } from './components/ProjectDashboard';
import { HomePage } from './components/HomePage';
import { ComicEditor } from './components/ComicEditor';
import { ComicReader } from './components/ComicReader';
import { MasterAssistant } from './components/MasterAssistant';
import { ModelSelector } from './components/ModelSelector';
import { FluxKeyInput } from './components/FluxKeyInput';
import { SettingsModal } from './components/SettingsModal';
import { TestLab } from './components/TestLab';
import { LearnHub } from './components/LearnHub';
import { useProjectManager } from './hooks/useProjectManager';
import { checkSystemStatus } from './services/geminiService';
import { getFluxKeyInfo, getImageProvider, getLockedImageProvider } from './services/appSettings';
import { Key, Zap, Loader2 } from 'lucide-react';
import { SystemStatusResponse } from './apiTypes';

const App: React.FC = () => {
  const { projects, createProject, updateProject, deleteProject, duplicateProject, getProject, startGeneration, stopGeneration, reloadProjects, hydrateProjectAssets } = useProjectManager();
  const [hasValidKey, setHasValidKey] = useState(false);
  const [isCheckingKey, setIsCheckingKey] = useState(true);
  const [localKeyInput, setLocalKeyInput] = useState('');
  const [storedKeySuffix, setStoredKeySuffix] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);
  const [isHydratingProject, setIsHydratingProject] = useState(false);

  // Simple routing state
  const [currentView, setCurrentView] = useState<'home' | 'dashboard' | 'editor' | 'reader' | 'test' | 'learn'>('home');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);

  const computeHasValidKey = (geminiKey?: string | null, fluxKey?: string | null) => {
    const lockedProvider = getLockedImageProvider();
    const selectedProvider = getImageProvider();
    const requiresFlux = lockedProvider === 'flux' || selectedProvider === 'flux';
    const serverGemini = systemStatus?.geminiKeyPresent ?? false;
    const serverFlux = systemStatus?.pixazoKeyPresent ?? false;
    const hasGemini = !!geminiKey || serverGemini;
    const hasFlux = !!fluxKey || serverFlux;
    return requiresFlux ? hasFlux : hasGemini;
  };

  useEffect(() => {
    // Check System Config
    checkSystemStatus()
      .then(res => {
        setSystemStatus(res);
        if (res.status === 'error') {
          setSystemError(res.message || "Unknown Error");
        }
      })
      .catch((err) => {
        console.error("System status check failed:", err);
        setSystemError(err?.message || "Unable to reach server");
      });
  }, []);

  useEffect(() => {
    // Check API Keys
    const checkKey = async () => {
      try {
        const fluxInfo = getFluxKeyInfo();
        let stored = '';
        try {
          stored = localStorage.getItem('dreamstream_api_key') || '';
        } catch {
          stored = '';
        }
        if (stored) setStoredKeySuffix(stored.slice(-4));
        setHasValidKey(computeHasValidKey(stored, fluxInfo.key));
      } catch (e) {
        console.error("Error checking API key:", e);
      } finally { setIsCheckingKey(false); }
    };
    checkKey();

    // Check URL for shared link access
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const id = params.get('id');
      if (view === 'read' && id) {
        // Wait for projects to load from localstorage (handled by hook, but simple here)
        setTimeout(() => {
        setIsHydratingProject(true);
        hydrateProjectAssets(id).finally(() => {
          setActiveProjectId(id);
          setCurrentView('reader');
          setIsHydratingProject(false);
        });
        }, 100);
      }
  }, [systemStatus?.geminiKeyPresent, systemStatus?.pixazoKeyPresent]);

  const handleSelectKey = async () => {
    try {
      const aiStudio = (window as any).aistudio;
      if (aiStudio) {
        await aiStudio.openSelectKey();
      }
      const manualKey = window.prompt('Paste your Gemini API key');
      if (manualKey && manualKey.trim()) {
        const trimmed = manualKey.trim();
        localStorage.setItem('dreamstream_api_key', trimmed);
        setStoredKeySuffix(trimmed.slice(-4));
        const fluxInfo = getFluxKeyInfo();
        setHasValidKey(computeHasValidKey(trimmed, fluxInfo.key));
      }
    } catch (error) { console.error("Key selection failed:", error); }
  };

  const handleSaveLocalKey = () => {
    const trimmed = localKeyInput.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem('dreamstream_api_key', trimmed);
      setStoredKeySuffix(trimmed.slice(-4));
      const fluxInfo = getFluxKeyInfo();
      setHasValidKey(computeHasValidKey(trimmed, fluxInfo.key));
      setLocalKeyInput('');
    } catch (e) {
      console.error("Failed to save API key", e);
    }
  };

  const handleClearLocalKey = () => {
    try {
      localStorage.removeItem('dreamstream_api_key');
      setStoredKeySuffix(null);
      const fluxInfo = getFluxKeyInfo();
      setHasValidKey(computeHasValidKey(null, fluxInfo.key));
    } catch (e) {
      console.error("Failed to clear API key", e);
    }
  };

  const handleCreateProject = (name: string) => {
    const newProject = createProject(name);
    setActiveProjectId(newProject.id);
    setCurrentView('editor');
  };

  const handleOpenProject = (id: string) => {
    setIsHydratingProject(true);
    hydrateProjectAssets(id).finally(() => {
      setActiveProjectId(id);
      setCurrentView('editor');
      setIsHydratingProject(false);
    });
  };

  const handleReadProject = (id: string) => {
    setIsHydratingProject(true);
    hydrateProjectAssets(id).finally(() => {
      setActiveProjectId(id);
      setCurrentView('reader');
      setIsHydratingProject(false);
      // Update URL for sharing without reload
      const url = new URL(window.location.href);
      url.searchParams.set('view', 'read');
      url.searchParams.set('id', id);
      window.history.pushState({}, '', url);
    });
  };

  const handleBackToDashboard = () => {
    setCurrentView('dashboard');
    setActiveProjectId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('id');
    window.history.pushState({}, '', url);
  };

  const handleBackToHome = () => {
    setCurrentView('home');
    setActiveProjectId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('id');
    window.history.pushState({}, '', url);
  };

  if (systemError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-white p-4">
        <div className="max-w-md p-6 bg-red-950/30 border border-red-500/50 rounded-lg text-center">
          <h2 className="text-xl font-bold text-red-400 mb-2">System Error</h2>
          <p className="mb-4">{systemError}</p>
          <div className="text-sm text-zinc-400">
            <p>Please check your server configuration:</p>
            <code className="bg-black/50 p-1 rounded mt-2 block">GEMINI_API_KEY=... (server)</code>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-4 py-2 bg-red-600 hover:bg-red-500 rounded font-bold text-white transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (isCheckingKey || isHydratingProject) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-blue">
        <Loader2 className="w-12 h-12 text-white animate-spin" />
      </div>
    );
  }

  if (!hasValidKey) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-blue p-4">
        <div className="text-center p-8 bg-white rounded-xl border-4 border-black shadow-comic max-w-md transform -rotate-2">
          <Key className="w-16 h-16 mx-auto text-brand-red mb-4" />
          <h1 className="text-4xl font-display mb-2 text-black">Unlock Studio</h1>
          <p className="text-slate-600 font-comic text-lg mb-6 leading-relaxed">
            Image generation is locked to Flux Schnell (Pixazo) right now. Add your Pixazo API key to continue.
          </p>
          <div className="space-y-4">
            <ModelSelector />
            <FluxKeyInput
              onStatusChange={(hasKey) => setHasValidKey(hasKey)}
            />
          </div>
          <div className="mt-4 bg-slate-50 border-2 border-black rounded-lg p-4 text-left">
            <div className="text-xs font-bold uppercase mb-2">Gemini API (for script analysis & assistants)</div>
            <input
              type="password"
              value={localKeyInput}
              onChange={(e) => setLocalKeyInput(e.target.value)}
              placeholder="AIza..."
              className="w-full border-2 border-black rounded px-3 py-2 text-sm mb-2"
            />
            <div className="flex gap-2">
              <button onClick={handleSaveLocalKey} className="flex-1 bg-black text-white font-bold text-xs py-2 rounded">Save Gemini Key</button>
              <button onClick={handleClearLocalKey} className="flex-1 bg-white border-2 border-black font-bold text-xs py-2 rounded">Clear</button>
            </div>
            <div className="mt-2 text-[11px] text-slate-500">
              Stored locally in your browser. Current: {storedKeySuffix ? `••••${storedKeySuffix}` : 'none'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const activeProject = activeProjectId ? getProject(activeProjectId) : undefined;

  return (
    <div className="min-h-screen font-sans relative">
      {/* Header */}
      {(currentView === 'dashboard' || currentView === 'test' || currentView === 'learn') && (
        <header className="h-24 bg-white border-b-4 border-black flex items-center px-6 justify-between relative z-50 shadow-lg">
          <div className="flex items-center gap-3 transform hover:scale-105 transition-transform cursor-default">
            <div className="w-12 h-12 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center text-black font-display text-3xl shadow-comic transform -rotate-3">D</div>
            <div className="flex flex-col">
              <span className="font-display text-3xl tracking-tight text-black leading-none" style={{ textShadow: '2px 2px 0px #ddd' }}>DreamStream</span>
              <span className="font-comic font-bold text-brand-blue text-sm leading-none">Comic Studio</span>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-4">
            <button onClick={handleBackToHome} className="text-xs font-bold font-mono text-slate-500 hover:text-brand-blue underline decoration-2 underline-offset-2 transition-colors">HOME</button>
            <button onClick={() => setCurrentView('test')} className="text-xs font-bold font-mono text-slate-500 hover:text-brand-blue underline decoration-2 underline-offset-2 transition-colors">TEST LAB</button>
            <button onClick={() => setCurrentView('learn')} className="text-xs font-bold font-mono text-slate-500 hover:text-brand-blue underline decoration-2 underline-offset-2 transition-colors">LEARN</button>
            <button onClick={() => setCurrentView('dashboard')} className="text-xs font-bold font-mono text-slate-500 hover:text-brand-blue underline decoration-2 underline-offset-2 transition-colors">DASHBOARD</button>
            <button onClick={() => setShowSettings(true)} className="text-xs font-bold font-mono text-slate-500 hover:text-brand-blue underline decoration-2 underline-offset-2 transition-colors">SETTINGS</button>
            <button onClick={handleSelectKey} className="text-xs font-bold font-mono text-slate-500 hover:text-brand-blue underline decoration-2 underline-offset-2 transition-colors">GEMINI KEY</button>
            <div className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-full font-bold font-mono text-xs border-2 border-white shadow-lg">
              <Zap size={14} className="text-brand-yellow fill-brand-yellow" /> IMAGE: FLUX
            </div>
          </div>
        </header>
      )}

      {/* Views */}
      {currentView === 'home' && (
        <HomePage
          onEnterStudio={() => setCurrentView('dashboard')}
          onSelectKey={handleSelectKey}
        />
      )}

      {currentView === 'dashboard' && (
        <ProjectDashboard 
            projects={projects}
            onCreateProject={handleCreateProject}
            onOpenProject={handleOpenProject}
            onDeleteProject={deleteProject}
            onDuplicateProject={duplicateProject}
            onReadProject={handleReadProject}
            onUpdateProject={updateProject}
        />
      )}

      {currentView === 'test' && (
        <TestLab
          onCreateProject={(name) => createProject(name)}
          onUpdateProject={updateProject}
          onOpenProject={(id) => {
            setActiveProjectId(id);
            setCurrentView('editor');
          }}
        />
      )}

      {currentView === 'learn' && (
        <LearnHub onLaunchTestLab={() => setCurrentView('test')} />
      )}

      {currentView === 'editor' && activeProject && (
        <ComicEditor
          project={activeProject}
          onUpdate={(updates) => updateProject(activeProject.id, updates)}
          onStartGeneration={startGeneration}
          onStopGeneration={stopGeneration}
          onBack={handleBackToDashboard}
        />
      )}

      {currentView === 'reader' && activeProject && (
        <ComicReader
          project={activeProject}
          onClose={handleBackToDashboard}
          onUpdateProject={updateProject}
        />
      )}

      {/* Global Master Assistant */}
      <MasterAssistant
        currentView={currentView}
        activeProject={activeProject}
        projects={projects}
        onPersistChat={(messages) => {
          if (!activeProject) return;
          updateProject(activeProject.id, (prev) => ({
            state: { ...prev.state, assistantChat: messages }
          }));
        }}
      />

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onReloadProjects={() => reloadProjects()}
        />
      )}
    </div>
  );
};

export default App;
