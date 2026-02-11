
import React, { useState, useEffect, Suspense } from 'react';
import { Header } from './components/Header';
import { HomePage } from './components/HomePage';
// Lazy Load Heavy Components
const ProjectDashboard = React.lazy(() => import('./components/ProjectDashboard').then(module => ({ default: module.ProjectDashboard })));
const ComicEditor = React.lazy(() => import('./components/ComicEditor').then(module => ({ default: module.ComicEditor })));
const ComicReader = React.lazy(() => import('./components/ComicReader').then(module => ({ default: module.ComicReader })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const TestLab = React.lazy(() => import('./components/TestLab').then(module => ({ default: module.TestLab })));
const LearnHub = React.lazy(() => import('./components/LearnHub').then(module => ({ default: module.LearnHub })));
const PublicGallery = React.lazy(() => import('./components/PublicGallery').then(module => ({ default: module.PublicGallery })));
const PublicProfile = React.lazy(() => import('./components/PublicProfile').then(module => ({ default: module.PublicProfile })));
const AccountSettings = React.lazy(() => import('./components/AccountSettings').then(module => ({ default: module.AccountSettings })));
const PrivacyPolicy = React.lazy(() => import('./components/PrivacyPolicy').then(module => ({ default: module.PrivacyPolicy })));
const TermsOfService = React.lazy(() => import('./components/TermsOfService').then(module => ({ default: module.TermsOfService })));

import { MasterAssistant } from './components/MasterAssistant';
import { ModelSelector } from './components/ModelSelector';
import { FluxKeyInput } from './components/FluxKeyInput';
import { useProjectManager } from './hooks/useProjectManager';
import { checkSystemStatus } from './services/geminiService';
import { getFluxKeyInfo, getImageProvider, getLockedImageProvider } from './services/appSettings';
import { useAuth } from './contexts/AuthContext';
import { AuthPage } from './components/AuthPage';
import { getPublicProject, incrementViewCount, incrementLikeCount } from './services/db';
import { Project } from './types';
import { Key, Zap, Loader2 } from 'lucide-react';
import { SystemStatusResponse } from './apiTypes';
import { UserAvatar } from './components/UserAvatar';
import { ErrorBoundary } from './components/common/ErrorBoundary';

const App: React.FC = () => {
  const { user, loading: authLoading } = useAuth();
  const { projects, createProject, updateProject, deleteProject, duplicateProject, getProject, startGeneration, stopGeneration, reloadProjects, hydrateProjectAssets } = useProjectManager();
  const [hasValidKey, setHasValidKey] = useState(false);
  const [isCheckingKey, setIsCheckingKey] = useState(true);
  const [localKeyInput, setLocalKeyInput] = useState('');
  const [storedKeySuffix, setStoredKeySuffix] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);
  const [isHydratingProject, setIsHydratingProject] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'profile' | 'settings' | 'billing' | 'legal' | 'contact' | 'admin'>('profile');
  const [returnView, setReturnView] = useState<'dashboard' | 'gallery' | 'home'>('dashboard');
  const [lastView, setLastView] = useState<'home' | 'dashboard'>('home');

  // Simple routing state
  const [currentView, setCurrentView] = useState<'home' | 'auth' | 'dashboard' | 'editor' | 'reader' | 'test' | 'learn' | 'gallery' | 'settings' | 'privacy' | 'terms' | 'profile'>('home');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [publicProject, setPublicProject] = useState<Project | null>(null);
  const [viewedProfile, setViewedProfile] = useState<string | null>(null); // username
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

  // Effect: Load Public Project if needed (Moved to top level)
  useEffect(() => {
    if (authLoading || isCheckingKey) return;

    const loadPublic = async () => {
      if (currentView === 'reader' && activeProjectId) {
        const localProject = projects.find(p => p.id === activeProjectId);
        if (!localProject) {
          // It's a public project
          setIsHydratingProject(true);
          try {
            const proj = await getPublicProject(activeProjectId);
            if (proj) {
              setPublicProject(proj);
              incrementViewCount(activeProjectId); // Increment view count
            } else {
              setSystemError("Comic not found or private.");
              setCurrentView('dashboard');
            }
          } catch (e) {
            console.error(e);
            setSystemError("Failed to load comic.");
          } finally {
            setIsHydratingProject(false);
          }
        } else {
          setPublicProject(null); // Clear public if we found local
        }
      }
    };
    loadPublic();
  }, [currentView, activeProjectId, projects, authLoading, isCheckingKey]);

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
  const handleNavigate = (view: string, id?: string) => {
    // If going to reader, ensure we know where to return
    if (view === 'reader') {
      const source = currentView === 'gallery' ? 'gallery' : 'dashboard';
      setReturnView(source);
    }

    if (view === 'reader' && id) {
      const local = projects.find(p => p.id === id);
      if (local) {
        setActiveProjectId(id);
        setCurrentView('reader');
      } else {
        setIsHydratingProject(true);
        import('./services/db').then(async ({ getPublicProject, incrementViewCount }) => {
          const p = await getPublicProject(id);
          if (p) {
            setPublicProject(p);
            setActiveProjectId(p.id);
            incrementViewCount(p.id);
            setCurrentView('reader');
          }
          setIsHydratingProject(false);
        });
      }
    } else if (view === 'profile' && id) {
      setViewedProfile(id);
      setCurrentView('profile');
    } else if (view === 'home' || view === 'dashboard' || view === 'auth' || view === 'settings') {
      setCurrentView(view);
    }
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
      // If we have an active project separate from the manager's list (public), clear it when switching
      if (activeProjectId && !projects.find(p => p.id === activeProjectId)) {
        setPublicProject(null);
      }
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

  const handleCloseReader = () => {
    setCurrentView(returnView);
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
          <div className="flex gap-2 justify-center mt-6">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded font-bold text-white transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => setSystemError(null)}
              className="px-4 py-2 bg-transparent border border-red-500/50 hover:bg-red-900/30 rounded font-bold text-red-300 transition-colors"
            >
              Ignore
            </button>
          </div>
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



  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-blue">
        <Loader2 className="w-12 h-12 text-white animate-spin" />
      </div>
    );
  }

  // Define Routing Logic

  // Handlers for Views
  const navigateToAuth = () => setCurrentView('auth');
  const navigateToDashboard = () => setCurrentView('dashboard');

  if ((currentView as any) === 'auth') {
    if (user) { setCurrentView('dashboard'); return null; } // Auto-redirect if already logged in
    return <AuthPage
      onLoginSuccess={() => setCurrentView('dashboard')}
      onOpenPrivacy={() => setCurrentView('privacy')}
      onOpenTerms={() => setCurrentView('terms')}
    />;
  }

  if ((currentView as any) === 'gallery') {
    return (
      <PublicGallery
        onReadComic={(pid) => {
          // We need to load a public project.
          // For MVP, we switch to Reader and tell Reader to load this ID.
          // BUT Reader expects "activeProjectId" which usually implies OWNERSHIP or at least loaded in db.ts cache.
          // We will set activeProjectId. The Reader component or App needs to handle loading logic.
          // App.tsx usually loads project from useProjectManager.
          // "activeProjectId" state is used.
          // We need to distinguish between "User Project" and "Public Project".
          // OR we just set activeProjectId and ensure the Reader can handle it?
          // The Reader component uses 'projects.find(p => p.id === activeProjectId)'.
          // Public projects are NOT in the 'projects' list (which is user's projects).
          // FIX: We need a way to pass the Project Object to Reader, OR have Reader fetch it if not found.
          //
          // Quick Fix: We'll route to 'reader' but we need to inject the public project into the state or handle it.
          // Let's modify Reader View logic below.
          setActiveProjectId(pid);
          setCurrentView('reader');
        }}
        onBack={() => setCurrentView('home')}
      />
    );
  }

  // Protection: Views other than 'home' and 'auth' require User
  const isProtectedViewStrict = ['dashboard', 'editor', 'test', 'learn'].includes(currentView);

  if (!user && isProtectedViewStrict) {
    return <AuthPage
      onLoginSuccess={() => setCurrentView('dashboard')}
      onOpenPrivacy={() => setCurrentView('privacy')}
      onOpenTerms={() => setCurrentView('terms')}
    />;
  }

  // If we are here, and view is protected, User is guaranteed (except for type narrowing)
  // If User is present, handle Key Check only for Protected Routes

  // REMOVED: Blocking "Unlock Studio" screen.
  // We now allow users to enter and configure keys later in Settings.
  /*
  if (user && isProtectedViewStrict && !hasValidKey) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-blue p-4">
        ...
      </div>
    );
  }
  */

  const activeProject = activeProjectId ? getProject(activeProjectId) : undefined;

  return (
    <ErrorBoundary>
      <div className="min-h-screen font-sans relative">
        {/* Header */}
        {(currentView === 'dashboard' || currentView === 'test' || currentView === 'learn') && (
          <Header
            currentView={currentView}
            setCurrentView={setCurrentView as any}
            setSettingsTab={setSettingsTab}
            setLastView={setLastView}
          />
        )}

        <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-brand-blue"><Loader2 className="w-12 h-12 text-white animate-spin" /></div>}>
          {/* Views */}
          {currentView === 'home' && (
            <HomePage
              onEnterStudio={() => user ? setCurrentView('dashboard') : setCurrentView('auth')}
              onViewComics={() => setCurrentView('gallery')}
              onOpenProfile={() => { setSettingsTab('profile'); setLastView('home'); setCurrentView('settings'); }}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
              onOpenUpgrade={() => { setSettingsTab('settings'); setLastView('home'); setCurrentView('settings'); }}
              onNavigate={handleNavigate}
            />
          )}
          {currentView === 'auth' && (
            <AuthPage
              onLoginSuccess={() => setCurrentView('dashboard')}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
            />
          )}
          {currentView === 'gallery' && (
            <PublicGallery
              onBack={() => setCurrentView('home')}
              onReadComic={(id) => {
                setReturnView('gallery');
                import('./services/db').then(({ incrementViewCount }) => incrementViewCount(id)); // Proactive increment
                handleNavigate('reader', id);
              }}
            />
          )}

          {currentView === 'privacy' && (
            <PrivacyPolicy onBack={() => user ? setCurrentView('dashboard') : setCurrentView('home')} />
          )}

          {currentView === 'terms' && <TermsOfService onBack={() => setCurrentView('home')} />}

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
              onBack={() => setCurrentView('dashboard')}
            />
          )}

          {(currentView === 'reader') && (
            <ComicReader
              project={projects.find(p => p.id === activeProjectId) || publicProject!}
              onClose={handleCloseReader}
              onUpdateProject={updateProject}
              isReadOnly={!!publicProject}
              onNavigate={handleNavigate}
            />
          )}

          {currentView === 'profile' && viewedProfile && (
            <PublicProfile
              username={viewedProfile}
              onNavigate={handleNavigate}
            />
          )}

          {currentView === 'settings' && (
            <AccountSettings
              onClose={() => setCurrentView(lastView)}
              initialTab={settingsTab}
            />
          )}
        </Suspense>

        {/* Global Master Assistant */}
        <MasterAssistant
          currentView={currentView as any}
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
          <Suspense fallback={null}>
            <SettingsModal
              onClose={() => setShowSettings(false)}
              onReloadProjects={() => reloadProjects()}
            />
          </Suspense>
        )}
      </div>
    </ErrorBoundary>
  );
};

export default App;
