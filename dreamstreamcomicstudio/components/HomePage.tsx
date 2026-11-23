import React, { useEffect, useState } from 'react';
import { Sparkles, Zap, Users, BookOpen, Check, HelpCircle, Mail, ChevronRight, MessageSquare, Bot, Shield, Cpu, ArrowRight, Radio } from 'lucide-react';
import { Badge, Button, buttonClasses } from './ds';
import {
  ARROW_NUDGE,
  CHIP,
  CHIP_VARIANT,
  CTA_LG,
  DENSITY,
  DISPLAY_CARD_TITLE,
  DISPLAY_HERO,
  DISPLAY_SECTION,
  FOCUS_RING,
  FONT_DISPLAY,
  HAIRLINE,
  INK_TILE,
  INVERSE_ACTION_QUIET,
  INVERSE_SURFACE,
  LIFT,
  OVERLINE,
  OVERLINE_DISPLAY,
  PUBLIC_BODY,
  PUBLIC_LEAD,
  RADIUS_CONTROL,
  RADIUS_FEATURE,
  RADIUS_HERO,
  RADIUS_ROUND,
  SECTION_ICON_TILE,
  SHADOW_HERO,
  SHADOW_SOFT,
  TRANSITION
} from './chat/studioDesign';
import { cn } from '../lib/utils';
import { followLiveLink, liveAppUrl, openLiveApp } from '../services/liveLink';
import { WaitlistForm } from './WaitlistForm';
import { UPDATES_CARD } from '../shared/interest';
import { useAuth } from '../contexts/AuthContext';
import { comicsEntryUrl } from '../services/productHost';
import { SUPPORT_EMAIL } from './legal/contacts';

interface HomePageProps {
  onEnterStudio: () => void;
  onViewComics: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onNavigate?: (view: string, id?: string) => void;
}

const PROCESS_STAGES = [
  { id: 1, title: "Prompt", desc: "Paste a script, outline, notes, or a rough idea." },
  { id: 2, title: "Plan", desc: "The agent extracts scenes, cast, world, format, and budget." },
  { id: 3, title: "Build", desc: "Generate a locked style, references, cover, and pages." },
  { id: 4, title: "Polish", desc: "Edit panels, audit continuity, read, share, and export." }
];

const CHAT_FEATURES = [
  { icon: <Cpu size={16} />, text: "100+ models — Claude, Gemini, GPT & more" },
  { icon: <Sparkles size={16} />, text: "Real-time streaming responses" },
  { icon: <Shield size={16} />, text: "Rich outputs: charts, maps, weather & more" },
  { icon: <BookOpen size={16} />, text: "Persistent conversations you can revisit" },
];

const MOCK_MESSAGES = [
  { role: 'user', text: "Give me a villain for my sci-fi comic" },
  { role: 'model', title: "Dr. Elara Voss — The Architect", text: "A terraforming engineer whose life's work was weaponized. Now she rewrites planetary code to 'fix' humanity on her terms..." },
  { role: 'user', text: "Perfect. What's her tragic backstory?" },
];

/** An opaque public card: the page surface, a hairline, the soft shadow and the feature radius. */
const FEATURE_CARD = `bg-[var(--ds-surface)] text-[var(--ds-ink)] ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_FEATURE}`;
/** The section eyebrow: the larger public overline with its icon. */
const EYEBROW = `${OVERLINE_DISPLAY} inline-flex items-center gap-2 text-[var(--ds-muted)]`;
/** A text link that reads as an action ("Open Stream Studio →"): ink, 44 px tall, the arrow nudges on hover. */
const TEXT_ACTION = `group inline-flex ${DENSITY.touch} items-center gap-2 ${RADIUS_CONTROL} text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)] underline-offset-4 hover:underline ${FOCUS_RING}`;
/** A footer link: muted, ink on hover, 44 px on touch. */
const FOOTER_LINK = `inline-flex ${DENSITY.coarse} items-center gap-2 ${RADIUS_CONTROL} text-left text-[var(--ds-muted)] hover:text-[var(--ds-ink)] ${TRANSITION} ${FOCUS_RING}`;
/** The 56 px tile on a launch card. */
const FEATURE_TILE = `flex h-14 w-14 shrink-0 items-center justify-center ${RADIUS_CONTROL}`;

