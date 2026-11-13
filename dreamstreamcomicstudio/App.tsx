import React, { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import { clearReaderUrlParams, readerDeepLinkId, setReaderUrlParams } from './services/readerUrl';
import { assistantChrome } from './services/assistantChrome';
import { HomePage } from './components/HomePage';
import { lazyImportWithRetry } from './services/lazyImportWithRetry';
// Lazy Load Heavy Components
const ProjectDashboard = lazyImportWithRetry(() => import('./components/ProjectDashboard').then(module => ({ default: module.ProjectDashboard })));
const ComicEditor = lazyImportWithRetry(() => import('./components/ComicEditor').then(module => ({ default: module.ComicEditor })));
const ComicReader = lazyImportWithRetry(() => import('./components/ComicReader').then(module => ({ default: module.ComicReader })));
const LearnHub = lazyImportWithRetry(() => import('./components/LearnHub').then(module => ({ default: module.LearnHub })));
const PublicGallery = lazyImportWithRetry(() => import('./components/PublicGallery').then(module => ({ default: module.PublicGallery })));
const PublicProfile = lazyImportWithRetry(() => import('./components/PublicProfile').then(module => ({ default: module.PublicProfile })));
const AccountSettings = lazyImportWithRetry(() => import('./components/AccountSettings').then(module => ({ default: module.AccountSettings })));
const PrivacyPolicy = lazyImportWithRetry(() => import('./components/PrivacyPolicy').then(module => ({ default: module.PrivacyPolicy })));
const TermsOfService = lazyImportWithRetry(() => import('./components/TermsOfService').then(module => ({ default: module.TermsOfService })));
const SharedViewer = lazyImportWithRetry(() => import('./components/SharedViewer').then(module => ({ default: module.SharedViewer })));
const PageStudio = lazyImportWithRetry(() => import('./components/pagestudio/PageStudio').then(module => ({ default: module.PageStudio })));
// Comic Studio v4 — the conversational studio (docs/features/comic-studio-v4.md).
const ComicStudio = lazyImportWithRetry(() => import('./components/comicstudio/ComicStudio').then(module => ({ default: module.ComicStudio })));
const ModelLibrary = lazyImportWithRetry(() => import('./components/ModelLibrary').then(module => ({ default: module.ModelLibrary })));
const AIChatPlatform = lazyImportWithRetry(() => import('./components/chat/AIChatPlatform').then(module => ({ default: module.AIChatPlatform })));
const OperatorConsoleView = lazyImportWithRetry(() => import('./components/ventures/OperatorConsole').then(module => ({ default: module.OperatorConsole })));
// Comic Studio's own front page on comics.dreamstreamstudio.ai (components/comicshost).
const ComicsLanding = lazyImportWithRetry(() => import('./components/comicshost/ComicsLanding').then(module => ({ default: module.ComicsLanding })));
// The public, read-only share reader for /c/<slug> (sharing.md §7.1).
const PublicComicReader = lazyImportWithRetry(() => import('./components/comicstudio/PublicComicReader').then(module => ({ default: module.PublicComicReader })));
// Font QA lab (per-script lettering faces) — development builds only; production never ships the chunk.
const FontLab = import.meta.env.DEV
  ? lazyImportWithRetry(() => import('./components/comicstudio/i18n/FontLab').then(module => ({ default: module.FontLab })))
  : null;

import { useProjectManager } from './hooks/useProjectManager';
import { checkSystemDiagnostics, checkSystemStatus } from './services/geminiService';
import { getFluxKeyInfo } from './services/appSettings';
import { useAuth } from './contexts/AuthContext';
import { useIsAdmin } from './hooks/useIsAdmin';
import { useAdminAccess } from './components/account/useAdminAccess';
import { useProductAccess, PRODUCT_LABELS, type ProductId } from './services/productAccess';
import { AuthPage } from './components/AuthPage';
import { AuthCallbackPage } from './components/AuthCallbackPage';
import { getPrivateProfile, getPublicProject, incrementViewCount } from './services/db';
import { setPendingChatModel } from './services/chatStorage';
import { getLocalOwner } from './services/localOwner';
import { captureInviteCodeFromUrl, clearPendingInviteCode, getPendingInviteCode, redeemInvite } from './services/invites';
import { persistUiState } from './services/viewState';
import { isSettingsTab, type SettingsTab } from './components/settingsTabs';
import {
  COMIC_STUDIO_URL_VIEW,
  isStudioV4Project,
  normalizeStudioDeepLinkUrl,
  resolveProjectView,
  resolveStudioDeepLink,
  routeStudioDeepLink,
  studioViewToUrlParam,
  type StudioDeepLinkView
} from './services/studioDeepLink';
import { createStudioProject } from './components/comicstudio/studioApi';
import type { NewComicMode } from './components/ProjectDashboard';
import { StudioErrorBoundary } from './components/studio/kit/ErrorBoundary';
import { Project } from './types';
import { Lock } from 'lucide-react';
import { cn } from './lib/utils';
import { CANVAS_BG, INK, Z } from './components/chat/studioDesign';
import { Button } from './components/ds/Button';
import { EmptyState } from './components/ds/EmptyState';
import { ErrorState } from './components/ds/ErrorState';
import { LoadingState } from './components/ds/LoadingState';
import { toast, ToastHost, TOAST_DURATION_MS } from './components/ds/Toast';
import { SystemDiagnosticsResponse } from './apiTypes';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { AppStatusBar } from './components/status/AppStatusBar';
import { installAppStatusCapture } from './services/appStatus';
import { StaticSiteHeader } from './components/layout/StaticSiteHeader';
import { ComicsHeader } from './components/comicshost/ComicsHeader';
import { LegalMicroLinks } from './components/layout/LegalMicroLinks';
import { FeedbackWidget } from './components/feedback/FeedbackWidget';
import { useComicsHost } from './components/comicshost/useComicsHost';
import { resolveProjectOpen } from './services/projectOpen';
import { comicsChromeFor } from './components/comicshost/hostRouting';
import { isPublicComicPath, parsePublicComicPath, type PublicComicRoute } from './components/comicstudio/reader/publicComicRoute';
import { subscribeKeyboardInset } from './components/comicstudio/mobile/useKeyboardInset';
import { STREAM_HOST_ON, STREAM_ORIGIN, isStreamUrl } from './shared/streamHost';
import { openLiveApp } from './services/liveLink';
import { mainAppUrl } from './services/productHost';
import { safeNext } from './services/safeNext';
import { useAuthLinkCallback } from './hooks/useAuthLinkCallback';
// Lazy so its markdown renderer (react-markdown ≈ 158 kB) isn't pulled into the
// first-paint bundle — the floating assistant isn't needed for initial render.
const UniversalAssistant = lazyImportWithRetry(() => import('./components/UniversalAssistant').then(module => ({ default: module.UniversalAssistant })));
// Global right-click / text-selection "Ask the AI" quick-finder. Lazy so its chat
// streaming + popover code isn't in the first-paint bundle.
const QuickFinder = lazyImportWithRetry(() => import('./components/QuickFinder').then(module => ({ default: module.QuickFinder })));

type AppView =
  | 'home'
  | 'auth'
  | 'auth-callback'
  | 'dashboard'
  | 'editor'
  | 'reader'
  | 'learn'
  | 'gallery'
  | 'models'
  | 'chat'
  | 'settings'
  | 'privacy'
  | 'terms'
  | 'profile'
  | 'pagestudio'
  | 'comicstudio'
  | 'ventures'
  | 'shared'
  // The public, read-only share reader: /c/<slug>[/<title-tail>|/embed]. Its own URL; no suite chrome.
  | 'publiccomic'
  // Development-only font lab (?view=fontlab).
  | 'fontlab';

// Top-level views whose identity is persisted in the URL (?view=) so a refresh restores the page.
// Path/param-managed views (reader, shared, auth-callback, models) are intentionally excluded —
// they have their own URL handling and must not be clobbered.
// (editor/pagestudio/comicstudio/profile are excluded: they need a loaded project/profile that
//  isn't encoded here, so restoring them blind would render a broken page — they fall back to home.
//  Project workspaces restore through the ?view=…&id= deep-link path instead.)
const RESTORABLE_VIEWS = new Set<AppView>([
  'dashboard', 'chat', 'ventures', 'gallery', 'learn', 'privacy', 'terms', 'settings',
]);

/** Where to send the user after they sign in (see the ?next= hand-back below). */
const POST_LOGIN_NEXT_KEY = 'ds.postLoginNext';
/** A ?next= on this page, or one remembered across sign-in, is about to be followed. */
const hasPendingNext = (): boolean => {
  if (safeNext(new URLSearchParams(window.location.search).get('next'))) return true;
  try {
    return !!localStorage.getItem(POST_LOGIN_NEXT_KEY);
  } catch {
    return false;
  }
};


type PendingReaderTarget = {
  id: string;
  returnView: AppView;
};

type PendingStudioTarget = {
  id: string;
  view: StudioDeepLinkView;
  source: 'id' | 'board';
};

/** Project workspaces whose identity lives in the URL as ?view=<workspace>&id=<projectId>. */
const PROJECT_WORKSPACE_VIEWS = new Set<AppView>(['editor', 'pagestudio', 'comicstudio']);
// ('comicstudio' is the accepted alias of ?view=studio — see studioViewFromUrlParam.)
const PROJECT_WORKSPACE_URL_VIEWS = new Set<string>(['editor', 'pagestudio', COMIC_STUDIO_URL_VIEW, 'comicstudio']);

// Which product each gated view belongs to. Views not listed here (home, gallery,
// reader, models, settings, legal, …) stay open to every signed-in account — only the
// product work surfaces are confined.
const VIEW_PRODUCT: Partial<Record<AppView, ProductId>> = {
  chat: 'chat_studio',
  dashboard: 'comic_studio',
  editor: 'comic_studio',
  pagestudio: 'comic_studio',
  comicstudio: 'comic_studio',
};

// Friendly gate for accounts confined to specific studios (product_access rows exist): the DS empty state,
// in plain words, with the way out (Stream Studio when the account has it, else home).
export const ProductGateScreen: React.FC<{ productLabel: string; canStream: boolean; onGoHome: () => void }> = ({ productLabel, canStream, onGoHome }) => (
  <div data-slot="product-gate" className="mx-auto flex min-h-[70vh] w-full max-w-xl items-center px-4 py-12">
    <EmptyState
      as="h2"
      className="w-full"
      icon={<Lock />}
      title={`This account doesn’t include ${productLabel}`}
      description={`Your account is set up for specific studios. Ask your admin to enable ${productLabel} for you.`}
      action={canStream ? { label: 'Open Stream Studio', onClick: () => { void openLiveApp('/live.html'); } } : { label: 'Back to home', onClick: onGoHome }}
      secondaryAction={canStream ? { label: 'Back to home', onClick: onGoHome } : undefined}
    />
  </div>
);

// Calm full-screen loader: the page canvas (light or dark, never a flash of colour) with the DS loading
// state, so a lazy-route switch or the auth check reads as "loading content", not "losing the app". It
// matches index.html's first-paint splash, so the hand-over from the splash does not jump.
export const AppLoader: React.FC<{ label?: string }> = ({ label }) => (
  <div data-slot="app-loader" aria-busy="true" className={cn('flex min-h-screen flex-col items-center justify-center px-4', CANVAS_BG, INK)}>
    <LoadingState variant="inline" title={label || 'Loading…'} />
  </div>
);

// A page that could not open (a private or missing comic, a broken editor link): the DS error state on
// the canvas, the reason in plain words, Try again (a reload) and Dismiss (back to the app as it was).
export const SystemErrorScreen: React.FC<{ message: string; onRetry: () => void; onDismiss: () => void }> = ({ message, onRetry, onDismiss }) => (
  <div data-slot="system-error" className={cn('flex min-h-screen items-center justify-center p-4', CANVAS_BG, INK)}>
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <ErrorState as="h2" className="w-full" title="That didn’t open" description={message} retryLabel="Try again" onRetry={onRetry} />
      <Button variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  </div>
);

// Views still painted with the legacy kit that lean on the root for their light page: they keep that
// light page in both themes (the legacy-kit pages keep their light surfaces in dark, atlas-skin.md D5)
// until their package moves them onto tokens (the dashboard DS-R4, Learn DS-4, the classic editor D4).
// Every other view sits on the canvas token, light or dark.
export const LEGACY_PAPER_VIEWS: ReadonlySet<string> = new Set(['dashboard', 'learn', 'editor', 'fontlab']);
/** The root's page under the views: the canvas token, or the legacy light page for the views above. */
export const appRootSurface = (view: string): string => (LEGACY_PAPER_VIEWS.has(view) ? 'bg-slate-50' : CANVAS_BG);
/**
 * The root div's classes. A gated view (product_access) shows the product gate, which is on the DS, so it
 * always sits on the canvas, even for a legacy-paper view such as the dashboard. The comics host's own views
 * (`comicsChrome`: the landing, sign-in, Privacy, Terms and the Library; hostRouting.ts
 * comicsChromeFor) sit on the canvas too and the root owns their ink, so nothing under it inherits the body's
 * (the light theme's ink in both themes, index.html).
 */
export const appRootClass = (view: string, gated: boolean, comicsChrome = false): string =>
  cn('relative min-h-screen font-sans', gated || comicsChrome ? CANVAS_BG : appRootSurface(view), comicsChrome && INK);

const App: React.FC = () => {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = useIsAdmin();
  // Diagnostics are admin-only: gated on the server's answer for THIS account (bound to the
  // user id, so an account switch never runs the check on the previous account's answer).
  const diagnosticsAdmin = useAdminAccess(user?.id).isAdmin;
  // Per-account studio confinement (product_access). null = unrestricted/unknown → allow.
  const allowedProducts = useProductAccess();
  const streamOnlyRedirectedRef = useRef(false);
  const { projects, projectsLoaded, createProject, updateProject, deleteProject, duplicateProject, getProject, startGeneration, stopGeneration, hydrateProjectAssets, reloadProjects } = useProjectManager();

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
  const [newComicRequested, setNewComicRequested] = useState(false);
  const consumeNewComicRequest = useCallback(() => setNewComicRequested(false), []);

  // Simple routing state. A /c/<slug> share link is decided before the first paint (no flash of the
  // home page under the reader's boot card).
  const [publicComicRoute] = useState<PublicComicRoute | null>(() => (typeof window === 'undefined' ? null : parsePublicComicPath(window.location.pathname)));
  const [currentView, setCurrentView] = useState<AppView>(() => (publicComicRoute ? 'publiccomic' : 'home'));
  // comics.dreamstreamstudio.ai = Comic Studio's own host: signed-in visitors boot into their comics,
  // signed-out ones see the Comic Studio landing, other products open on the main site. Inert elsewhere.
  const comicsHost = useComicsHost({ view: currentView, setView: setCurrentView, signedIn: !!user, ready: !authLoading && !isCheckingKey });
  // Full-screen surfaces size to the visible height (--app-h) and keep sheets above the keyboard (--kb).
  // App only needs the CSS variables, so it attaches the shared store without subscribing to its
  // value: a keyboard animation or a viewport pan never re-renders the whole app tree.
  const keyboardInsetHost = currentView === 'comicstudio' || currentView === 'reader' || currentView === 'publiccomic';
  useEffect(() => (keyboardInsetHost ? subscribeKeyboardInset(() => undefined) : undefined), [keyboardInsetHost]);

  // Connector OAuth popup relay: when THIS page was opened as the Google consent popup
  // (window.opener is set) and the callback bounced back with a result, post it to the
  // opener (the Connectors UI in Chat settings) and close — independent of the active
  // view, so it works now that Connectors lives in a settings tab rather than its own page.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.opener || window.opener === window) return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('connector_error');
    if (!connected && !error) return;
    // Stream Studio on its own host opens this popup too (Drive saving): tell it as well.
    // The payload is only a nudge — the opener re-reads its status from the server.
    for (const target of STREAM_HOST_ON ? [window.location.origin, STREAM_ORIGIN] : [window.location.origin]) {
      try {
        window.opener.postMessage({ type: 'connector-oauth-result', connected, error }, target);
      } catch {
        /* cross-origin opener; the opener's own polling will reconcile on close */
      }
    }
    window.close();
  }, []);

  // Standalone Stream Studio accounts (confined, and stream_studio is the ONLY active
  // product) live in Stream Studio — send them there once (signed in, when it has its own
  // host) instead of showing a suite they can't use. The ref guards against repeat
  // assignments while the SPA stays mounted; Stream Studio is a separate entry point, so no
  // redirect loop is possible. Admins are never gated (their probe may still be resolving,
  // so the check stays in the deps).
  useEffect(() => {
    if (streamOnlyRedirectedRef.current) return;
    if (publicComicRoute) return; // a share link is read by anyone, whatever their account can do
    if (authLoading || !user || isAdmin) return;
    if (!allowedProducts) return; // unrestricted or still unknown
    if (allowedProducts.size === 1 && allowedProducts.has('stream_studio')) {
      streamOnlyRedirectedRef.current = true;
      // A pending ?next= hand-back takes them where they asked to go (two at once would race).
      if (hasPendingNext()) return;
      void openLiveApp('/live.html', { replace: true });
    }
  }, [authLoading, user, isAdmin, allowedProducts]);

  // Post-login hand-back: sub-apps link here with ?next=<same-origin path> — or, with
  // Stream Studio on its own host, ?next=https://stream.dreamstreamstudio.ai/#/<screen>
  // ("Continue with DreamStream") — to attach the suite account, then come straight
  // back (signed in, via the handoff, for Stream Studio). The target is remembered across
  // the whole auth round trip (localStorage survives the magic-link tab) and expires after
  // 15 minutes so a stale value can't ambush a later, unrelated sign-in.
  useEffect(() => {
    if (authLoading) return;
    // A share link never turns into a sign-in page (it is read-only, for anyone).
    if (publicComicRoute) return;
    // An emailed or handoff sign-in link finishes in the /auth/callback handler, which
    // follows its own `next` once the link is verified.
    if (window.location.pathname.replace(/\/+$/, '') === '/auth/callback') return;
    const params = new URLSearchParams(window.location.search);
    // Only a path on this site (normalised) or, with its own host, Stream Studio's address.
    const next = safeNext(params.get('next'));
    if (!next) return;
    try {
      localStorage.setItem(POST_LOGIN_NEXT_KEY, JSON.stringify({ path: next, at: Date.now() }));
    } catch { /* storage unavailable */ }
    if (!user) goToAuth('signin');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);
  useEffect(() => {
    if (!user) return;
    // A share link is never redirected away; a pending hand-back waits for the next app load.
    if (publicComicRoute) return;
    let saved: { path?: string; at?: number } | null = null;
    try {
      const raw = localStorage.getItem(POST_LOGIN_NEXT_KEY);
      saved = raw ? (JSON.parse(raw) as { path?: string; at?: number }) : null;
    } catch {
      saved = null;
    }
    if (!saved?.path) return;
    try {
      localStorage.removeItem(POST_LOGIN_NEXT_KEY);
    } catch { /* storage unavailable */ }
    const dest = safeNext(saved.path);
    if (dest && Date.now() - (saved.at ?? 0) < 15 * 60_000) {
      if (isStreamUrl(dest)) void openLiveApp(dest, { replace: true });
      else window.location.replace(dest);
    }
  }, [user]);
  // Which tab the auth page opens on: existing users sign in; everyone else can
  // request early access while new signups are invite-only.
  const [authInitialMode, setAuthInitialMode] = useState<'signin' | 'request-access'>('signin');
  // Bumped by every goToAuth(): AuthPage reads its mode once, at mount, so a header "Sign in" / "Request access"
  // pressed while the sign-in page is already open remounts it on the step asked for (an invite still wins there).
  const [authRequest, setAuthRequest] = useState(0);

  // ── Invite deep link (email → /?invite=CODE) ──────────────────────────────────
  // Capture the code off the URL, keep it across the whole auth round trip
  // (localStorage survives sign-up → email verify → sign-in), and auto-redeem on the
  // first signed-in load — invited people never have to type the code by hand.
  const inviteRedeemInFlightRef = useRef(false);
  useEffect(() => {
    if (authLoading) return;
    // A share link is read-only for everyone: it never captures or redeems an invite (a crafted
    // /c/<slug>?invite=… must not act on the reader's account). Real invites land on /?invite=.
    if (publicComicRoute) return;
    captureInviteCodeFromUrl();
    const code = getPendingInviteCode();
    if (!code) return;
    if (!user) {
      // Invited visitor without a session → straight to the auth page, where the
      // invite banner explains that creating an account claims the invite.
      if (currentView !== 'auth-callback' && currentView !== 'shared') setCurrentView('auth');
      return;
    }
    if (inviteRedeemInFlightRef.current) return;
    inviteRedeemInFlightRef.current = true;
    void redeemInvite(code).then((result) => {
      inviteRedeemInFlightRef.current = false;
      // Invalid/expired codes are cleared too — a dead code must not retry forever.
      clearPendingInviteCode();
      // The app's one toast slot (components/ds/Toast): a calm card above the tab bar. Accepted: it goes after 8 s;
      // not accepted (expired, used, invalid): it waits for the person, as the old banner did.
      toast({ title: result.message, tone: result.ok ? 'healthy' : 'attention', duration: result.ok ? TOAST_DURATION_MS : 0 });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);
  // Route uncaught errors / rejections / failed loads into the in-app status bar.
  useEffect(() => installAppStatusCapture(), []);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [publicProject, setPublicProject] = useState<Project | null>(null);
  const [viewedProfile, setViewedProfile] = useState<string | null>(null); // username
  const [systemError, setSystemError] = useState<string | null>(null);
  const [pendingReaderTarget, setPendingReaderTarget] = useState<PendingReaderTarget | null>(null);
  // A shared reader link opened cold (?view=read&id=…): held until the reader deep-link effect below has read it,
  // so the URL-sync effect cannot rewrite it to '/' first (which sent every cold shared link to the home page).
  const readerDeepLinkRef = useRef<string | null>(
    typeof window === 'undefined' || isPublicComicPath(window.location.pathname) ? null : readerDeepLinkId(window.location.search)
  );
  const [pendingStudioTarget, setPendingStudioTarget] = useState<PendingStudioTarget | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const hasWarnedDobProfileCheckRef = useRef(false);

  const handleBackToHome = () => {
    setNewComicRequested(false);
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

  // The FAQ lives on the main site's home page.
  const handleOpenFaq = () => {
    if (comicsHost.active) {
      window.location.assign(mainAppUrl('/#home-faq'));
      return;
    }
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
    if (local && isStudioV4Project(local)) {
      // v4 comics read in the v4 reader (ComicReader delegates on studioVersion). It loads
      // the doc + signed URLs from /api/comic/public/:id, which also serves the signed-in
      // owner's unpublished comic — so no classic asset hydration here.
      setPublicProject(null);
      setActiveProjectId(id);
      setCurrentView('reader');
      setReaderUrlParams(id);
      return;
    }
    if (local) {
      setIsHydratingProject(true);
      void resolveProjectOpen(() => hydrateProjectAssets(id), () => local)
        .then((opened) => {
          // The comic's full state did not load: stay where the reader was asked for (the hook has said
          // "Couldn't load this comic. Try again."), never a reader on the library card.
          if (opened.outcome === 'stayed') return;
          setPublicProject(null);
          setActiveProjectId(id);
          setCurrentView('reader');
          setReaderUrlParams(id);
        })
        .finally(() => setIsHydratingProject(false));
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
    // Not on a share link: its whole read path runs at the edge, and a console-only status
    // probe must not wake the backend container for every reader (sharing.md §1.4–1.5).
    if (publicComicRoute) return;
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
    } else if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('view') === 'fontlab') {
      setCurrentView('fontlab');
    }
  }, []);

  // Restore the active view from the URL (?view=) on load, so refreshing keeps you on the same
  // section instead of bouncing to the home page. Declared BEFORE the sync effect below so it
  // reads the param before the sync effect can rewrite it. Path/param-managed routes are skipped.
  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/share/') || isPublicComicPath(path) || path === '/models' || path.replace(/\/+$/, '') === '/auth/callback') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'read') return; // reader deep-link handled separately
    if (params.get('view') === 'fontlab') return; // dev-only route, handled above
    const v = params.get('view');
    const studioTarget = resolveStudioDeepLink(params);
    if (studioTarget) {
      if (studioTarget.source === 'board') {
        const normalized = normalizeStudioDeepLinkUrl(new URL(window.location.href), studioTarget);
        window.history.replaceState({}, '', normalized);
      }
      setPendingStudioTarget({ id: studioTarget.id, view: studioTarget.view, source: studioTarget.source });
      return;
    }
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
    // The public share reader owns its URL (?p=, ?lang=, and the immersive reader's own history entry).
    if (currentView === 'reader' || currentView === 'shared' || currentView === 'auth-callback' || currentView === 'models' || currentView === 'publiccomic') return;
    if (isPublicComicPath(window.location.pathname)) return;
    // A cold shared reader link is still waiting for the deep-link effect (it waits for auth): leave its URL alone.
    if (readerDeepLinkRef.current) return;
    try {
      const url = new URL(window.location.href);
      const urlView = url.searchParams.get('view');
      const urlProjectId = url.searchParams.get('id');
      const awaitingStudioDeepLink = !!(
        pendingStudioTarget &&
        urlProjectId === pendingStudioTarget.id &&
        urlView !== null &&
        PROJECT_WORKSPACE_URL_VIEWS.has(urlView) &&
        activeProjectId !== pendingStudioTarget.id
      );
      if (awaitingStudioDeepLink) return;

      if (PROJECT_WORKSPACE_VIEWS.has(currentView) && activeProjectId) {
        url.pathname = '/';
        url.searchParams.set('view', studioViewToUrlParam(currentView as StudioDeepLinkView));
        url.searchParams.set('id', activeProjectId);
        url.searchParams.delete('board');
      } else {
        url.searchParams.delete('id');
        if (currentView === 'home') url.searchParams.delete('view');
        else url.searchParams.set('view', currentView);
      }
      window.history.replaceState({}, '', url);
    } catch { /* history unavailable; navigation still works via state */ }
  }, [currentView, activeProjectId, pendingStudioTarget]);

  useEffect(() => {
    // Never from an email address (anyone can sign up with any address): only the server's
    // admin flag; the server also requireAdmin's /api/system/diagnostics.
    if (!user || !diagnosticsAdmin) {
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
  }, [user?.id, diagnosticsAdmin]);

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

  // Sign-in links (/auth/callback, or the Site URL fallback '/'): a link this browser asked for
  // completes at once; any other link asks "Finish signing in?" first (hooks/useAuthLinkCallback).
  // The hook reads links on those two paths only, so a share link (/c/<slug>) carrying
  // auth-looking params — pasted, tracked or crafted — stays the comic, never an auth screen.
  const authLink = useAuthLinkCallback({
    onOpen: () => setCurrentView('auth-callback'),
    // "Not now": the link is dropped and whoever was signed in stays signed in.
    onDecline: () => setCurrentView(user ? 'dashboard' : 'home'),
  });

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
    // The deep link has been read (opened below, or the URL no longer asks for the reader): the URL-sync effect may run.
    readerDeepLinkRef.current = null;
    if (publicComicRoute) return; // /c/<slug> is its own reader; ?view=read on it means nothing

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
    const immersive = ['auth', 'auth-callback', 'settings', 'chat', 'editor', 'pagestudio', 'comicstudio', 'reader', 'ventures', 'publiccomic'];
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
    if (authLink.status === 'error') {
      setCurrentView('auth');
      authLink.reset();
      return;
    }

    if (authLink.flow === 'recovery') {
      setOpenSecurityPasswordReset(true);
      openSettings('security', 'home');
      authLink.reset();
      return;
    }

    if (pendingReaderTarget) {
      const target = pendingReaderTarget;
      setPendingReaderTarget(null);
      void navigateToReader(target.id, target.returnView);
    } else {
      setCurrentView('dashboard');
    }

    authLink.reset();
  };

  const handleNavigate = (view: string, id?: string) => {
    setNewComicRequested(false);
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

    if (view === 'comicstudio' && id) {
      clearReaderUrlParams();
      openComicStudio(id);
      return;
    }

    if (view === 'home') {
      handleBackToHome();
      return;
    }

    if (
      view === 'dashboard' ||
      view === 'auth' ||
      view === 'learn' ||
      view === 'gallery' ||
      view === 'models' ||
      view === 'chat' ||
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

  const handleBrowseComicsLibrary = () => {
    // The header's Library destination closes a bundled sample too, even when the app view is unchanged.
    const url = new URL(window.location.href);
    if (url.searchParams.has('sample')) {
      url.searchParams.delete('sample');
      url.searchParams.set('view', 'gallery');
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    if (currentView !== 'gallery') handleNavigate('gallery');
  };

  const handleStartCreating = () => {
    // Route through the existing auth/product gate. Opening the form does not create a project.
    handleNavigate('dashboard');
    setNewComicRequested(true);
  };

  const goToAuth = (mode: 'signin' | 'request-access' = 'signin') => {
    setAuthInitialMode(mode);
    setAuthRequest((n) => n + 1);
    handleNavigate('auth');
  };

  const handleStartChatWithModel = (model: { id: string; name: string; source: 'openrouter' | 'nvidia' }) => {
    setPendingChatModel(model);
    clearReaderUrlParams();
    setCurrentView('chat');
  };

  // Comic Studio v4 is a full-bleed workspace keyed by project id. It loads (and owns)
  // its document through /api/comic, so nothing is hydrated client-side first; the server
  // enforces ownership and the studio shows a friendly not-found when the id isn't ours.
  const openComicStudio = (id: string) => {
    setPublicProject(null);
    setActiveProjectId(id);
    setCurrentView('comicstudio');
  };

  // Leaving the studio: back to the dashboard with a fresh project list, so the card shows
  // the title, cover thumbnail and page progress the server mirrored while the user worked.
  const leaveComicStudio = () => {
    setActiveProjectId(null);
    setCurrentView('dashboard');
    void reloadProjects();
  };

  // New comics start in the conversational studio. The server creates the projects row +
  // the comic_docs row in one call; failures reject with a user-safe message the dashboard
  // shows inline (offline, expired session, studio storage unavailable…).
  const handleCreateProject = async (name: string, mode: NewComicMode = 'studio'): Promise<void> => {
    if (mode === 'studio') {
      const { projectId } = await createStudioProject({ title: name.trim() || undefined });
      openComicStudio(projectId);
      // The server created the listing row; pick it up in the background so every way
      // back to the dashboard lists the new comic.
      void reloadProjects();
      return;
    }
    const pipelineMode = mode === 'pagestudio' ? 'pagestudio' : 'classic';
    const newProject = createProject(name.trim() || 'Untitled comic');
    updateProject(newProject.id, (prev) => ({
      state: { ...prev.state, pipelineMode }
    }));
    setActiveProjectId(newProject.id);
    setCurrentView(pipelineMode === 'pagestudio' ? 'pagestudio' : 'editor');
  };

  // Classic editor banner → "Open this story in the new studio": the banner already
  // created the imported v4 project; open it (and list it, as for a new comic).
  const handleOpenInNewStudio = (newProjectId: string) => {
    openComicStudio(newProjectId);
    void reloadProjects();
  };

  const handleOpenProject = (id: string, expectedPipelineMode?: 'classic' | 'pagestudio') => {
    // v4 studio comics skip the classic asset hydration entirely (their assets are signed
    // by the studio itself) and always open the studio, whatever pipeline was requested.
    if (isStudioV4Project(projects.find((project) => project.id === id))) {
      openComicStudio(id);
      return;
    }
    setIsHydratingProject(true);
    // Stored projects may carry legacy pipeline modes (e.g. the retired 'comicforge'
    // engine) — resolveProjectView coerces anything unknown to the classic editor so old
    // projects still open.
    const routeTo = (project: Project | undefined) => {
      const view = resolveProjectView(project, expectedPipelineMode);
      if (view === 'comicstudio') openComicStudio(id);
      else setCurrentView(view);
    };
    void resolveProjectOpen(() => hydrateProjectAssets(id), () => projects.find((candidate) => candidate.id === id))
      .then((opened) => {
        // The comic's full state did not load (EGRESS-DB E1: the library holds only its card). Stay on the library:
        // the hook has said "Couldn't load this comic. Try again.", and a workspace on a card would show a comic
        // with pieces missing and refuse every change. Opening it again retries.
        if (opened.outcome === 'stayed') return;
        if (opened.outcome === 'opened' && activeProjectId && !projects.find((project) => project.id === activeProjectId)) {
          setPublicProject(null);
        }
        setActiveProjectId(id);
        // Route off the freshly hydrated project (not the stale render-time snapshot), so a migrated/updated
        // pipelineMode opens the correct workspace. When only the image signing failed, the comic is whole and
        // still opens, best-effort, from the copy in memory.
        routeTo(opened.project);
      })
      .finally(() => setIsHydratingProject(false));
  };

  useEffect(() => {
    // A share link never turns into a studio deep link (or a sign-in page for one).
    if (publicComicRoute) return;
    let target = pendingStudioTarget;
    if (!target) {
      const params = new URLSearchParams(window.location.search);
      const studioTarget = resolveStudioDeepLink(params);
      if (studioTarget) {
        target = { id: studioTarget.id, view: studioTarget.view, source: studioTarget.source };
        if (studioTarget.source === 'board') {
          const normalized = normalizeStudioDeepLinkUrl(new URL(window.location.href), studioTarget);
          window.history.replaceState({}, '', normalized);
        }
        setPendingStudioTarget(target);
      }
    }
    if (!target) return;
    if (authLoading || isCheckingKey) return;

    if (!user) {
      if (currentView !== 'auth') setCurrentView('auth');
      return;
    }

    if (currentView === target.view && activeProjectId === target.id) {
      setPendingStudioTarget(null);
      return;
    }

    if (!projectsLoaded) return;

    setPendingStudioTarget(null);
    const route = routeStudioDeepLink(projects, target);
    if (route.kind === 'missing') {
      setSystemError('Comic project not found for this editor link.');
      return;
    }
    if (route.kind === 'comicstudio') {
      openComicStudio(route.id);
      return;
    }
    handleOpenProject(route.project.id, route.pipelineMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStudioTarget, authLoading, isCheckingKey, user?.id, projectsLoaded, projects, currentView, activeProjectId]);

  // Workspace guards. 'comicstudio' needs a project id (nothing to show without one), and a
  // v4 comic must never sit in the classic editor/Page Studio: they would render an empty
  // wizard over it and their autosave would rewrite the server-mirrored listing state.
  useEffect(() => {
    if (currentView === 'comicstudio' && !activeProjectId) {
      setCurrentView(user ? 'dashboard' : 'home');
      return;
    }
    if ((currentView === 'editor' || currentView === 'pagestudio') && activeProjectId) {
      if (isStudioV4Project(projects.find((project) => project.id === activeProjectId))) setCurrentView('comicstudio');
    }
  }, [currentView, activeProjectId, projects, user]);

  const handleReadProject = (id: string) => {
    void navigateToReader(id, currentView);
  };

  const handleCloseReader = () => {
    const fallbackView: AppView = publicProject ? 'gallery' : 'dashboard';
    const nextView = returnView && returnView !== 'reader' ? returnView : fallbackView;
    setCurrentView(nextView);
    setActiveProjectId(null);
    clearReaderUrlParams({ replace: true });
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
    authLink.reset();
    setPendingReaderTarget(null);
    setPendingStudioTarget(null);
    setCurrentView('home');
    clearReaderUrlParams();
  };

  if (systemError) {
    return <SystemErrorScreen message={systemError} onRetry={() => window.location.reload()} onDismiss={() => setSystemError(null)} />;
  }

  // The share reader paints at once from its boot card; it never waits for auth or key checks
  // (owner detection catches up through identityReady).
  const publicComicActive = currentView === 'publiccomic' && !!publicComicRoute;
  if (!publicComicActive && (isCheckingKey || isHydratingProject || authLoading || comicsHost.leaving)) {
    return <AppLoader label={comicsHost.leaving ? 'Opening DreamStream…' : isHydratingProject ? 'Opening project…' : 'Loading…'} />;
  }

  // Protection: studio/creation views require an authenticated user. Reading stays open to all.
  // ventures (the Operator Console) only works signed in, so send visitors to sign in first
  // instead of letting them reach a console that fails every call with 401.
  const isProtectedViewStrict = ['dashboard', 'editor', 'learn', 'settings', 'pagestudio', 'comicstudio', 'chat', 'ventures'].includes(currentView);
  const effectiveView: AppView = !user && isProtectedViewStrict ? 'auth' : currentView;

  // Product gate (product_access): confined accounts only reach their active studios.
  // Catches every entry path (nav clicks, URL ?view= restore, internal setCurrentView).
  // null access = unrestricted or still loading → always allow; admins are never gated.
  const gatedProductLabel = (() => {
    if (!user || isAdmin || !allowedProducts) return null;
    if (!(effectiveView in VIEW_PRODUCT)) return null;
    const product = VIEW_PRODUCT[effectiveView];
    if (!product || allowedProducts.has(product)) return null;
    return PRODUCT_LABELS[product];
  })();

  const activeProject = activeProjectId ? getProject(activeProjectId) : undefined;
  // The editor is a focused, full-screen workspace with its own
  // back/title bars, so we hide the global site header there (was a 3rd stacked header).
  // The v4 Comic Studio is full-bleed too (its own header with back, title and Read).
  // The comics host's own chrome for this view (components/comicshost/hostRouting.ts, unit-tested there): whether the
  // suite header steps aside, whether App draws ComicsHeader, whether the floating widgets may show.
  const chrome = comicsChromeFor(effectiveView, { active: comicsHost.active, signedIn: !!user });
  const comicsChrome = chrome.owns;
  const showSharedHeader = !comicsChrome && !['reader', 'shared', 'editor', 'pagestudio', 'comicstudio', 'publiccomic'].includes(effectiveView);
  const showSharedLegalLinks = effectiveView !== 'home' && effectiveView !== 'reader' && effectiveView !== 'shared' && effectiveView !== 'pagestudio' && effectiveView !== 'comicstudio' && effectiveView !== 'chat' && effectiveView !== 'publiccomic';
  // Where the floating Universal Assistant appears (services/assistantChrome.ts).
  const assistant = assistantChrome(effectiveView);
  // The comics host's own views (the landing; signed out, sign-in, Privacy, Terms and the Library) carry no floating
  // widgets, as the studio carries none: nothing sits over the art or the sign-in form.
  const showUniversalAssistant = assistant.mounted && chrome.widgets;
  // The quick-finder works app-wide (including the chat view — select an answer to
  // explain it), except on the bare auth/share screens.
  const showQuickFinder = effectiveView !== 'auth-callback' && effectiveView !== 'auth' && effectiveView !== 'shared' && effectiveView !== 'publiccomic';
  // The global "Send feedback" pill (bottom-right). Hidden on the immersive chat
  // surface (it has its own inline feedback) and on the bare auth-callback / shared
  // viewer screens.
  // The v4 Comic Studio keeps its composer docked at the bottom, where the pill would sit on it.
  const showFeedbackWidget = chrome.widgets && effectiveView !== 'auth-callback' && effectiveView !== 'shared' && effectiveView !== 'chat' && effectiveView !== 'comicstudio' && effectiveView !== 'publiccomic';
  // Owner detection needs no request: the signed-in user's own listing rows carry their share slug.
  const publicComicIsOwner =
    !!publicComicRoute?.slug &&
    !!user &&
    projects.some((project) => isStudioV4Project(project) && (project.state as unknown as { shareSlug?: unknown })?.shareSlug === publicComicRoute.slug);
  const publicComicIdentityReady = !authLoading && (!user || projectsLoaded);

  const goToStayUpdated = () => {
    setCurrentView('home');
    // Wait for the home view to mount before scrolling to the capture form.
    setTimeout(() => document.getElementById('stay-updated')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
  };

  return (
    <ErrorBoundary>
      {/* The comics host's own views sit on the skin's paper and own their ink (appRootClass), as the landing does. */}
      <div data-slot="app-root" className={appRootClass(effectiveView, Boolean(gatedProductLabel), comicsChrome)}>
        {/* The app's one toast slot: every app toast renders here (portalled to <body>, above the tab bar). */}
        <ToastHost />
        {showSharedHeader && (() => {
          const header = (
            <StaticSiteHeader
              isAuthenticated={!!user}
              isAdmin={isAdmin}
              currentView={effectiveView}
              onGoHome={handleBackToHome}
              onViewComics={() => handleNavigate('gallery')}
              onEnterStudio={() => handleNavigate('dashboard')}
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
              <div className={cn('group sticky top-0 h-0', Z.header)}>
                <div className="absolute inset-x-0 top-0 h-3" />
                <div className="absolute inset-x-0 top-0 -translate-y-full shadow-[shadow:var(--ds-shadow-panel)] transition-transform duration-[var(--ds-motion-medium,200ms)] ease-[var(--ds-ease,cubic-bezier(0.4,0,0.2,1))] focus-within:translate-y-0 group-hover:translate-y-0 motion-reduce:transition-none">
                  {header}
                </div>
              </div>
            );
          }
          return header;
        })()}
        {/* The public Comic Studio journey keeps its header before and after sign-in. The landing renders its own. */}
        {chrome.header && (
          <ComicsHeader
            signedIn={!!user}
            page="other"
            current={chrome.current}
            onGoHome={handleBackToHome}
            onSignIn={() => goToAuth('signin')}
            onRequestAccess={() => goToAuth('request-access')}
            onOpenComics={() => handleNavigate('dashboard')}
            onOpenAccount={() => openSettings('profile')}
            onBrowseGallery={handleBrowseComicsLibrary}
          />
        )}

        {gatedProductLabel ? (
          <ProductGateScreen
            productLabel={gatedProductLabel}
            canStream={!!allowedProducts?.has('stream_studio')}
            onGoHome={handleBackToHome}
          />
        ) : (
        <Suspense fallback={<AppLoader />}>
          {/* Views */}
          {effectiveView === 'home' && (comicsHost.active ? (
            <ComicsLanding
              signedIn={!!user}
              onSignIn={() => goToAuth('signin')}
              onRequestAccess={() => goToAuth('request-access')}
              onOpenComics={() => handleNavigate('dashboard')}
              onStartCreating={handleStartCreating}
              onOpenAccount={() => openSettings('profile')}
              onBrowseGallery={handleBrowseComicsLibrary}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
            />
          ) : (
            <HomePage
              onEnterStudio={() => (user ? setCurrentView('dashboard') : setCurrentView('auth'))}
              onViewComics={() => setCurrentView('gallery')}
              onOpenPrivacy={() => setCurrentView('privacy')}
              onOpenTerms={() => setCurrentView('terms')}
              onNavigate={handleNavigate}
            />
          ))}

          {effectiveView === 'auth' && (
            <AuthPage
              key={`auth-${authRequest}`}
              initialMode={authInitialMode}
              pendingInviteCode={getPendingInviteCode()}
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
              status={authLink.status === 'idle' ? 'verifying' : authLink.status}
              message={authLink.message || undefined}
              flowType={authLink.flow}
              email={authLink.email}
              currentEmail={user?.email ?? null}
              // Signed out here, but an account's data is still on this device (its session ended
              // with its tab): the step must still say that continuing removes it.
              otherAccountOnDevice={!user && !!getLocalOwner()}
              onContinue={handleAuthCallbackContinue}
              onConfirm={authLink.confirm}
              onDecline={authLink.decline}
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
            // Keyed by account: a session for another account (another tab, a confirmed link)
            // remounts the chat with THAT account's rows and memory — never A's chats under B.
            <AIChatPlatform key={user?.id ?? 'signed-out'} projects={projects} onBack={() => setCurrentView(user ? 'dashboard' : 'home')} />
          )}

          {effectiveView === 'ventures' && (
            <Suspense fallback={<div className="min-h-screen bg-neutral-950" />}>
              <OperatorConsoleView isAdmin={isAdmin} onBack={() => setCurrentView(user ? 'dashboard' : 'home')} />
            </Suspense>
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
              openNewComic={newComicRequested}
              onNewComicOpened={consumeNewComicRequest}
              onCreateProject={handleCreateProject}
              onOpenProject={handleOpenProject}
              onDeleteProject={deleteProject}
              onDuplicateProject={duplicateProject}
              onReadProject={handleReadProject}
              onUpdateProject={updateProject}
              onNavigate={handleNavigate}
            />
          )}

          {effectiveView === 'learn' && (
            <LearnHub />
          )}

          {effectiveView === 'editor' && activeProject && !isStudioV4Project(activeProject) && (
            <ComicEditor
              project={activeProject}
              onUpdate={(updates) => updateProject(activeProject.id, updates)}
              onStartGeneration={startGeneration}
              onStopGeneration={stopGeneration}
              onBack={() => setCurrentView('dashboard')}
              onOpenInNewStudio={handleOpenInNewStudio}
            />
          )}

          {effectiveView === 'comicstudio' && activeProjectId && (
            // Full-bleed: the studio lays itself out in a viewport-tall box (h-screen is the
            // fallback where dynamic viewport units aren't supported).
            <div className="h-screen w-full overflow-hidden" style={{ height: 'var(--app-h, 100dvh)' }}>
              <StudioErrorBoundary onBack={leaveComicStudio}>
                <ComicStudio key={activeProjectId} projectId={activeProjectId} onBack={leaveComicStudio} />
              </StudioErrorBoundary>
            </div>
          )}

          {effectiveView === 'pagestudio' && activeProject && !isStudioV4Project(activeProject) && (
            <PageStudio
              project={activeProject}
              onUpdate={(updater) => updateProject(activeProject.id, updater)}
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
              // Keyed by account: settings held from mount are never saved into another account.
              key={user?.id ?? 'signed-out'}
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

          {effectiveView === 'publiccomic' && publicComicRoute && (
            // Full-bleed and sized to the visible height; the reader pads its own safe areas.
            <div className="w-full overflow-hidden bg-[var(--ds-canvas)]" style={{ height: 'var(--app-h, 100dvh)' }}>
              <Suspense fallback={<div className="h-full w-full bg-[var(--ds-canvas)]" role="status" aria-label="Opening the comic" />}>
                <PublicComicReader
                  source={{ kind: 'slug', slug: publicComicRoute.slug, embed: publicComicRoute.embed }}
                  isOwner={publicComicIsOwner}
                  identityReady={publicComicIdentityReady}
                />
              </Suspense>
            </div>
          )}

          {FontLab && effectiveView === 'fontlab' && <FontLab />}

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
        )}

        {showSharedLegalLinks && (
          <LegalMicroLinks
            onOpenPrivacy={() => setCurrentView('privacy')}
            onOpenTerms={() => setCurrentView('terms')}
            // The comics host has no FAQ page (its landing has no #home-faq), so its legal line offers none.
            onOpenFaq={comicsHost.active ? undefined : handleOpenFaq}
          />
        )}

        {showUniversalAssistant && (
          <Suspense fallback={null}>
            <UniversalAssistant
              currentView={effectiveView}
              hideLauncher={assistant.hideLauncher}
              activeProject={activeProject}
              projects={projects}
              onSaveCreativeDirection={activeProject ? (text) => updateProject(activeProject.id, (prev) => ({
                state: { ...prev.state, creativeDirection: [prev.state.creativeDirection, text].filter(Boolean).join('\n\n') }
              })) : undefined}
            />
          </Suspense>
        )}

        {showFeedbackWidget && <FeedbackWidget />}

        {showQuickFinder && (
          <Suspense fallback={null}>
            <QuickFinder
              onAskInChat={(prompt) => {
                // Route the selection into the main chat: switch to it, then seed the
                // composer a beat later so ChatComposer has mounted its listener.
                setCurrentView('chat');
                window.setTimeout(
                  () => window.dispatchEvent(new CustomEvent('dreamstream:compose', { detail: { text: prompt } })),
                  350
                );
              }}
            />
          </Suspense>
        )}

        <AppStatusBar />
      </div>
    </ErrorBoundary>
  );
};

export default App;
