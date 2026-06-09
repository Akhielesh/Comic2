import React, { useCallback, useEffect, useRef, useState, Suspense } from 'react';
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
const PageStudio = lazyImportWithRetry(() => import('./components/pagestudio/PageStudio').then(module => ({ default: module.PageStudio })));
const ModelLibrary = lazyImportWithRetry(() => import('./components/ModelLibrary').then(module => ({ default: module.ModelLibrary })));
const HowItWorks = lazyImportWithRetry(() => import('./components/HowItWorks').then(module => ({ default: module.HowItWorks })));
const AIChatPlatform = lazyImportWithRetry(() => import('./components/chat/AIChatPlatform').then(module => ({ default: module.AIChatPlatform })));
const CodeStudioView = lazyImportWithRetry(() => import('./components/studio/CodeStudioView').then(module => ({ default: module.CodeStudioView })));
const OperatorConsoleView = lazyImportWithRetry(() => import('./components/ventures/OperatorConsole').then(module => ({ default: module.OperatorConsole })));
import { StudioErrorBoundary } from './components/studio/kit/ErrorBoundary';

import { useProjectManager } from './hooks/useProjectManager';
import { checkSystemDiagnostics, checkSystemStatus } from './services/geminiService';
import { getFluxKeyInfo } from './services/appSettings';
import { useAuth } from './contexts/AuthContext';
import { useIsAdmin } from './hooks/useIsAdmin';
import { AuthPage } from './components/AuthPage';
import { AuthCallbackPage } from './components/AuthCallbackPage';
import { supabase } from './services/supabase';
import { getPrivateProfile, getPublicProject, incrementViewCount } from './services/db';
import { setPendingChatModel } from './services/chatStorage';
import { persistUiState } from './services/viewState';
import { isSettingsTab, type SettingsTab } from './components/settingsTabs';
import { useStudioHandoff } from './services/studioHandoff';
import { Project } from './types';
import { Loader2 } from 'lucide-react';
import { SystemDiagnosticsResponse } from './apiTypes';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { StaticSiteHeader } from './components/layout/StaticSiteHeader';
import { LegalMicroLinks } from './components/layout/LegalMicroLinks';
import { FeedbackWidget } from './components/feedback/FeedbackWidget';
// Lazy so its markdown renderer (react-markdown ≈ 158 kB) isn't pulled into the
// first-paint bundle — the floating assistant isn't needed for initial render.
const UniversalAssistant = lazyImportWithRetry(() => import('./components/UniversalAssistant').then(module => ({ default: module.UniversalAssistant })));

type AppView =
  | 'home'
  | 'auth'
  | 'auth-callback'
  | 'dashboard'
  | 'editor'
  | 'reader'
  | 'test'
  | 'learn'
  | 'how-it-works'
  | 'gallery'
  | 'models'
  | 'chat'
  | 'settings'
  | 'privacy'
  | 'terms'
  | 'profile'
  | 'comicforge'
  | 'pagestudio'
  | 'codestudio'
  | 'ventures'
  | 'shared';

// Top-level views whose identity is persisted in the URL (?view=) so a refresh restores the page.
// Path/param-managed views (reader, shared, auth-callback, models) are intentionally excluded —
// they have their own URL handling and must not be clobbered.
// (editor/comicforge/pagestudio/profile are excluded: they need a loaded project/profile that
//  isn't encoded here, so restoring them blind would render a broken page — they fall back to home.)
const RESTORABLE_VIEWS = new Set<AppView>([
  'dashboard', 'chat', 'codestudio', 'ventures', 'gallery', 'learn', 'test', 'how-it-works', 'privacy', 'terms', 'settings',
]);


type AuthCallbackStatus = 'idle' | 'verifying' | 'success' | 'error';
type AuthCallbackFlow = 'magiclink' | 'recovery' | 'signup' | 'unknown';

type PendingReaderTarget = {
  id: string;
  returnView: AppView;
};

