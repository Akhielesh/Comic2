import React, { useState, useEffect } from 'react';
import { Sparkles, ArrowRight, Zap, Users, BookOpen, Check, X, HelpCircle, Mail, Info, ChevronRight, Crown, Infinity } from 'lucide-react';
import { Button } from './Button';
import { getStudioStats, StudioStats } from '../services/stats';
import { useAuth } from '../contexts/AuthContext';
import { UserAvatar } from './UserAvatar';
import { NotificationBell } from './NotificationBell';

interface HomePageProps {
  onEnterStudio: () => void;
  onViewComics: () => void;
  onOpenProfile?: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenUpgrade?: () => void;
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

export const HomePage: React.FC<HomePageProps> = ({ onEnterStudio, onViewComics, onOpenProfile, onOpenPrivacy, onOpenTerms, onOpenUpgrade, onNavigate }) => {
  const { user } = useAuth();
  // ... existing code ...

  // Footer Section (inside return)
  // I need to find where the Footer is rendered.
  // Wait, I am restricted to 2000 chars context window if I use simple replace, but the file is large.
  // I'll assume the Footer is at the bottom.
  // I'll scroll to bottom to see where it is. 
  // Ah, I already read 'HomePage.tsx' in step 799 (partially) and 806.
  // Let me check the content of HomePage again to find the Footer.

  const [activeStage, setActiveStage] = useState(1);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);
  const [stats, setStats] = useState<StudioStats>({ userCount: 0, comicCount: 0 });

  useEffect(() => {
    getStudioStats().then(setStats);
  }, []);

