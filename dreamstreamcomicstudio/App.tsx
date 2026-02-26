import React, { useEffect, useRef, useState, Suspense } from 'react';
import { HomePage } from './components/HomePage';
import { lazyImportWithRetry } from './services/lazyImportWithRetry';
// Lazy Load Heavy Components
const ProjectDashboard = lazyImportWithRetry(() => import('./components/ProjectDashboard').then(module => ({ default: module.ProjectDashboard })));
const ComicEditor = lazyImportWithRetry(() => import('./components/ComicEditor').then(module => ({ default: module.ComicEditor })));
const ComicReader = lazyImportWithRetry(() => import('./components/ComicReader').then(module => ({ default: module.ComicReader })));
const TestLab = lazyImportWithRetry(() => import('./components/TestLab').then(module => ({ default: module.TestLab })));
const LearnHub = lazyImportWithRetry(() => import('./components/LearnHub').then(module => ({ default: module.LearnHub })));
const PublicGallery = lazyImportWithRetry(() => import('./components/PublicGallery').then(module => ({ default: module.PublicGallery })));
const PublicProfile = lazyImportWithRetry(() => import('./components/PublicProfile').then(module => ({ default: module.PublicProfile })));
const AccountSettings = lazyImportWithRetry(() => import('./components/AccountSettings').then(module => ({ default: module.AccountSettings })));
const PrivacyPolicy = lazyImportWithRetry(() => import('./components/PrivacyPolicy').then(module => ({ default: module.PrivacyPolicy })));
const TermsOfService = lazyImportWithRetry(() => import('./components/TermsOfService').then(module => ({ default: module.TermsOfService })));
const SharedViewer = lazyImportWithRetry(() => import('./components/SharedViewer').then(module => ({ default: module.SharedViewer })));
const ComicForgeStudio = lazyImportWithRetry(() => import('./components/comicforge/ComicForgeStudio').then(module => ({ default: module.ComicForgeStudio })));

import { useProjectManager } from './hooks/useProjectManager';
import { checkSystemDiagnostics, checkSystemStatus } from './services/geminiService';
import { getFluxKeyInfo } from './services/appSettings';
import { useAuth } from './contexts/AuthContext';
import { AuthPage } from './components/AuthPage';
import { AuthCallbackPage } from './components/AuthCallbackPage';
import { supabase } from './services/supabase';
import { getPrivateProfile, getPublicProject, incrementViewCount } from './services/db';
import { Project } from './types';
import { Loader2 } from 'lucide-react';
import { SystemDiagnosticsResponse } from './apiTypes';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { StaticSiteHeader } from './components/layout/StaticSiteHeader';
import { LegalMicroLinks } from './components/layout/LegalMicroLinks';
import { UniversalAssistant } from './components/UniversalAssistant';

type AppView =
  | 'home'
  | 'auth'
  | 'auth-callback'
  | 'dashboard'
  | 'editor'
  | 'reader'
  | 'test'
  | 'learn'
  | 'gallery'
  | 'settings'
  | 'privacy'
  | 'terms'
  | 'profile'
  | 'comicforge'
  | 'shared';

type SettingsTab = 'profile' | 'settings' | 'billing' | 'legal' | 'contact' | 'admin' | 'preferences' | 'security';

type AuthCallbackStatus = 'idle' | 'verifying' | 'success' | 'error';
type AuthCallbackFlow = 'magiclink' | 'recovery' | 'signup' | 'unknown';

type PendingReaderTarget = {
  id: string;
  returnView: AppView;
};