export const HomePage: React.FC<HomePageProps> = ({ onEnterStudio, onViewComics, onOpenPrivacy, onOpenTerms, onNavigate }) => {
  useEffect(() => {
    if (window.location.hash === '#home-faq') {
      document.getElementById('home-faq')?.scrollIntoView();
    }
  }, []);

  const { user } = useAuth();
  // Comic Studio has its own address: on the production main site link there (in-app entry stays
  // available for signed-in people — a separate host means a separate sign-in).
  const comicsHref = comicsEntryUrl();
  const [activeStage, setActiveStage] = useState(1);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);

  const toggleFaq = (index: number) => setFaqOpen(faqOpen === index ? null : index);

  const scrollToUpdates = () => {
    document.getElementById('stay-updated')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] text-[var(--ds-ink)]">

      {/* Hero Section */}
      <section className="relative overflow-hidden px-4 py-16 sm:px-6 medium:py-24">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <div className="min-w-0 space-y-8">
            <div className={EYEBROW}>
              <Radio size={14} aria-hidden /> Stream Studio private beta
            </div>
            <h1 className={DISPLAY_HERO}>
              Private live events, <span className="text-[var(--ds-muted)]">from browser to replay.</span>
            </h1>
            <p className={cn(PUBLIC_LEAD, 'max-w-xl')}>
              Host polished creator sessions without OBS or webinar bloat: invite viewers, manage lobby/chat, bring guests on air, record the moment, and share the replay.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" className={CTA_LG} onClick={() => { void openLiveApp('/live.html'); }}>
                <Radio aria-hidden /> Open Stream Studio
              </Button>
              <Button size="lg" variant="outline" className={CTA_LG} onClick={scrollToUpdates}>
                <Mail aria-hidden /> Request access
              </Button>
            </div>
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[length:var(--ds-text-base)] font-medium text-[var(--ds-muted)]">
              <li className="flex items-center gap-2">
                <Check size={16} className="shrink-0 text-[var(--ds-ink)]" aria-hidden /> Viewer links need only a name
              </li>
              <li className="flex items-center gap-2">
                <Check size={16} className="shrink-0 text-[var(--ds-ink)]" aria-hidden /> Recording + replay workflow
              </li>
              <li className="flex items-center gap-2">
                <Check size={16} className="shrink-0 text-[var(--ds-ink)]" aria-hidden /> Cost-conscious beta limits
              </li>
            </ul>
          </div>

          {/* Stream Studio value cards */}
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <div className={cn(FEATURE_CARD, 'p-6')}>
              <div className="flex items-center gap-3 mb-3">
                <div className={SECTION_ICON_TILE}>
                  <Radio size={18} aria-hidden />
                </div>
                <div className="text-[length:var(--ds-text-lg)] font-semibold leading-6">Go live fast</div>
              </div>
              <p className="text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">Camera, mic, screen, scenes, and guest seats from the browser.</p>
            </div>
            <div className={cn(FEATURE_CARD, 'p-6')}>
              <div className="flex items-center gap-3 mb-3">
                <div className={SECTION_ICON_TILE}>
                  <Users size={18} aria-hidden />
                </div>
                <div className="text-[length:var(--ds-text-lg)] font-semibold leading-6">Control the room</div>
              </div>
              <p className="text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">Lobby approval, chat, reactions, moderation, and audience-safe viewer links.</p>
            </div>
            <div className={cn(INVERSE_SURFACE, RADIUS_FEATURE, SHADOW_SOFT, 'p-6 sm:col-span-2 flex flex-wrap items-center justify-between gap-4')}>
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-[length:var(--ds-text-lg)] font-semibold leading-6">Leave with a replay</div>
                <div className="mt-1 text-[length:var(--ds-text-base)] leading-6 text-[color:color-mix(in_srgb,var(--ds-canvas)_72%,transparent)]">Record locally, preserve key sessions, and turn events into reusable content.</div>
              </div>
              <a
                href={liveAppUrl('/live.html')}
                onClick={(e) => followLiveLink(e, '/live.html')}
                className={buttonClasses({ variant: 'outline', size: 'lg', className: cn(CTA_LG, INVERSE_ACTION_QUIET) })}
              >
                Try beta
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Launch focus */}
      <section className="px-4 py-16 sm:px-6 medium:py-20 border-t border-[var(--ds-hairline)]">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <div className={cn(EYEBROW, 'mb-4')}>
              <Sparkles size={14} aria-hidden /> June beta focus
            </div>
            <h2 className={cn(DISPLAY_SECTION, 'mb-4')}>One flagship workflow. Supporting creative tools.</h2>
            <p className={cn(PUBLIC_BODY, 'max-w-2xl mx-auto')}>
              Stream Studio is the launch wedge: private creator events that start in the browser and end with replayable content. Chat and Comic Studio support planning and repurposing.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Stream Studio — launch focus */}
            <div className={cn(FEATURE_CARD, LIFT, 'p-7 flex min-w-0 flex-col md:col-span-2')}>
              <div className="flex items-center justify-between gap-3 mb-5">
                <div className={cn(FEATURE_TILE, INK_TILE)}>
                  <Radio size={26} aria-hidden />
                </div>
                <Badge variant="default">Launch focus</Badge>
              </div>
              <h3 className={cn(DISPLAY_CARD_TITLE, 'mb-2')}>Stream Studio</h3>
              <p className={cn(PUBLIC_BODY, 'flex-1')}>
                Create a private event, share a viewer link, approve the room, go live with guests, chat in real time, record the session, and leave with a replay. Built for intimate creator workshops, coaching calls, classes, and paid-community sessions.
              </p>
              <a
                href={liveAppUrl('/live.html')}
                onClick={(e) => followLiveLink(e, '/live.html')}
                className={cn(TEXT_ACTION, 'mt-4 self-start')}
              >
                Open Stream Studio <ArrowRight size={16} className={ARROW_NUDGE} aria-hidden />
              </a>
            </div>

            {/* AI Chat — supporting */}
            <div className={cn(FEATURE_CARD, LIFT, 'p-7 flex min-w-0 flex-col')}>
              <div className="flex items-center justify-between gap-3 mb-5">
                <div className={cn(FEATURE_TILE, HAIRLINE, 'bg-[var(--ds-well)] text-[var(--ds-ink)]')}>
                  <Bot size={26} aria-hidden />
                </div>
                <Badge variant="secondary">Support</Badge>
              </div>
              <h3 className={cn(DISPLAY_CARD_TITLE, 'mb-2')}>Chat Studio</h3>
              <p className={cn(PUBLIC_BODY, 'flex-1')}>
                Plan session topics, write descriptions, brainstorm audience hooks, and turn raw ideas into usable creator scripts.
              </p>
              <button
                type="button"
                onClick={() => onNavigate?.('chat')}
                className={cn(TEXT_ACTION, 'mt-4 self-start')}
              >
                {user ? 'Open Chat Studio' : 'Try Chat Studio'} <ArrowRight size={16} className={ARROW_NUDGE} aria-hidden />
              </button>
            </div>

            {/* Comic Studio — supporting */}
            <div className={cn(FEATURE_CARD, LIFT, 'p-7 flex min-w-0 flex-col')}>
              <div className="flex items-center justify-between gap-3 mb-5">
                <div className={cn(FEATURE_TILE, HAIRLINE, 'bg-[var(--ds-well)] text-[var(--ds-ink)]')}>
                  <BookOpen size={26} aria-hidden />
                </div>
                <Badge variant="secondary">Support</Badge>
              </div>
              <h3 className={cn(DISPLAY_CARD_TITLE, 'mb-2')}>Comic Studio</h3>
              <p className={cn(PUBLIC_BODY, 'flex-1')}>
                Talk through your idea — the studio plans pages, keeps characters consistent, and letters every balloon.
              </p>
              {comicsHref ? (
                <div className="mt-4 flex flex-wrap items-center gap-x-4">
                  <a href={comicsHref} className={TEXT_ACTION}>
                    Explore Comic Studio <ArrowRight size={16} className={ARROW_NUDGE} aria-hidden />
                  </a>
                  {user && (
                    <button
                      type="button"
                      onClick={onEnterStudio}
                      className={`inline-flex ${DENSITY.touch} items-center ${RADIUS_CONTROL} text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)] underline-offset-4 hover:text-[var(--ds-ink)] hover:underline ${FOCUS_RING}`}
                    >
                      or open my comics here
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onEnterStudio}
                  className={cn(TEXT_ACTION, 'mt-4 self-start')}
                >
                  Explore Comic Studio <ArrowRight size={16} className={ARROW_NUDGE} aria-hidden />
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* AI Chat Feature Section */}
      <section className="px-4 py-16 sm:px-6 medium:py-20 bg-[var(--ds-sidebar)] border-y border-[var(--ds-hairline)]">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">

            {/* Left: Description */}
            <div className="min-w-0 space-y-7">
              <div className={EYEBROW}>
                <Bot size={14} aria-hidden /> Chat Studio
              </div>
              <h2 className={DISPLAY_SECTION}>
                Talk to AI. Build better comics.
              </h2>
              <p className={PUBLIC_LEAD}>
                Brainstorm story ideas, develop characters, and explore creative possibilities through conversation. Powered by 100+ models — no extra API key required to start.
              </p>
              <ul className="space-y-3">
                {CHAT_FEATURES.map((feature, i) => (
                  <li key={i} className="flex items-center gap-3 text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)]">
                    <span className={SECTION_ICON_TILE} aria-hidden>
                      {feature.icon}
                    </span>
                    <span className="min-w-0">{feature.text}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3 pt-2">
                <Button size="lg" className={CTA_LG} onClick={() => onNavigate?.('chat')}>
                  <MessageSquare aria-hidden /> {user ? 'Open Chat Studio' : 'Try Chat Studio'}
                </Button>
                {!user && (
                  <Button size="lg" variant="outline" className={CTA_LG} onClick={onEnterStudio}>
                    Sign In First
                  </Button>
                )}
              </div>
              {!user && (
                <p className="text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]">
                  Sign in or create an account to get started. Your account’s studio permissions apply.
                </p>
              )}
            </div>

            {/* Right: Mock chat preview */}
            <div className={cn('min-w-0 overflow-hidden bg-[var(--ds-surface)]', HAIRLINE, SHADOW_HERO, RADIUS_HERO)}>
              {/* Chat header bar */}
              <div className="flex items-center gap-3 border-b border-[var(--ds-hairline)] px-4 py-3">
                <div className="flex gap-1.5" aria-hidden>
                  <div className="w-2.5 h-2.5 rounded-[var(--ds-radius-pill)] bg-[var(--ds-faint)]" />
                  <div className="w-2.5 h-2.5 rounded-[var(--ds-radius-pill)] bg-[var(--ds-faint)]" />
                  <div className="w-2.5 h-2.5 rounded-[var(--ds-radius-pill)] bg-[var(--ds-faint)]" />
                </div>
                <div className="flex items-center gap-2 text-[length:var(--ds-text-base)] font-semibold">
                  <Bot size={14} aria-hidden />
                  Chat Studio
                </div>
                <span className={cn(CHIP, CHIP_VARIANT.outline, 'ml-auto min-w-0 truncate')}>
                  claude-3.5-sonnet
                </span>
              </div>

              {/* Mock messages */}
              <div className="p-4 space-y-4 bg-[var(--ds-well)] min-h-[280px]">
                {MOCK_MESSAGES.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'user' ? (
                      <div className={cn('max-w-[80%] bg-[var(--ds-well-strong)] px-3 py-2 text-[length:var(--ds-text-base)] leading-6', RADIUS_FEATURE)}>
                        {msg.text}
                      </div>
                    ) : (
                      <div className={cn('max-w-[88%] bg-[var(--ds-surface)] px-4 py-3', HAIRLINE, RADIUS_FEATURE)}>
                        {msg.title && (
                          <div className="mb-1 text-[length:var(--ds-text-base)] font-semibold leading-6">{msg.title}</div>
                        )}
                        <div className="text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]">{msg.text}</div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Typing indicator */}
                <div className="flex justify-start">
                  <div className={cn('inline-flex items-center gap-2 bg-[var(--ds-surface)] px-3 py-2 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]', HAIRLINE, RADIUS_FEATURE)}>
                    <div className="flex gap-1" aria-hidden>
                      <span className="w-1.5 h-1.5 rounded-[var(--ds-radius-pill)] bg-[var(--ds-muted)] animate-bounce motion-reduce:animate-none" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-[var(--ds-radius-pill)] bg-[var(--ds-muted)] animate-bounce motion-reduce:animate-none" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-[var(--ds-radius-pill)] bg-[var(--ds-muted)] animate-bounce motion-reduce:animate-none" style={{ animationDelay: '300ms' }} />
                    </div>
                    AI is writing...
                  </div>
                </div>
              </div>

              {/* Composer bar */}
              <div className="border-t border-[var(--ds-hairline)] p-3">
                <div className="flex items-center gap-2">
                  <div className={cn('min-w-0 flex-1 truncate border border-[var(--ds-control-border)] bg-[var(--ds-canvas)] px-3 py-2 text-[length:var(--ds-text-base)] text-[var(--ds-muted)]', RADIUS_CONTROL)}>
                    Ask anything about your story...
                  </div>
                  <Button size="icon" variant="outline" aria-label={user ? 'Open Chat Studio' : 'Try Chat Studio'} onClick={() => onNavigate?.('chat')}>
                    <ArrowRight aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Comic Studio Process */}
      <section className="py-16 medium:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <div className={cn(EYEBROW, 'mb-4')}>
              <BookOpen size={14} aria-hidden /> Inside Comic Studio
            </div>
            <h2 className={cn(DISPLAY_SECTION, 'mb-4')}>The Studio Workflow</h2>
            <p className={PUBLIC_BODY}>From raw idea to polished comic through one agent flow.</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            {/* Interactive List */}
            <div className="space-y-2">
              {PROCESS_STAGES.map((stage) => (
                <div
                  key={stage.id}
                  onMouseEnter={() => setActiveStage(stage.id)}
                  className={cn(
                    'cursor-pointer border-l-2 pl-6 py-4 transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none',
                    activeStage === stage.id ? 'border-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] hover:border-[var(--ds-control-border)]'
                  )}
                >
                  <h3 className="mb-1 text-[length:var(--ds-text-lg)] font-semibold leading-6 text-[var(--ds-ink)]">
                    {stage.id}. {stage.title}
                  </h3>
                  <p className={cn('text-[length:var(--ds-text-base)] leading-6', activeStage === stage.id ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]')}>
                    {stage.desc}
                  </p>
                </div>
              ))}
            </div>

            {/* The stage in focus: its icon, title and what happens there */}
            <div className={cn('bg-[var(--ds-well)] min-h-80 lg:min-h-[420px] flex items-center justify-center relative overflow-hidden', HAIRLINE, SHADOW_SOFT, RADIUS_FEATURE)}>
              <div className={cn(CHIP, CHIP_VARIANT.outline, 'absolute top-4 left-4')}>
                Stage {activeStage} of {PROCESS_STAGES.length}
              </div>
              <div className="text-center p-8">
                {activeStage === 1 && <Sparkles size={64} className="mx-auto text-[var(--ds-ink)] mb-4" aria-hidden />}
                {activeStage === 2 && <BookOpen size={64} className="mx-auto text-[var(--ds-ink)] mb-4" aria-hidden />}
                {activeStage === 3 && <Zap size={64} className="mx-auto text-[var(--ds-ink)] mb-4" aria-hidden />}
                {activeStage === 4 && <Check size={64} className="mx-auto text-[var(--ds-ink)] mb-4" aria-hidden />}
                <h3 className={cn(DISPLAY_CARD_TITLE, 'mb-2')}>{(PROCESS_STAGES[activeStage - 1] || PROCESS_STAGES[0]).title}</h3>
                <p className={cn(PUBLIC_BODY, 'max-w-xs mx-auto')}>
                  {(PROCESS_STAGES[activeStage - 1] || PROCESS_STAGES[0]).desc}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* The Stream Studio list (kind 'updates'): it promises no email while none are sent (shared/interest.ts UPDATES_CARD). */}
      <section id="stay-updated" className="px-4 py-16 sm:px-6 medium:py-20 bg-[var(--ds-sidebar)] border-y border-[var(--ds-hairline)] scroll-mt-24">
        <div className="max-w-3xl mx-auto">
          <div className={cn(FEATURE_CARD, 'p-6 medium:p-10 text-center')}>
            <div className={cn(EYEBROW, 'mb-5')}>
              <Mail size={14} aria-hidden /> {UPDATES_CARD.eyebrow}
            </div>
            <h2 className={cn(DISPLAY_SECTION, 'mb-3')}>{UPDATES_CARD.title}</h2>
            <p className={cn(PUBLIC_BODY, 'max-w-xl mx-auto mb-7')}>
              {UPDATES_CARD.body}
            </p>
            <div className="max-w-lg mx-auto">
              <WaitlistForm kind="updates" source="home-stay-updated" buttonLabel={UPDATES_CARD.button} />
            </div>
            <p className="mt-4 text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)] [overflow-wrap:anywhere]">
              Prefer email? Reach us at{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className={`underline underline-offset-2 hover:text-[var(--ds-ink)] ${RADIUS_CONTROL} ${FOCUS_RING}`}>{SUPPORT_EMAIL}</a>
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-4 pt-16 pb-10 sm:px-6 medium:pt-20">
        <div className="max-w-7xl mx-auto grid md:grid-cols-5 gap-12 mb-16">
          <div className="md:col-span-2">
            <div className="flex items-center gap-3 mb-6">
              <div className={cn('flex h-10 w-10 items-center justify-center text-[length:var(--ds-text-xl)] font-semibold', FONT_DISPLAY, INK_TILE, RADIUS_CONTROL)} aria-hidden>D</div>
              <div className="leading-none">
                <div className={cn(FONT_DISPLAY, 'text-[length:var(--ds-text-xl)] font-semibold leading-7')}>DreamStream</div>
                <div className={OVERLINE}>Studio</div>
              </div>
            </div>
            <p className={cn(PUBLIC_BODY, 'max-w-sm')}>
              Stream Studio is the launch focus for private creator events: host from the browser, invite viewers, manage interaction, record, and replay. Chat and Comic Studio support the broader creator workflow.
            </p>
          </div>
          <div>
            <h4 className={cn(OVERLINE, 'mb-4')}>Products</h4>
            <ul className="space-y-2 text-[length:var(--ds-text-base)] font-medium">
              <li>
                {comicsHref ? (
                  <a href={comicsHref} className={FOOTER_LINK}><BookOpen size={16} aria-hidden /> Comic Studio</a>
                ) : (
                  <button type="button" onClick={onEnterStudio} className={FOOTER_LINK}><BookOpen size={16} aria-hidden /> Comic Studio</button>
                )}
              </li>
              <li><button type="button" onClick={() => onNavigate?.('chat')} className={FOOTER_LINK}><Bot size={16} aria-hidden /> Chat Studio</button></li>
              <li><a href={liveAppUrl('/live.html')} onClick={(e) => followLiveLink(e, '/live.html')} className={FOOTER_LINK}><Radio size={16} aria-hidden /> Stream Studio <span className={cn(CHIP, CHIP_VARIANT.outline)}>Beta</span></a></li>
            </ul>
          </div>
          <div>
            <h4 className={cn(OVERLINE, 'mb-4')}>Support</h4>
            <ul className="space-y-2 text-[length:var(--ds-text-base)] font-medium">
              <li><a href={`mailto:${SUPPORT_EMAIL}`} className={FOOTER_LINK}><Mail size={16} aria-hidden /> Contact Us</a></li>
              <li><button type="button" onClick={scrollToUpdates} className={FOOTER_LINK}><Sparkles size={16} aria-hidden /> Stay Updated</button></li>
              <li><button type="button" onClick={() => setFaqOpen(0)} className={FOOTER_LINK}><HelpCircle size={16} aria-hidden /> FAQs</button></li>
            </ul>
          </div>
          <div>
            <h4 className={cn(OVERLINE, 'mb-4')}>Legal</h4>
            <ul className="space-y-2 text-[length:var(--ds-text-base)] font-medium">
              <li><button type="button" onClick={onOpenPrivacy} className={FOOTER_LINK}>Privacy Policy</button></li>
              <li><button type="button" onClick={onOpenTerms} className={FOOTER_LINK}>Terms of Service</button></li>
            </ul>
          </div>
        </div>

        {/* FAQs Accordion */}
        <div id="home-faq" className="max-w-3xl mx-auto border-t border-[var(--ds-hairline)] pt-10">
          <h3 className={cn(DISPLAY_CARD_TITLE, 'text-center mb-8')}>Frequently Asked Questions</h3>
          <div className="space-y-2">
            {[
              { q: "Who is Stream Studio for?", a: "Creators, educators, coaches, workshop hosts, and small communities that want private live sessions without OBS or heavy webinar software." },
              { q: "Do viewers need accounts?", a: "Viewer links are designed so guests can join with just a name. Hosts can use lobby and moderation controls to keep the room safe." },
              { q: "Can I record and replay a session?", a: "The studio supports local recording and replay-oriented workflows. Beta limits and retention are shown in the product so creators know what is preserved." },
              { q: "Is this a full webinar or enterprise streaming platform?", a: "Not for this beta. The focus is intimate, creator-led events and workshops, not enterprise webinars, massive streams, or gaming-grade ultra-low latency." },
              { q: "When will paid subscriptions start?", a: "Subscription packaging is still being evaluated. We will not activate paid plans until the beta workflow, costs, and user value are proven." }
            ].map((faq, i) => (
              <div key={i} className={cn('bg-[var(--ds-surface)]', HAIRLINE, RADIUS_CONTROL)}>
                <button
                  type="button"
                  onClick={() => toggleFaq(i)}
                  aria-expanded={faqOpen === i}
                  className={cn('w-full flex items-center justify-between gap-3 p-4 text-left text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', RADIUS_CONTROL, TRANSITION, FOCUS_RING)}
                >
                  {faq.q}
                  <ChevronRight size={16} aria-hidden className={cn('shrink-0 transition-transform duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none', faqOpen === i && 'rotate-90')} />
                </button>
                {faqOpen === i && (
                  <div className="p-4 pt-0 text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="text-center mt-16 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">
          © 2026 DreamStream Studio. All rights reserved.
        </div>
      </footer>
    </div>
  );
};