  const toggleFaq = (index: number) => setFaqOpen(faqOpen === index ? null : index);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b-4 border-black">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center text-black font-display text-2xl shadow-comic transform -rotate-3">D</div>
            <div className="flex flex-col">
              <span className="font-display text-2xl tracking-tight text-black leading-none">DreamStream</span>
              <span className="font-comic font-bold text-brand-blue text-xs leading-none">Comic Studio</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={onViewComics} className="hidden md:block text-sm font-bold hover:underline">View Comics</button>
            {user ? (
              <>
                <Button onClick={onEnterStudio} size="sm" icon={<ArrowRight size={16} />}>Studio</Button>
                {onNavigate && <NotificationBell onNavigate={onNavigate} />}
                <UserAvatar onClick={onOpenProfile} />
              </>
            ) : (
              <Button onClick={onEnterStudio} size="sm" icon={<ArrowRight size={16} />}>Sign In</Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden py-24 px-6">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8 relative z-10">
            <div className="inline-flex items-center gap-2 bg-black text-white px-4 py-2 rounded-full font-mono text-xs font-bold tracking-widest uppercase">
              <Sparkles size={12} className="text-brand-yellow" /> Human led with AI powered studio
            </div>
            <h1 className="text-6xl md:text-7xl font-display leading-[0.9]">
              Turn your stories into <span className="text-brand-blue">cinematic comics</span>.
            </h1>
            <p className="text-xl font-comic text-slate-600 max-w-lg leading-relaxed">
              The professional studio workflow for storytellers. Control every beat, character, and panel with precision.
            </p>
            <div className="flex flex-wrap gap-4">
              <Button onClick={onEnterStudio} className="text-xl px-10 py-5 shadow-comic hover:shadow-none transition-all" icon={<Zap />}>
                Start Creating
              </Button>
              <button
                onClick={onViewComics}
                className="px-8 py-4 border-4 border-black rounded-xl font-bold hover:bg-slate-100 transition-colors"
              >
                View Comics
              </button>
            </div>
            <div className="flex items-center gap-6 text-sm font-bold text-slate-500">
              <div className="flex items-center gap-2">
                <Check size={16} className="text-green-600" /> Free Forever
              </div>
              <div className="flex items-center gap-2">
                <Check size={16} className="text-green-600" /> No Credit Card
              </div>
            </div>
          </div>

          {/* Active User Cards */}
          <div className="relative">
            <div className="absolute inset-0 bg-brand-yellow/20 rounded-full blur-3xl transform translate-x-10 translate-y-10" />
            <div className="relative grid grid-cols-2 gap-4">
              <div className="bg-white border-4 border-black rounded-2xl p-6 shadow-comic transform rotate-2 hover:rotate-0 transition-transform duration-300">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center border-2 border-black">
                    <Users size={20} />
                  </div>
                  <div>
                    <div className="text-2xl font-display">{stats.userCount > 0 ? stats.userCount.toLocaleString() : "1,240+"}</div>
                    <div className="text-xs font-bold text-slate-500 uppercase">Active Users</div>
                  </div>
                </div>
              </div>
              <div className="bg-white border-4 border-black rounded-2xl p-6 shadow-comic transform -rotate-1 hover:rotate-0 transition-transform duration-300 mt-8">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center border-2 border-black">
                    <BookOpen size={20} />
                  </div>
                  <div>
                    <div className="text-2xl font-display">{stats.comicCount > 0 ? stats.comicCount.toLocaleString() : "5,800+"}</div>
                    <div className="text-xs font-bold text-slate-500 uppercase">Comics Made</div>
                  </div>
                </div>
              </div>
              <div className="col-span-2 bg-black text-white border-4 border-black rounded-2xl p-6 shadow-comic transform rotate-1 hover:rotate-0 transition-transform duration-300 flex items-center justify-between">
                <div>
                  <div className="text-brand-yellow font-display text-xl">Community Challenge</div>
                  <div className="text-sm font-mono text-zinc-400">Theme: Cyber-mainland</div>
                </div>
                <Button size="sm" variant="secondary" onClick={onEnterStudio}>Join</Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 8-Stage Process */}
      <section className="py-20 bg-white border-y-4 border-black">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
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

      {/* Pricing */}
      <section className="py-24 px-6 bg-slate-50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-display mb-4">Choose Your Plan</h2>
            <p className="font-comic text-slate-600">Start for free, upgrade for production power.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 items-start">
            {/* Free */}
            <div className="bg-white border-4 border-black rounded-2xl p-8 shadow-comic hover:-translate-y-2 transition-transform duration-300">
              <div className="font-display text-2xl mb-2">Free Starter</div>
              <div className="text-4xl font-black mb-6">$0<span className="text-sm font-normal text-slate-500">/forever</span></div>
              <ul className="space-y-4 mb-4 text-sm font-bold">
                <li className="flex items-center gap-2"><Check size={16} className="text-green-600" /> 30 Images / Comic</li>
                <li className="flex items-center gap-2"><Check size={16} className="text-green-600" /> Basic Models (Lite)</li>
                <li className="flex items-center gap-2"><Check size={16} className="text-green-600" /> Community Support</li>
                <li className="flex items-center gap-2 text-slate-400"><X size={16} /> Private Projects (Def: Public)</li>
              </ul>
              <div className="mt-6">
                <Button onClick={onEnterStudio} variant="secondary" className="w-full">Start Free</Button>
              </div>
            </div>

            {/* Pro Annual */}
            <div className="bg-white border-4 border-black rounded-2xl p-8 shadow-comic hover:-translate-y-2 transition-transform duration-300">
              <div className="font-display text-2xl mb-2">Pro Annual</div>
              <div className="text-4xl font-black mb-6">$9.99<span className="text-sm font-normal text-slate-500">/mo</span></div>
              <div className="text-xs font-bold mb-6 text-slate-800 bg-slate-100 border border-slate-300 rounded px-2 py-1 inline-block">
                Billed $119 yearly
              </div>
              <ul className="space-y-4 mb-4 text-sm font-bold">
                <li className="flex items-center gap-2"><Check size={16} className="text-green-600" /> 10 Comics / Month</li>
                <li className="flex items-center gap-2"><Check size={16} className="text-green-600" /> 100 Pages / Comic</li>
                <li className="flex items-center gap-2"><Check size={16} className="text-green-600" /> Premium Models (Pro 1.5)</li>
                <li className="flex items-center gap-2"><Check size={16} className="text-green-600" /> Private Projects</li>
              </ul>
              <div className="mt-6">
                <Button onClick={onOpenUpgrade} variant="secondary" className="w-full">Upgrade (Enter Key)</Button>
              </div>
            </div>

            {/* Go Crazy (Monthly) */}
            <div className="bg-brand-red text-white border-4 border-black rounded-2xl p-8 shadow-comic transform scale-105 z-10 relative group hover:animate-shake hover:rotate-1 transition-all">
              <style>{`
                @keyframes shake {
                  0% { transform: translate(1px, 1px) rotate(0deg) scale(1.05); }
                  10% { transform: translate(-1px, -2px) rotate(-1deg) scale(1.05); }
                  20% { transform: translate(-3px, 0px) rotate(1deg) scale(1.05); }
                  30% { transform: translate(3px, 2px) rotate(0deg) scale(1.05); }
                  40% { transform: translate(1px, -1px) rotate(1deg) scale(1.05); }
                  50% { transform: translate(-1px, 2px) rotate(-1deg) scale(1.05); }
                  60% { transform: translate(-3px, 1px) rotate(0deg) scale(1.05); }
                  70% { transform: translate(3px, 1px) rotate(-1deg) scale(1.05); }
                  80% { transform: translate(-1px, -1px) rotate(1deg) scale(1.05); }
                  90% { transform: translate(1px, 2px) rotate(0deg) scale(1.05); }
                  100% { transform: translate(1px, -2px) rotate(-1deg) scale(1.05); }
                }
                .hover\\:animate-shake:hover {
                  animation: shake 0.5s;
                  animation-iteration-count: infinite;
                }
              `}</style>
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-black text-brand-yellow px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border-2 border-brand-yellow shadow-sm flex items-center gap-2">
                <Crown size={12} /> Ultimate
              </div>
              <div className="font-display text-3xl mb-2 text-white drop-shadow-md">Go Crazy</div>
              <div className="text-5xl font-black mb-6">$30<span className="text-lg font-normal text-white/80">/mo</span></div>
              <div className="text-xs font-bold mb-6 text-white bg-black/20 border border-white/20 rounded px-2 py-1 inline-block">
                Monthly Only
              </div>
              <ul className="space-y-4 mb-4 text-sm font-bold">
                <li className="flex items-center gap-2"><Infinity size={16} className="text-brand-yellow" /> Unlimited Generations</li>
                <li className="flex items-center gap-2"><Infinity size={16} className="text-brand-yellow" /> Unlimited Storage</li>
                <li className="flex items-center gap-2"><Check size={16} className="text-brand-yellow" /> All AI Models Included</li>
                <li className="flex items-center gap-2"><Check size={16} className="text-brand-yellow" /> Priority Support</li>
              </ul>
              <div className="mt-6">
                <button onClick={onOpenUpgrade} className="w-full bg-white text-black font-display text-xl py-3 rounded-xl border-4 border-black hover:bg-brand-yellow transition-colors shadow-lg">
                  Unleash (Enter Key)
                </button>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-black text-white pt-20 pb-10 px-6">
        <div className="max-w-7xl mx-auto grid md:grid-cols-4 gap-12 mb-16">
          <div className="col-span-2">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-brand-yellow border-2 border-white rounded-lg flex items-center justify-center text-black font-display text-2xl transform -rotate-3">D</div>
              <div className="font-display text-2xl">DreamStream</div>
            </div>
            <p className="text-zinc-400 font-comic max-w-sm">
              Built for storytellers who want control. The only AI studio that puts your vision first, from script to final print.
            </p>
          </div>
          <div>
            <h4 className="font-bold uppercase tracking-widest text-zinc-500 mb-6 text-xs">Support</h4>
            <ul className="space-y-4 text-sm font-bold">
              <li><a href="mailto:contact@dreamstream.com" className="flex items-center gap-2 hover:text-brand-yellow"><Mail size={16} /> Contact Us</a></li>
              <li><button onClick={() => setFaqOpen(0)} className="flex items-center gap-2 hover:text-brand-yellow text-left"><HelpCircle size={16} /> FAQs</button></li>
              <li><a href="#" className="flex items-center gap-2 hover:text-brand-yellow"><Info size={16} /> About</a></li>
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

        {/* FAQs Accordion (Simple) */}
        <div className="max-w-3xl mx-auto border-t border-zinc-800 pt-10">
          <h3 className="text-center font-display text-2xl mb-8">Frequently Asked Questions</h3>
          <div className="space-y-2">
            {[
              { q: "Is it really free?", a: "Yes. The Free Starter plan gives you 30 images per comic project with no credit card required." },
              { q: "Can I use my own API keys?", a: "Absolutely! We have a wide selection of models including the latest ones. You can plug in your own keys in Settings to bypass free limits." },
              { q: "Do I own the comics I create?", a: "Yes, you own full commercial rights to all comics generated on the platform, subject to the AI model's specific terms." },
              { q: "What export formats do you support?", a: "We export to ZIP (raw images), HTML (web reader), and PDF (print ready)." },
              { q: "How do I upgrade to Go Crazy?", a: "Currently, we are in Beta. The Go Crazy plan will be available shortly for unlimited creative freedom." }
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