// Calm full-screen loader. The old solid-blue flash made every lazy-route switch and
// auth check look like a hard reload; this matches the app surface so transitions read
// as "loading content", not "losing the app".
const AppLoader: React.FC<{ label?: string }> = ({ label }) => (
  <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50">
    <div className="w-14 h-14 rounded-2xl bg-brand-yellow border-4 border-black shadow-comic flex items-center justify-center font-display text-2xl animate-pulse">
      DS
    </div>
    <div className="flex items-center gap-2 text-slate-500 text-sm font-bold">
      <Loader2 className="w-4 h-4 animate-spin" />
      {label || 'Loading…'}
    </div>
  </div>
);

const App: React.FC = () => {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = useIsAdmin();
  // Chat → Code Studio hand-off: opening an app from chat bumps requestId; route here.
  const studioHandoffArtifact = useStudioHandoff((s) => s.artifact);
  const studioHandoffRequestId = useStudioHandoff((s) => s.requestId);
  const { projects, createProject, updateProject, deleteProject, duplicateProject, getProject, startGeneration, stopGeneration, hydrateProjectAssets } = useProjectManager();

  const [isCheckingKey, setIsCheckingKey] = useState(true);
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnosticsResponse | null>(null);
  const [isHydratingProject, setIsHydratingProject] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile');
  // Bumped on every EXPLICIT settings-tab navigation, so AccountSettings applies the
  // request even when the tab value itself didn't change (state alone can't signal
  // "navigate to Profile again" while the user sits on a different inner tab).
  const [settingsTabRequestId, setSettingsTabRequestId] = useState(0);
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

  // When chat (or any surface) hands an app off to Code Studio, route to the studio view.
  // requestId starts at 0 and increments per open(), so this only fires on a real hand-off.
  useEffect(() => {
    if (studioHandoffRequestId > 0) setCurrentView('codestudio');
  }, [studioHandoffRequestId]);
  // Which tab the auth page opens on: existing users sign in; everyone else can
  // request early access while new signups are invite-only.
  const [authInitialMode, setAuthInitialMode] = useState<'signin' | 'request-access'>('signin');
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

  const handleBackToHome = () => {
    setCurrentView('home');
    setActiveProjectId(null);
    clearReaderUrlParams();
  };

  // Single entry point for opening Settings on a specific tab. Writes the tab into the
  // continuity layers FIRST so an explicit intent ("open Security") always beats the
  // remembered last-visited tab when AccountSettings mounts.
  const openSettings = (tab?: SettingsTab, returnTo: AppView = currentView) => {
    if (tab) {
      setSettingsTab(tab);
      setSettingsTabRequestId((n) => n + 1);
      persistUiState('settings.tab', 'tab', tab);
      if (tab !== 'security') setOpenSecurityPasswordReset(false);
    }
    setSettingsReturnView(returnTo);
    setCurrentView('settings');
  };

  const handleOpenFaq = () => {
    handleBackToHome();
    window.setTimeout(() => {
      document.getElementById('home-faq')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 180);
  };

  const navigateToReader = async (id: string, originView: AppView = currentView) => {
    // Comics are free to read for everyone — no login required. Owners load their
    // local copy; everyone else loads the public copy (private comics stay private).
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
    // Surface backend/config problems to the console only — never block entry with a
    // full-screen error. Admins still get actionable details via checkSystemDiagnostics.
    checkSystemStatus()
      .then((res) => {
        if (res.status === 'error') {
          console.warn('System status check returned an error:', res.message || 'Unknown Error');
        }
      })
      .catch((err) => {
        console.warn('System status check failed:', err?.message || err);
      });
  }, []);

  useEffect(() => {

    // Check for share URL: /share/:token
    const path = window.location.pathname;
    const shareMatch = path.match(/^\/share\/([^/]+)$/);
    if (shareMatch && shareMatch[1]) {
      setShareToken(shareMatch[1]);
      setCurrentView('shared');
    } else if (path === '/models') {
      // Public, shareable model catalog — reachable logged-out (no auth gate on 'models').
      setCurrentView('models');
    }
  }, []);

  // Restore the active view from the URL (?view=) on load, so refreshing keeps you on the same
  // section instead of bouncing to the home page. Declared BEFORE the sync effect below so it
  // reads the param before the sync effect can rewrite it. Path/param-managed routes are skipped.
  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/share/') || path === '/models' || path === '/auth/callback') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'read') return; // reader deep-link handled separately
    const v = params.get('view');
    if (v && RESTORABLE_VIEWS.has(v as AppView)) {
      setCurrentView(v as AppView);
      // Deep continuity: ?view=settings&tab=admin restores the exact settings tab too,
      // so a reload (or Chrome discarding the background tab) doesn't bounce the user
      // back to the first tab. AccountSettings keeps ?tab= in sync from then on.
      if (v === 'settings') {
        const tab = params.get('tab');
        if (isSettingsTab(tab)) setSettingsTab(tab);
      }
    }
  }, []);

  // Keep the URL's ?view= in sync with the active view so a refresh restores it. Views that manage
  // their own URL (reader/shared/auth-callback/models) are left untouched. Uses replaceState so it
  // doesn't spam browser history on every transition.
  useEffect(() => {
    if (currentView === 'reader' || currentView === 'shared' || currentView === 'auth-callback' || currentView === 'models') return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('id'); // reader-only param; drop it when not reading
      if (currentView === 'home') url.searchParams.delete('view');
      else url.searchParams.set('view', currentView);
      window.history.replaceState({}, '', url);
    } catch { /* history unavailable; navigation still works via state */ }
  }, [currentView]);

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
    const userId = user?.id;
    if (!userId) {
      setNeedsDobCompletion(false);
      setHasPromptedDobThisSession(false);
      hasWarnedDobProfileCheckRef.current = false;
      return;
    }

    let active = true;
    const checkDob = async () => {
      try {
        const profile = await getPrivateProfile(userId);
        if (!active) return;
        setNeedsDobCompletion(!profile?.dob);
      } catch (err) {
        if (!active) return;
        // Transient fetch failure ≠ missing DOB. Treating errors as "incomplete" used to
        // yank users out of whatever they were doing into Settings → Profile every time
        // the profile endpoint hiccuped (e.g. right after a token refresh on tab focus).
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
  }, [user?.id]);

  // Open shared links (?view=read&id=...) straight into the reader — no login required.
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

  // Reading is free for everyone — a logged-out reader session is allowed to stay open.
  // Login is only required for creating/saving and for social actions (like, comment, share).

  // Prompt existing users to complete DOB in profile settings (non-blocking).
  // Never interrupts immersive work surfaces — losing an in-progress chat/canvas to a
  // forced settings redirect is worse than a delayed DOB nag.
  useEffect(() => {
    if (!user || authLoading || isCheckingKey) return;
    if (!needsDobCompletion || hasPromptedDobThisSession) return;
    const immersive = ['auth', 'auth-callback', 'settings', 'chat', 'codestudio', 'editor', 'comicforge', 'pagestudio', 'reader', 'ventures'];
    if (immersive.includes(currentView)) return;

    setHasPromptedDobThisSession(true);
    openSettings('profile');
  }, [user?.id, authLoading, isCheckingKey, needsDobCompletion, hasPromptedDobThisSession, currentView]);

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
      setOpenSecurityPasswordReset(true);
      openSettings('security', 'home');
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
      openSettings(isSettingsTab(id) ? id : undefined);
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
      view === 'how-it-works' ||
      view === 'gallery' ||
      view === 'models' ||
      view === 'chat' ||
      view === 'comicforge' ||
      view === 'codestudio' ||
      view === 'privacy' ||
      view === 'terms'
    ) {
      clearReaderUrlParams();
      setCurrentView(view as AppView);
      // Give the public catalog a real, shareable URL; other views stay at '/'.
      try {
        const url = new URL(window.location.href);
        url.pathname = view === 'models' ? '/models' : '/';
        window.history.pushState({}, '', url);
      } catch { /* history unavailable; navigation still works via state */ }
    }
  };

  const goToAuth = (mode: 'signin' | 'request-access' = 'signin') => {
    setAuthInitialMode(mode);
    handleNavigate('auth');
  };

  const handleStartChatWithModel = (model: { id: string; name: string; source: 'openrouter' | 'nvidia' }) => {
    setPendingChatModel(model);
    clearReaderUrlParams();
    setCurrentView('chat');
  };

  const handleCreateProject = (name: string, pipelineMode: 'classic' | 'pagestudio' = 'classic') => {
    const newProject = createProject(name);
    // The user explicitly picks the engine at creation (Full comic = Classic, which
    // keeps characters consistent across panels; Quick = single-sheet PageStudio).
    // Default to Classic so multi-panel comics get continuity unless Quick is chosen.
    updateProject(newProject.id, (prev) => ({
      state: { ...prev.state, pipelineMode }
    }));
    setActiveProjectId(newProject.id);
    setCurrentView(pipelineMode === 'pagestudio' ? 'pagestudio' : 'editor');
  };

  const handleOpenProject = (id: string, expectedPipelineMode?: 'classic' | 'comicforge' | 'pagestudio') => {
    setIsHydratingProject(true);
    const routeTo = (mode?: 'classic' | 'comicforge' | 'pagestudio') =>
      setCurrentView(mode === 'comicforge' ? 'comicforge' : mode === 'pagestudio' ? 'pagestudio' : 'editor');
    hydrateProjectAssets(id)
      .then((hydrated) => {
        if (activeProjectId && !projects.find((project) => project.id === activeProjectId)) {
          setPublicProject(null);
        }
        setActiveProjectId(id);
        // Route off the freshly hydrated project (not the stale render-time snapshot),
        // so a migrated/updated pipelineMode opens the correct workspace.
        routeTo(expectedPipelineMode || hydrated?.state.pipelineMode);
      })
      .catch(() => {
        // Hydration failed — still open the project, best-effort on the workspace.
        setActiveProjectId(id);
        routeTo(expectedPipelineMode || projects.find((candidate) => candidate.id === id)?.state.pipelineMode);
      })
      .finally(() => setIsHydratingProject(false));
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

  // Stable identities: AccountSettings keys data-loading effects on these callbacks, so
  // inline arrows here would re-trigger its profile fetch (and a full content blank) on
  // every App re-render.
  const handleDobCompletionStatusChange = useCallback((needsCompletion: boolean) => {
    setNeedsDobCompletion(needsCompletion);
  }, []);
  const handlePasswordResetHandled = useCallback(() => setOpenSecurityPasswordReset(false), []);

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
    return <AppLoader label={isHydratingProject ? 'Opening project…' : 'Loading…'} />;
  }

  // Protection: studio/creation views require an authenticated user. Reading stays open to all.
  const isProtectedViewStrict = ['dashboard', 'editor', 'test', 'learn', 'settings', 'comicforge', 'pagestudio', 'chat', 'codestudio'].includes(currentView);
  const effectiveView: AppView = !user && isProtectedViewStrict ? 'auth' : currentView;

  const activeProject = activeProjectId ? getProject(activeProjectId) : undefined;
  // Editor and ComicForge are focused, full-screen workspaces with their own
  // back/title bars, so we hide the global site header there (was a 3rd stacked header).
  const showSharedHeader = !['reader', 'shared', 'editor', 'comicforge', 'pagestudio', 'codestudio'].includes(effectiveView);
  const showSharedLegalLinks = effectiveView !== 'home' && effectiveView !== 'reader' && effectiveView !== 'shared' && effectiveView !== 'pagestudio' && effectiveView !== 'chat' && effectiveView !== 'codestudio';
  // Hide the floating Universal Assistant on the full-screen chat product to avoid two stacked chat surfaces.
  const showUniversalAssistant = effectiveView !== 'auth-callback' && effectiveView !== 'shared' && effectiveView !== 'chat' && effectiveView !== 'codestudio';
  // The global "Send feedback" pill (bottom-right). Hidden on the immersive chat /
  // code studio surfaces (they have their own inline feedback) and on the bare
  // auth-callback / shared viewer screens.
  const showFeedbackWidget = effectiveView !== 'auth-callback' && effectiveView !== 'shared' && effectiveView !== 'chat' && effectiveView !== 'codestudio';

  const goToStayUpdated = () => {
    setCurrentView('home');
    // Wait for the home view to mount before scrolling to the capture form.
    setTimeout(() => document.getElementById('stay-updated')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen font-sans relative bg-slate-50">
        {showSharedHeader && (() => {
          const header = (
            <StaticSiteHeader
              isAuthenticated={!!user}
              isAdmin={isAdmin}
              currentView={effectiveView}
              onGoHome={handleBackToHome}
              onViewComics={() => handleNavigate('gallery')}
              onEnterStudio={() => handleNavigate('dashboard')}
              onEnterComicForge={() => handleNavigate('comicforge')}
              onSignIn={() => goToAuth('signin')}
              onRequestAccess={() => goToAuth('request-access')}
              onNotify={goToStayUpdated}
              onOpenProfile={() => openSettings('profile')}
              onNavigate={handleNavigate}
            />
          );
          // On the full-screen chat product, the global header auto-hides to reclaim
          // space and slides back down when the cursor reaches the top edge.
          if (effectiveView === 'chat') {
            return (
              <div className="group sticky top-0 z-50 h-0">
                <div className="absolute inset-x-0 top-0 h-3" />
                <div className="absolute inset-x-0 top-0 -translate-y-full group-hover:translate-y-0 focus-within:translate-y-0 transition-transform duration-200 ease-out shadow-lg">
                  {header}
                </div>
              </div>
            );
          }
          return header;
        })()}

        <Suspense fallback={<AppLoader />}>
          {/* Views */}
          {effectiveView === 'home' && (
            <HomePage
              onEnterStudio={() => (user ? setCurrentView('dashboard') : setCurrentView('auth'))}
              onViewComics={() => setCurrentView('gallery')}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
              onNavigate={handleNavigate}
            />
          )}

          {effectiveView === 'auth' && (
            <AuthPage
              initialMode={authInitialMode}
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

          {effectiveView === 'models' && (
            <ModelLibrary onBack={handleBackToHome} onStartChat={handleStartChatWithModel} />
          )}

          {effectiveView === 'chat' && (
            <AIChatPlatform projects={projects} onBack={() => setCurrentView(user ? 'dashboard' : 'home')} />
          )}

          {effectiveView === 'codestudio' && (
            <StudioErrorBoundary onBack={() => setCurrentView(user ? 'dashboard' : 'home')}>
              <CodeStudioView
                artifact={studioHandoffArtifact}
                isAdmin={isAdmin}
                onBack={() => setCurrentView(user ? 'dashboard' : 'home')}
                onNavigate={handleNavigate}
              />
            </StudioErrorBoundary>
          )}

          {effectiveView === 'ventures' && (
            <Suspense fallback={<div className="min-h-screen bg-neutral-950" />}>
              <OperatorConsoleView isAdmin={isAdmin} onBack={() => setCurrentView(user ? 'dashboard' : 'home')} />
            </Suspense>
          )}

          {effectiveView === 'how-it-works' && (
            <HowItWorks
              onBack={handleBackToHome}
              onGetStarted={() => setCurrentView(user ? 'dashboard' : 'auth')}
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

          {effectiveView === 'pagestudio' && activeProject && (
            <PageStudio
              project={activeProject}
              onUpdate={(updater) => updateProject(activeProject.id, updater)}
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
              initialTabRequestId={settingsTabRequestId}
              onSignedOut={handleSignedOut}
              requireDobCompletion={needsDobCompletion}
              onDobCompletionStatusChange={handleDobCompletionStatusChange}
              openPasswordReset={openSecurityPasswordReset}
              onPasswordResetHandled={handlePasswordResetHandled}
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
          <Suspense fallback={null}>
            <UniversalAssistant
              currentView={effectiveView}
              activeProject={activeProject}
              projects={projects}
              onSaveCreativeDirection={activeProject ? (text) => updateProject(activeProject.id, (prev) => ({
                state: { ...prev.state, creativeDirection: [prev.state.creativeDirection, text].filter(Boolean).join('\n\n') }
              })) : undefined}
            />
          </Suspense>
        )}

        {showFeedbackWidget && <FeedbackWidget />}

      </div>
    </ErrorBoundary>
  );
};

export default App;
