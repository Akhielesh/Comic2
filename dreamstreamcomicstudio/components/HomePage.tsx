import React, { useState, useEffect } from 'react';
import { Sparkles, Zap, Users, BookOpen, Check, HelpCircle, Mail, Info, ChevronRight, MessageSquare, Bot, Shield, Cpu, ArrowRight, Code2, Lock, Radio } from 'lucide-react';
import { Button } from './Button';
import { WaitlistForm } from './WaitlistForm';
import { getStudioStats, StudioStats } from '../services/stats';
import { useAuth } from '../contexts/AuthContext';

interface HomePageProps {
  onEnterStudio: () => void;
  onViewComics: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onNavigate?: (view: string, id?: string) => void;
}

const PROCESS_STAGES = [
  { id: 1, title: "Idea", desc: "Start with a raw concept or theme." },
  { id: 2, title: "Script", desc: "Write or paste your screenplay." },
  { id: 3, title: "Analysis", desc: "AI extracts scenes, characters, and props." },
  { id: 4, title: "Characters", desc: "Design consistent character sheets." },
  { id: 5, title: "World", desc: "Build locations and consistent props." },
  { id: 6, title: "Storyboard", desc: "Plan panels and layout flow." },
  { id: 7, title: "Generation", desc: "Render high-fidelity panel images." },
  { id: 8, title: "Polish", desc: "Add lettering, speech bubbles, and export." }
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

export const HomePage: React.FC<HomePageProps> = ({ onEnterStudio, onViewComics, onOpenPrivacy, onOpenTerms, onNavigate }) => {
  const { user } = useAuth();
  const [activeStage, setActiveStage] = useState(1);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);
  const [stats, setStats] = useState<StudioStats>({ userCount: 0, comicCount: 0 });

  useEffect(() => {
    getStudioStats().then(setStats);
  }, []);

  const toggleFaq = (index: number) => setFaqOpen(faqOpen === index ? null : index);

  const scrollToUpdates = () => {
    document.getElementById('stay-updated')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">

      {/* Hero Section */}
      <section className="relative overflow-hidden py-24 px-6">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8 relative z-10">
            <div className="inline-flex items-center gap-2 bg-black text-white px-4 py-2 rounded-full font-mono text-xs font-bold tracking-widest uppercase">
              <Sparkles size={12} className="text-brand-yellow" /> One studio · three AI products
            </div>
            <h1 className="text-6xl md:text-7xl font-display leading-[0.9]">
              Dream it. Stream it. <span className="text-brand-blue">Create it.</span>
            </h1>
            <p className="text-xl font-comic text-slate-600 max-w-lg leading-relaxed">
              DreamStream Studio is your home for AI-powered creation — craft cinematic comics, brainstorm with 100+ AI models, and soon, build with code.
            </p>
            <div className="flex flex-wrap gap-4">
              <Button onClick={onEnterStudio} className="text-xl px-10 py-5 shadow-comic hover:shadow-none transition-all" icon={<Zap />}>
                Start Creating
              </Button>
              <button
                onClick={() => onNavigate?.('chat')}
                className="px-8 py-4 border-4 border-black rounded-xl font-bold hover:bg-brand-blue hover:text-white transition-colors flex items-center gap-2"
              >
                <Bot size={18} /> Explore Chat Studio
              </button>
              <button
                onClick={() => onNavigate?.('how-it-works')}
                className="px-8 py-4 border-4 border-black rounded-xl font-bold hover:bg-brand-yellow transition-colors"
              >
                How It Works
              </button>
            </div>
            <div className="flex items-center gap-6 text-sm font-bold text-slate-500">
              <div className="flex items-center gap-2">
                <Check size={16} className="text-green-600" /> Invite-only early access
              </div>
              <div className="flex items-center gap-2">
                <Check size={16} className="text-green-600" /> Bring your own API keys
              </div>
            </div>
          </div>

          {/* Stats Cards */}
          <div className="relative">
            <div className="absolute inset-0 bg-brand-yellow/20 rounded-full blur-3xl transform translate-x-10 translate-y-10" />
            <div className="relative grid grid-cols-2 gap-4">
              <div className="bg-white border-4 border-black rounded-2xl p-6 shadow-comic transform rotate-2 hover:rotate-0 transition-transform duration-300">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center border-2 border-black">
                    <Users size={20} />
                  </div>
                  <div>
                    <div className="text-2xl font-display">{stats.userCount.toLocaleString()}</div>
                    <div className="text-xs font-bold text-slate-500 uppercase">Creators</div>
                  </div>
                </div>
              </div>
              <div className="bg-white border-4 border-black rounded-2xl p-6 shadow-comic transform -rotate-1 hover:rotate-0 transition-transform duration-300 mt-8">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center border-2 border-black">
                    <BookOpen size={20} />
                  </div>
                  <div>
                    <div className="text-2xl font-display">{stats.comicCount.toLocaleString()}</div>
                    <div className="text-xs font-bold text-slate-500 uppercase">Public Comics</div>
                  </div>
                </div>
              </div>
              <div className="col-span-2 bg-black text-white border-4 border-black rounded-2xl p-6 shadow-comic transform rotate-1 hover:rotate-0 transition-transform duration-300 flex items-center justify-between">
                <div>
                  <div className="text-brand-yellow font-display text-xl">Community Challenge</div>
                  <div className="text-sm font-mono text-zinc-400">New events are launching soon.</div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => alert('Community Challenge is coming soon.')}>Coming Soon</Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Three products under one roof */}
      <section className="py-20 px-6 bg-white border-t-4 border-black">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 bg-black text-white px-4 py-2 rounded-full font-mono text-xs font-bold uppercase tracking-widest mb-4">
              <Sparkles size={12} className="text-brand-yellow" /> The DreamStream Studio suite
            </div>
            <h2 className="text-4xl md:text-5xl font-display mb-4">Four products. One studio.</h2>
            <p className="font-comic text-slate-600 max-w-xl mx-auto">
              Everything you need to dream up, build and ship your ideas — under a single account.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Comic Studio — live */}
            <div className="bg-white border-4 border-black rounded-2xl p-7 shadow-comic flex flex-col transition-transform duration-300 hover:-translate-y-1">
              <div className="flex items-center justify-between mb-5">
                <div className="w-14 h-14 bg-brand-yellow border-2 border-black rounded-xl flex items-center justify-center shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] transform -rotate-2">
                  <BookOpen size={26} />
                </div>
                <span className="text-[10px] font-extrabold uppercase tracking-wider bg-green-100 text-green-700 border-2 border-green-600 rounded-full px-2.5 py-1">Live</span>
              </div>
              <h3 className="text-2xl font-display mb-2">Comic Studio</h3>
              <p className="text-sm font-comic text-slate-600 leading-relaxed flex-1">
                Turn a script into cinematic, consistent comics — characters, worlds, storyboards, panels, lettering and export.
              </p>
              <button
                onClick={onEnterStudio}
                className="mt-6 inline-flex items-center gap-2 font-bold text-sm text-black hover:gap-3 transition-all"
              >
                Start creating <ArrowRight size={16} />
              </button>
            </div>

            {/* AI Chat — live */}
            <div className="bg-white border-4 border-black rounded-2xl p-7 shadow-comic flex flex-col transition-transform duration-300 hover:-translate-y-1">
              <div className="flex items-center justify-between mb-5">
                <div className="w-14 h-14 bg-brand-blue border-2 border-black rounded-xl flex items-center justify-center shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] transform rotate-2 text-white">
                  <Bot size={26} />
                </div>
                <span className="text-[10px] font-extrabold uppercase tracking-wider bg-green-100 text-green-700 border-2 border-green-600 rounded-full px-2.5 py-1">Live</span>
              </div>
              <h3 className="text-2xl font-display mb-2">Chat Studio</h3>
              <p className="text-sm font-comic text-slate-600 leading-relaxed flex-1">
                Brainstorm and build with 100+ models — Claude, Gemini, GPT — with rich, interactive outputs and persistent threads.
              </p>
              <button
                onClick={() => onNavigate?.('chat')}
                className="mt-6 inline-flex items-center gap-2 font-bold text-sm text-brand-blue hover:gap-3 transition-all"
              >
                {user ? 'Open Chat Studio' : 'Try Chat Studio'} <ArrowRight size={16} />
              </button>
            </div>

            {/* Stream Studio — beta */}
            <div className="bg-white border-4 border-black rounded-2xl p-7 shadow-comic flex flex-col transition-transform duration-300 hover:-translate-y-1">
              <div className="flex items-center justify-between mb-5">
                <div className="w-14 h-14 bg-brand-red border-2 border-black rounded-xl flex items-center justify-center shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] transform -rotate-2 text-white">
                  <Radio size={26} />
                </div>
                <span className="text-[10px] font-extrabold uppercase tracking-wider bg-yellow-100 text-yellow-700 border-2 border-yellow-600 rounded-full px-2.5 py-1">Beta</span>
              </div>
              <h3 className="text-2xl font-display mb-2">Stream Studio</h3>
              <p className="text-sm font-comic text-slate-600 leading-relaxed flex-1">
                Go live from your phone or laptop — real camera lenses, live chat with your audience, a gated lobby, and full-quality recordings.
              </p>
              <a
                href="/live.html"
                className="mt-6 inline-flex items-center gap-2 font-bold text-sm text-brand-red hover:gap-3 transition-all"
              >
                Go live <ArrowRight size={16} />
              </a>
            </div>

            {/* Code — coming soon */}
            <div className="group relative bg-slate-50 border-4 border-dashed border-slate-300 rounded-2xl p-7 flex flex-col">
              <div className="flex items-center justify-between mb-5">
                <div className="w-14 h-14 bg-slate-200 border-2 border-slate-400 rounded-xl flex items-center justify-center text-slate-500 transform -rotate-2">
                  <Code2 size={26} />
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider bg-slate-200 text-slate-500 border-2 border-slate-400 rounded-full px-2.5 py-1">
                  <Lock size={10} /> Coming soon
                </span>
              </div>
              <h3 className="text-2xl font-display mb-2 text-slate-500">Code</h3>
              <p className="text-sm font-comic text-slate-500 leading-relaxed flex-1">
                Describe an app and watch it build itself. AI pair-programming with instant live previews — we’re hard at work on it.
              </p>
              <button
                onClick={scrollToUpdates}
                className="mt-6 inline-flex items-center gap-2 font-bold text-sm text-slate-500 hover:text-black transition-colors"
              >
                <Mail size={15} /> Notify me when it’s ready
              </button>
              {/* Hover tooltip */}
              <div className="pointer-events-none absolute inset-x-0 -top-3 flex justify-center opacity-0 -translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150">
                <div className="bg-black text-white text-xs font-bold rounded-lg border-2 border-black shadow-comic px-3 py-1.5">
                  🚧 In the workshop — coming soon
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* AI Chat Feature Section */}
      <section className="py-20 px-6 bg-white border-y-4 border-black">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-16 items-center">

            {/* Left: Description */}
            <div className="space-y-7">
              <div className="inline-flex items-center gap-2 bg-brand-blue text-white px-4 py-2 rounded-full font-mono text-xs font-bold uppercase tracking-widest">
                <Bot size={14} /> Chat Studio
              </div>
              <h2 className="text-4xl md:text-5xl font-display leading-tight">
                Talk to AI. Build better comics.
              </h2>
              <p className="text-lg font-comic text-slate-600 leading-relaxed">
                Brainstorm story ideas, develop characters, and explore creative possibilities through conversation. Powered by 100+ models — no extra API key required to start.
              </p>
              <ul className="space-y-3">
                {CHAT_FEATURES.map((feature, i) => (
                  <li key={i} className="flex items-center gap-3 text-sm font-bold text-slate-700">
                    <span className="w-8 h-8 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center shrink-0">
                      {feature.icon}
                    </span>
                    {feature.text}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3 pt-2">
                <Button
                  onClick={() => onNavigate?.('chat')}
                  icon={<MessageSquare size={16} />}
                  className="shadow-comic hover:shadow-none transition-all"
                >
                  {user ? 'Open Chat Studio' : 'Try Chat Studio'}
                </Button>
                {!user && (
                  <button
                    onClick={onEnterStudio}
                    className="px-6 py-3 border-4 border-black rounded-xl font-bold hover:bg-slate-100 transition-colors text-sm"
                  >
                    Sign In First
                  </button>
                )}
              </div>
              {!user && (
                <p className="text-xs font-mono text-slate-400">
                  * Chat Studio is open to members. New here? We’re in invite-only beta — request access above.
                </p>
              )}
            </div>

            {/* Right: Mock chat preview */}
            <div className="bg-white border-4 border-black rounded-2xl shadow-comic overflow-hidden">
              {/* Chat header bar */}
              <div className="bg-black text-white px-4 py-3 flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500" />
                  <div className="w-3 h-3 rounded-full bg-yellow-400" />
                  <div className="w-3 h-3 rounded-full bg-green-500" />
                </div>
                <div className="flex items-center gap-2 text-sm font-bold">
                  <Bot size={14} className="text-brand-yellow" />
                  Chat Studio
                </div>
                <span className="ml-auto text-xs bg-brand-yellow/20 text-brand-yellow px-2 py-0.5 rounded font-mono border border-brand-yellow/30">
                  claude-3.5-sonnet
                </span>
              </div>

              {/* Mock messages */}
              <div className="p-4 space-y-4 bg-slate-50 min-h-[280px]">
                {MOCK_MESSAGES.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'user' ? (
                      <div className="max-w-[80%] bg-white border-2 border-black rounded-xl rounded-tr-sm px-3 py-2 text-sm font-medium shadow-[2px_2px_0px_rgba(0,0,0,0.15)]">
                        {msg.text}
                      </div>
                    ) : (
                      <div className="max-w-[88%] bg-black text-white border-2 border-black rounded-xl rounded-tl-sm px-4 py-3 text-sm shadow-[2px_2px_0px_rgba(0,0,0,0.3)]">
                        {msg.title && (
                          <div className="text-brand-yellow font-display text-base mb-1">{msg.title}</div>
                        )}
                        <div className="text-zinc-300 font-mono text-xs leading-relaxed">{msg.text}</div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Typing indicator */}
                <div className="flex justify-start">
                  <div className="inline-flex items-center gap-2 bg-white border-2 border-black rounded-xl px-3 py-2 text-xs font-mono text-slate-400">
                    <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-blue animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-blue animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-blue animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    AI is writing...
                  </div>
                </div>
              </div>

              {/* Composer bar */}
              <div className="border-t-4 border-black p-3 bg-white">
                <div className="flex items-center gap-2">
                  <div className="flex-1 border-2 border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-400 bg-slate-50 font-comic">
                    Ask anything about your story...
                  </div>
                  <button
                    onClick={() => onNavigate?.('chat')}
                    className="w-10 h-10 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center hover:bg-black hover:text-brand-yellow transition-colors shrink-0"
                  >
                    <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 8-Stage Process */}
      <section className="py-20 bg-slate-50 border-b-4 border-black">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 bg-brand-yellow border-2 border-black px-3 py-1 rounded-full font-mono text-[11px] font-bold uppercase tracking-widest mb-4">
              <BookOpen size={12} /> Inside Comic Studio
            </div>
            <h2 className="text-4xl md:text-5xl font-display mb-4">The Studio Workflow</h2>
            <p className="font-comic text-slate-600">From raw idea to polished pages in 8 steps.</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            {/* Interactive List */}
            <div className="space-y-2">
              {PROCESS_STAGES.map((stage) => (
                <div
                  key={stage.id}
                  onMouseEnter={() => setActiveStage(stage.id)}
                  className={`cursor-pointer border-l-4 pl-6 py-4 transition-all duration-300 ${activeStage === stage.id
                    ? "border-brand-blue"
                    : "border-slate-200 hover:border-slate-300"
                    }`}
                >
                  <h3 className={`text-xl font-display mb-1 ${activeStage === stage.id ? "text-brand-blue" : "text-black"}`}>
                    {stage.id}. {stage.title}
                  </h3>
                  <p className={`text-sm font-comic ${activeStage === stage.id ? "text-slate-800" : "text-slate-400"}`}>
                    {stage.desc}
                  </p>
                </div>
              ))}
            </div>

            {/* Visualizer (Mock) */}
            <div className="bg-slate-100 border-4 border-black rounded-2xl shadow-comic h-[500px] flex items-center justify-center relative overflow-hidden">
              <div className="absolute top-4 left-4 bg-white border-2 border-black px-3 py-1 rounded-full text-xs font-bold uppercase shadow-sm">
                Stage {activeStage} Preview
              </div>
              <div className="text-center p-8">
                {activeStage === 1 && <Sparkles size={64} className="mx-auto text-brand-yellow mb-4" />}
                {activeStage === 2 && <BookOpen size={64} className="mx-auto text-brand-blue mb-4" />}
                {activeStage === 3 && <Zap size={64} className="mx-auto text-purple-500 mb-4" />}
                <h3 className="text-3xl font-display mb-2">{PROCESS_STAGES[activeStage - 1].title}</h3>
                <p className="font-comic text-slate-500 max-w-xs mx-auto">
                  Simulated interface for {PROCESS_STAGES[activeStage - 1].title.toLowerCase()} goes here.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stay updated — email capture */}
      <section id="stay-updated" className="py-20 px-6 bg-brand-blue border-y-4 border-black scroll-mt-24">
        <div className="max-w-3xl mx-auto">
          <div className="bg-white border-4 border-black rounded-2xl shadow-comic p-8 md:p-10 text-center">
            <div className="inline-flex items-center gap-2 bg-brand-yellow border-2 border-black px-3 py-1 rounded-full font-mono text-[11px] font-bold uppercase tracking-widest mb-5">
              <Mail size={12} /> Stay in the loop
            </div>
            <h2 className="text-3xl md:text-4xl font-display mb-3">Want to stay updated?</h2>
            <p className="font-comic text-slate-600 max-w-xl mx-auto mb-7">
              Get product updates, early access invites, and the heads-up when <span className="font-bold text-black">Code</span> and new features go live. No spam — just the good stuff.
            </p>
            <div className="max-w-lg mx-auto">
              <WaitlistForm kind="updates" source="home-stay-updated" buttonLabel="Keep me posted" />
            </div>
            <p className="text-xs font-mono text-slate-400 mt-4">
              Prefer email? Reach us at{' '}
              <a href="mailto:contact@dreamstreamstudio.ai" className="underline hover:text-black">contact@dreamstreamstudio.ai</a>
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-black text-white pt-20 pb-10 px-6">
        <div className="max-w-7xl mx-auto grid md:grid-cols-5 gap-12 mb-16">
          <div className="md:col-span-2">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-brand-yellow border-2 border-white rounded-lg flex items-center justify-center text-black font-display text-2xl transform -rotate-3">D</div>
              <div className="leading-none">
                <div className="font-display text-2xl">DreamStream</div>
                <div className="text-[10px] font-bold text-brand-yellow uppercase tracking-widest mt-1">Studio</div>
              </div>
            </div>
            <p className="text-zinc-400 font-comic max-w-sm">
              One studio for AI-powered creation — comics, chat, live streams, and soon code. Built for creators who want control, from first idea to final ship.
            </p>
          </div>
          <div>
            <h4 className="font-bold uppercase tracking-widest text-zinc-500 mb-6 text-xs">Products</h4>
            <ul className="space-y-4 text-sm font-bold">
              <li><button onClick={onEnterStudio} className="flex items-center gap-2 hover:text-brand-yellow text-left"><BookOpen size={16} /> Comic Studio</button></li>
              <li><button onClick={() => onNavigate?.('chat')} className="flex items-center gap-2 hover:text-brand-yellow text-left"><Bot size={16} /> Chat Studio</button></li>
              <li><a href="/live.html" className="flex items-center gap-2 hover:text-brand-yellow text-left"><Radio size={16} /> Stream Studio <span className="text-[9px] uppercase tracking-wider bg-zinc-800 px-1.5 py-0.5 rounded">Beta</span></a></li>
              <li><button onClick={scrollToUpdates} className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 text-left"><Code2 size={16} /> Code <span className="text-[9px] uppercase tracking-wider bg-zinc-800 px-1.5 py-0.5 rounded">Soon</span></button></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold uppercase tracking-widest text-zinc-500 mb-6 text-xs">Support</h4>
            <ul className="space-y-4 text-sm font-bold">
              <li><a href="mailto:contact@dreamstreamstudio.ai" className="flex items-center gap-2 hover:text-brand-yellow"><Mail size={16} /> Contact Us</a></li>
              <li><button onClick={scrollToUpdates} className="flex items-center gap-2 hover:text-brand-yellow text-left"><Sparkles size={16} /> Stay Updated</button></li>
              <li><button onClick={() => setFaqOpen(0)} className="flex items-center gap-2 hover:text-brand-yellow text-left"><HelpCircle size={16} /> FAQs</button></li>
              <li><button onClick={() => onNavigate?.('how-it-works')} className="flex items-center gap-2 hover:text-brand-yellow text-left"><Info size={16} /> About</button></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold uppercase tracking-widest text-zinc-500 mb-6 text-xs">Legal</h4>
            <ul className="space-y-4 text-sm text-zinc-400 font-bold">
              <li><button onClick={onOpenPrivacy} className="hover:text-white text-left">Privacy Policy</button></li>
              <li><button onClick={onOpenTerms} className="hover:text-white text-left">Terms of Service</button></li>
            </ul>
          </div>
        </div>

        {/* FAQs Accordion */}
        <div id="home-faq" className="max-w-3xl mx-auto border-t border-zinc-800 pt-10">
          <h3 className="text-center font-display text-2xl mb-8">Frequently Asked Questions</h3>
          <div className="space-y-2">
            {[
              { q: "Is it really free?", a: "Yes. You can start free and bring your own API keys, so generation runs on your own provider account." },
              { q: "Can I use my own API keys?", a: "Yes. Add one or more provider keys (e.g. OpenRouter, Gemini) in Settings → API Configuration; generation runs on your keys." },
              { q: "Do I own the comics I create?", a: "Yes, you own full commercial rights to all comics generated on the platform, subject to the AI model's specific terms." },
              { q: "How is cost shown?", a: "Each action shows an estimated cost before running and the actual cost after, with a per-comic breakdown by stage and model." },
              { q: "What happens at limits?", a: "If you set a usage limit on a key, you'll be alerted as you approach it and stopped before exceeding it." }
            ].map((faq, i) => (
              <div key={i} className="border border-zinc-800 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleFaq(i)}
                  className="w-full flex items-center justify-between p-4 text-left font-bold hover:bg-zinc-900"
                >
                  {faq.q}
                  <ChevronRight size={16} className={`transform transition-transform ${faqOpen === i ? "rotate-90" : ""}`} />
                </button>
                {faqOpen === i && (
                  <div className="p-4 pt-0 text-zinc-400 text-sm font-comic">
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="text-center mt-20 text-zinc-600 text-xs font-mono">
          © 2026 DreamStream Studio. All rights reserved.
        </div>
      </footer>
    </div>
  );
};