const App: React.FC = () => {
  const { user, loading: authLoading } = useAuth();
  const { projects, createProject, updateProject, deleteProject, duplicateProject, getProject, startGeneration, stopGeneration, hydrateProjectAssets } = useProjectManager();

  const [isCheckingKey, setIsCheckingKey] = useState(true);
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnosticsResponse | null>(null);
  const [isHydratingProject, setIsHydratingProject] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile');
  const [returnView, setReturnView] = useState<AppView>('dashboard');
  const [settingsReturnView, setSettingsReturnView] = useState<AppView>('home');
  const [needsDobCompletion, setNeedsDobCompletion] = useState(false);
  const [hasPromptedDobThisSession, setHasPromptedDobThisSession] = useState(false);
  const [openSecurityPasswordReset, setOpenSecurityPasswordReset] = useState(false);
  const [authCallbackStatus, setAuthCallbackStatus] = useState<AuthCallbackStatus>('idle');
  const [authCallbackMessage, setAuthCallbackMessage] = useState<string | null>(null);
  const [authCallbackFlow, setAuthCallbackFlow] = useState<AuthCallbackFlow>('unknown');

  // Simple routing state
  const [currentView, setCurrentView] = useState<AppView>('home');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [publicProject, setPublicProject] = useState<Project | null>(null);
  const [viewedProfile, setViewedProfile] = useState<string | null>(null); // username
  const [systemError, setSystemError] = useState<string | null>(null);
  const [pendingReaderTarget, setPendingReaderTarget] = useState<PendingReaderTarget | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const hasWarnedDobProfileCheckRef = useRef(false);

  const setReaderUrlParams = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'read');
    url.searchParams.set('id', id);
    window.history.pushState({}, '', url);
  };

  const clearReaderUrlParams = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('id');
    window.history.pushState({}, '', url);
  };

  const clearAuthUrlArtifacts = () => {
    const url = new URL(window.location.href);
    const authParams = ['code', 'type', 'token_hash', 'error', 'error_description', 'flow'];
    authParams.forEach((key) => url.searchParams.delete(key));
    if (url.hash) url.hash = '';
    if (url.pathname === '/auth/callback') {
      url.pathname = '/';
    }
    window.history.replaceState({}, '', url);
  };

  const isSettingsTab = (value?: string): value is SettingsTab => (
    value === 'profile' ||
    value === 'settings' ||
    value === 'billing' ||
    value === 'legal' ||
    value === 'contact' ||
    value === 'admin' ||
    value === 'preferences' ||
    value === 'security'
  );

  const handleBackToHome = () => {
    setCurrentView('home');
    setActiveProjectId(null);
    clearReaderUrlParams();
  };

  const handleOpenFaq = () => {
    handleBackToHome();
    window.setTimeout(() => {
      document.getElementById('home-faq')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 180);
  };

  const navigateToReader = async (id: string, originView: AppView = currentView) => {
    if (!user) {
      setPendingReaderTarget((prev) => {
        if (prev?.id === id && prev.returnView === originView) return prev;
        return { id, returnView: originView };
      });
      setReturnView(originView);
      setCurrentView('auth');
      return;
    }

    setReturnView(originView);

    const local = projects.find((project) => project.id === id);
    if (local) {
      setIsHydratingProject(true);
      hydrateProjectAssets(id).finally(() => {
        setPublicProject(null);
        setActiveProjectId(id);
        setCurrentView('reader');
        setReaderUrlParams(id);
        setIsHydratingProject(false);
      });
      return;
    }

    setIsHydratingProject(true);
    try {
      const project = await getPublicProject(id);
      if (!project) {
        setSystemError('Comic not found or private.');
        setCurrentView('gallery');
        return;
      }

      setPublicProject(project);
      setActiveProjectId(project.id);
      setCurrentView('reader');
      setReaderUrlParams(project.id);
      await incrementViewCount(project.id).catch(() => null);
    } catch (e) {
      console.error(e);
      setSystemError('Failed to load comic.');
    } finally {
      setIsHydratingProject(false);
    }
  };

  useEffect(() => {
    // Check system config
    checkSystemStatus()
      .then((res) => {
        if (res.status === 'error') {
          setSystemError(res.message || 'Unknown Error');
        }
      })
      .catch((err) => {
        console.error('System status check failed:', err);
        setSystemError(err?.message || 'Unable to reach server');
      });
  }, []);

  useEffect(() => {

    // Check for share URL: /share/:token
    const path = window.location.pathname;
    const shareMatch = path.match(/^\/share\/([^/]+)$/);
    if (shareMatch && shareMatch[1]) {
      setShareToken(shareMatch[1]);
      setCurrentView('shared');
    }
  }, []);

  useEffect(() => {
    if (!user?.email || user.email !== 'admin@test.com') {
      setSystemDiagnostics(null);
      return;
    }

    checkSystemDiagnostics()
      .then((res) => {
        setSystemDiagnostics(res);
        if (res.status === 'error') {
          console.warn('System diagnostics returned non-ok status:', res.message || 'Unknown diagnostics error');
        }
      })
      .catch((err) => {
        console.error('System diagnostics check failed:', err);
        setSystemDiagnostics({
          status: 'error',
          geminiKeyPresent: false,
          pixazoKeyPresent: false,
          message: err?.message || 'Unable to load system diagnostics'
        });
      });
  }, [user?.email]);

  useEffect(() => {
    const checkKey = async () => {
      try {
        getFluxKeyInfo();
        localStorage.getItem('dreamstream_api_key');
      } catch (e) {
        console.error('Error checking API key:', e);
      } finally {
        setIsCheckingKey(false);
      }
    };
    checkKey();
  }, [systemDiagnostics?.geminiKeyPresent, systemDiagnostics?.pixazoKeyPresent]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    const searchParams = url.searchParams;
    const code = searchParams.get('code');
    const tokenHash = searchParams.get('token_hash') || hashParams.get('token_hash');
    const rawType = searchParams.get('type') || hashParams.get('type') || 'magiclink';
    const type: AuthCallbackFlow =
      rawType === 'recovery' || rawType === 'signup' || rawType === 'magiclink'
        ? rawType
        : 'unknown';
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    const authError = searchParams.get('error_description') || hashParams.get('error_description');
    const hasAuthIntent =
      url.pathname === '/auth/callback' ||
      Boolean(code || tokenHash || accessToken || authError);

    if (!hasAuthIntent) return;

    let active = true;
    const handleCallback = async () => {
      setAuthCallbackStatus('verifying');
      setAuthCallbackMessage(null);
      setAuthCallbackFlow(type || 'unknown');
      setCurrentView('auth-callback');

      try {
        if (authError) throw new Error(decodeURIComponent(authError));

        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          const verifyType =
            rawType === 'recovery' || rawType === 'signup' || rawType === 'email_change'
              ? rawType
              : 'magiclink';
          const { error } = await supabase.auth.verifyOtp({
            type: verifyType,
            token_hash: tokenHash
          });
          if (error) throw error;
        } else if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken
          });
          if (error) throw error;
        } else {
          throw new Error('Invalid callback link. Please request a new one.');
        }

        if (!active) return;
        setAuthCallbackStatus('success');
        setAuthCallbackFlow(type || 'magiclink');
        setAuthCallbackMessage(
          type === 'recovery'
            ? 'Recovery link verified. Continue to set a new password.'
            : 'Authentication successful.'
        );
      } catch (err: any) {
        if (!active) return;
        setAuthCallbackStatus('error');
        setAuthCallbackMessage(err?.message || 'Failed to verify link.');
      } finally {
        clearAuthUrlArtifacts();
      }
    };

    void handleCallback();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setNeedsDobCompletion(false);
      setHasPromptedDobThisSession(false);
      hasWarnedDobProfileCheckRef.current = false;
      return;
    }

    let active = true;
    const checkDob = async () => {
      try {
        const profile = await getPrivateProfile(user.id);
        if (!active) return;
        setNeedsDobCompletion(!profile?.dob);
      } catch (err) {
        if (!active) return;
        setNeedsDobCompletion(true);
        if (!hasWarnedDobProfileCheckRef.current) {
          hasWarnedDobProfileCheckRef.current = true;
          console.warn('Failed to check DOB completion status', err);
        }
      }
    };

    void checkDob();
    return () => {
      active = false;
    };
  }, [user]);

  // Gate shared links (?view=read&id=...) behind auth and restore after login.
  useEffect(() => {
    if (authLoading || isCheckingKey) return;

    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const id = params.get('id');
    if (view !== 'read' || !id) return;

    if (currentView === 'reader' && activeProjectId === id) return;
    if (!user && currentView === 'auth' && pendingReaderTarget?.id === id) return;

    void navigateToReader(id, 'home');
  }, [authLoading, isCheckingKey, user, currentView, activeProjectId, pendingReaderTarget]);

  // Ensure public reader fallback still hydrates if needed.
  useEffect(() => {
    if (authLoading || isCheckingKey) return;
    if (currentView !== 'reader' || !activeProjectId) return;

    const localProject = projects.find((project) => project.id === activeProjectId);
    if (localProject) {
      if (publicProject) setPublicProject(null);
      return;
    }

    if (publicProject?.id === activeProjectId) return;

    const loadPublic = async () => {
      setIsHydratingProject(true);
      try {
        const project = await getPublicProject(activeProjectId);
        if (project) {
          setPublicProject(project);
        } else {
          setSystemError('Comic not found or private.');
          setCurrentView('gallery');
        }
      } catch (e) {
        console.error(e);
        setSystemError('Failed to load comic.');
      } finally {
        setIsHydratingProject(false);
      }
    };

    void loadPublic();
  }, [currentView, activeProjectId, projects, authLoading, isCheckingKey, publicProject]);

  // Resume pending reader target right after successful login.
  useEffect(() => {
    if (authLoading || isCheckingKey) return;
    if (!user || currentView !== 'auth' || !pendingReaderTarget) return;

    const target = pendingReaderTarget;
    setPendingReaderTarget(null);
    void navigateToReader(target.id, target.returnView);
  }, [user, currentView, pendingReaderTarget, authLoading, isCheckingKey]);

  // Default auth redirect when no pending comic intent exists.
  useEffect(() => {
    if (!user || currentView !== 'auth' || pendingReaderTarget || isHydratingProject) return;
    setCurrentView('dashboard');
  }, [user, currentView, pendingReaderTarget, isHydratingProject]);

  // If a reader session becomes unauthenticated, gate it and remember intent.
  useEffect(() => {
    if (authLoading || isCheckingKey) return;
    if (user || currentView !== 'reader' || !activeProjectId) return;
    setPendingReaderTarget((prev) => prev || { id: activeProjectId, returnView: returnView || 'gallery' });
    setCurrentView('auth');
  }, [user, currentView, activeProjectId, returnView, authLoading, isCheckingKey]);

  // Prompt existing users to complete DOB in profile settings (non-blocking).
  useEffect(() => {
    if (!user || authLoading || isCheckingKey) return;
    if (!needsDobCompletion || hasPromptedDobThisSession) return;
    if (currentView === 'auth' || currentView === 'settings') return;

    setHasPromptedDobThisSession(true);
    setSettingsTab('profile');
    setSettingsReturnView(currentView);
    setCurrentView('settings');
  }, [user, authLoading, isCheckingKey, needsDobCompletion, hasPromptedDobThisSession, currentView]);

  useEffect(() => {
    if (!needsDobCompletion) {
      setHasPromptedDobThisSession(false);
    }
  }, [needsDobCompletion]);

  const handleAuthCallbackContinue = () => {
    if (authCallbackStatus === 'error') {
      setCurrentView('auth');
      setAuthCallbackStatus('idle');
      setAuthCallbackMessage(null);
      return;
    }

    if (authCallbackFlow === 'recovery') {
      setSettingsTab('security');
      setSettingsReturnView('home');
      setOpenSecurityPasswordReset(true);
      setCurrentView('settings');
      setAuthCallbackStatus('idle');
      setAuthCallbackMessage(null);
      return;
    }

    if (pendingReaderTarget) {
      const target = pendingReaderTarget;
      setPendingReaderTarget(null);
      void navigateToReader(target.id, target.returnView);
    } else {
      setCurrentView('dashboard');
    }

    setAuthCallbackStatus('idle');
    setAuthCallbackMessage(null);
  };

  const handleNavigate = (view: string, id?: string) => {
    if (view === 'reader' && id) {
      void navigateToReader(id, currentView);
      return;
    }

    if (view === 'profile' && id) {
      clearReaderUrlParams();
      setViewedProfile(id);
      setCurrentView('profile');
      return;
    }

    if (view === 'settings') {
      clearReaderUrlParams();
      if (isSettingsTab(id)) {
        setSettingsTab(id);
        if (id !== 'security') setOpenSecurityPasswordReset(false);
      }
      setSettingsReturnView(currentView);
      setCurrentView('settings');
      return;
    }

    if (view === 'home') {
      handleBackToHome();
      return;
    }

    if (
      view === 'dashboard' ||
      view === 'auth' ||
      view === 'test' ||
      view === 'learn' ||
      view === 'gallery' ||
      view === 'comicforge' ||
      view === 'privacy' ||
      view === 'terms'
    ) {
      clearReaderUrlParams();
      setCurrentView(view as AppView);
    }
  };

  const handleCreateProject = (name: string) => {
    const newProject = createProject(name);
    setActiveProjectId(newProject.id);
    setCurrentView('editor');
  };

  const handleOpenProject = (id: string, expectedPipelineMode?: 'classic' | 'comicforge') => {
    setIsHydratingProject(true);
    hydrateProjectAssets(id).finally(() => {
      if (activeProjectId && !projects.find((project) => project.id === activeProjectId)) {
        setPublicProject(null);
      }
      const project = projects.find((candidate) => candidate.id === id);
      setActiveProjectId(id);
      const pipelineMode = expectedPipelineMode || project?.state.pipelineMode;
      setCurrentView(pipelineMode === 'comicforge' ? 'comicforge' : 'editor');
      setIsHydratingProject(false);
    });
  };

  const handleReadProject = (id: string) => {
    void navigateToReader(id, currentView);
  };

  const handleCloseReader = () => {
    const fallbackView: AppView = publicProject ? 'gallery' : 'dashboard';
    const nextView = returnView && returnView !== 'reader' ? returnView : fallbackView;
    setCurrentView(nextView);
    setActiveProjectId(null);
    clearReaderUrlParams();
  };

  const handleSignedOut = () => {
    setActiveProjectId(null);
    setPublicProject(null);
    setViewedProfile(null);
    setReturnView('home');
    setSettingsReturnView('home');
    setNeedsDobCompletion(false);
    setHasPromptedDobThisSession(false);
    setOpenSecurityPasswordReset(false);
    setAuthCallbackStatus('idle');
    setAuthCallbackMessage(null);
    setPendingReaderTarget(null);
    setCurrentView('home');
    clearReaderUrlParams();
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

  if (isCheckingKey || isHydratingProject || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-blue">
        <Loader2 className="w-12 h-12 text-white animate-spin" />
      </div>
    );
  }

  // Protection: studio and reader views require an authenticated user.
  const isProtectedViewStrict = ['dashboard', 'editor', 'reader', 'test', 'learn', 'settings', 'comicforge'].includes(currentView);
  const effectiveView: AppView = !user && isProtectedViewStrict ? 'auth' : currentView;

  const activeProject = activeProjectId ? getProject(activeProjectId) : undefined;
  const showSharedHeader = effectiveView !== 'home' && effectiveView !== 'reader' && effectiveView !== 'shared';
  const showSharedLegalLinks = effectiveView !== 'home' && effectiveView !== 'reader' && effectiveView !== 'shared';
  const showUniversalAssistant = effectiveView !== 'auth-callback' && effectiveView !== 'shared';

  return (
    <ErrorBoundary>
      <div className="min-h-screen font-sans relative bg-slate-50">
        {showSharedHeader && (
          <StaticSiteHeader
            isAuthenticated={!!user}
            onGoHome={handleBackToHome}
            onViewComics={() => handleNavigate('gallery')}
            onEnterStudio={() => handleNavigate('dashboard')}
            onEnterComicForge={() => handleNavigate('comicforge')}
            onSignIn={() => handleNavigate('auth')}
            onOpenProfile={() => {
              setSettingsTab('profile');
              setSettingsReturnView(currentView);
              setCurrentView('settings');
            }}
            onNavigate={handleNavigate}
          />
        )}

        <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-brand-blue"><Loader2 className="w-12 h-12 text-white animate-spin" /></div>}>
          {/* Views */}
          {effectiveView === 'home' && (
            <HomePage
              onEnterStudio={() => (user ? setCurrentView('dashboard') : setCurrentView('auth'))}
              onViewComics={() => setCurrentView('gallery')}
              onOpenProfile={() => {
                setSettingsTab('profile');
                setSettingsReturnView('home');
                setCurrentView('settings');
              }}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
              onOpenUpgrade={() => {
                setSettingsTab('billing');
                setSettingsReturnView('home');
                setCurrentView('settings');
              }}
              onNavigate={handleNavigate}
            />
          )}

          {effectiveView === 'auth' && (
            <AuthPage
              onLoginSuccess={() => {
                if (pendingReaderTarget) {
                  const target = pendingReaderTarget;
                  setPendingReaderTarget(null);
                  void navigateToReader(target.id, target.returnView);
                  return;
                }
                setCurrentView('dashboard');
              }}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
            />
          )}

          {effectiveView === 'auth-callback' && (
            <AuthCallbackPage
              status={authCallbackStatus === 'idle' ? 'verifying' : authCallbackStatus}
              message={authCallbackMessage || undefined}
              flowType={authCallbackFlow}
              onContinue={handleAuthCallbackContinue}
            />
          )}

          {effectiveView === 'gallery' && (
            <PublicGallery
              onBack={handleBackToHome}
              onRequireAuth={() => setCurrentView('auth')}
              onReadComic={(id) => {
                void navigateToReader(id, 'gallery');
              }}
            />
          )}

          {effectiveView === 'privacy' && (
            <PrivacyPolicy onBack={() => (user ? setCurrentView('dashboard') : setCurrentView('home'))} />
          )}

          {effectiveView === 'terms' && (
            <TermsOfService onBack={() => (user ? setCurrentView('dashboard') : setCurrentView('home'))} />
          )}

          {effectiveView === 'dashboard' && (
            <ProjectDashboard
              projects={projects}
              onCreateProject={handleCreateProject}
              onOpenProject={handleOpenProject}
              onDeleteProject={deleteProject}
              onDuplicateProject={duplicateProject}
              onReadProject={handleReadProject}
              onUpdateProject={updateProject}
              onNavigate={handleNavigate}
            />
          )}

          {effectiveView === 'test' && (
            <TestLab
              onCreateProject={(name) => createProject(name)}
              onUpdateProject={updateProject}
              onOpenProject={(id) => {
                setActiveProjectId(id);
                setCurrentView('editor');
              }}
            />
          )}

          {effectiveView === 'learn' && (
            <LearnHub onLaunchTestLab={() => setCurrentView('test')} />
          )}

          {effectiveView === 'editor' && activeProject && (
            <ComicEditor
              project={activeProject}
              onUpdate={(updates) => updateProject(activeProject.id, updates)}
              onStartGeneration={startGeneration}
              onStopGeneration={stopGeneration}
              onBack={() => setCurrentView('dashboard')}
            />
          )}

          {effectiveView === 'comicforge' && (
            <ComicForgeStudio
              projects={projects}
              activeProject={activeProject}
              onCreateProject={createProject}
              onOpenProject={(id) => handleOpenProject(id, 'comicforge')}
              onUpdateProject={updateProject}
              onBack={() => setCurrentView('dashboard')}
            />
          )}

          {effectiveView === 'reader' && (
            <ComicReader
              project={projects.find((project) => project.id === activeProjectId) || publicProject!}
              onClose={handleCloseReader}
              onUpdateProject={updateProject}
              isReadOnly={!!publicProject}
              onNavigate={handleNavigate}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
              onOpenFaq={handleOpenFaq}
            />
          )}

          {effectiveView === 'profile' && viewedProfile && (
            <PublicProfile
              username={viewedProfile}
              onNavigate={handleNavigate}
            />
          )}

          {effectiveView === 'settings' && (
            <AccountSettings
              onClose={() => {
                if (settingsReturnView === 'reader' && !activeProjectId) {
                  setCurrentView('dashboard');
                  return;
                }
                setCurrentView(settingsReturnView);
              }}
              initialTab={settingsTab}
              onSignedOut={handleSignedOut}
              requireDobCompletion={needsDobCompletion}
              onDobCompletionStatusChange={(needsCompletion) => {
                setNeedsDobCompletion(needsCompletion);
              }}
              openPasswordReset={openSecurityPasswordReset}
              onPasswordResetHandled={() => setOpenSecurityPasswordReset(false)}
              onNavigate={handleNavigate}
            />
          )}

          {effectiveView === 'shared' && shareToken && (
            <SharedViewer
              shareToken={shareToken}
              onNavigate={handleNavigate}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
              onOpenFaq={handleOpenFaq}
            />
          )}
        </Suspense>

        {showSharedLegalLinks && (
          <LegalMicroLinks
            onOpenPrivacy={() => setCurrentView('privacy')}
            onOpenTerms={() => setCurrentView('terms')}
            onOpenFaq={handleOpenFaq}
          />
        )}

        {showUniversalAssistant && (
          <UniversalAssistant
            currentView={effectiveView}
            activeProject={activeProject}
            projects={projects}
          />
        )}
      </div>
    </ErrorBoundary>
  );
};

export default App;
