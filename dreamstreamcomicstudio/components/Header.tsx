import React from 'react';
import { UserAvatar } from './UserAvatar';
import { Zap } from 'lucide-react';
import { TokenAvailabilityPill } from './TokenAvailabilityPill';

interface HeaderProps {
    currentView: string;
    setCurrentView: (view: string) => void;
    setSettingsTab: (tab: 'profile' | 'settings' | 'billing' | 'legal' | 'contact' | 'admin' | 'preferences' | 'security') => void;
    setLastView?: (view: string) => void;
}

export const Header: React.FC<HeaderProps> = ({ currentView, setCurrentView, setSettingsTab, setLastView }) => {
    return (
        <header className="h-20 bg-white border-b-4 border-black flex items-center px-6 justify-between relative z-50 shadow-sm sticky top-0">
            {/* Logo - Universal Home Button */}
            <button
                onClick={() => setCurrentView('home')}
                className="flex items-center gap-3 transform hover:scale-105 transition-transform cursor-pointer group"
            >
                <div className="w-10 h-10 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center text-black font-display text-2xl shadow-comic transform -rotate-3 group-hover:rotate-0 transition-transform">D</div>
                <div className="flex flex-col items-start">
                    <span className="font-display text-2xl tracking-tight text-black leading-none" style={{ textShadow: '1px 1px 0px #ddd' }}>DreamStream</span>
                    <span className="font-comic font-bold text-brand-blue text-[10px] leading-none">Comic Studio</span>
                </div>
            </button>

            {/* Navigation */}
            <div className="hidden md:flex items-center gap-6">
                <nav className="flex items-center gap-4 mr-4">
                    <NavButton label="TEST LAB" active={currentView === 'test'} onClick={() => setCurrentView('test')} />
                    <NavButton label="LEARN" active={currentView === 'learn'} onClick={() => setCurrentView('learn')} />
                    <NavButton label="DASHBOARD" active={currentView === 'dashboard'} onClick={() => setCurrentView('dashboard')} />
                </nav>

                <div className="h-8 w-[2px] bg-slate-200"></div>

                <div className="flex items-center gap-4">
                    <TokenAvailabilityPill />
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-black text-white rounded-full font-bold font-mono text-[10px] border-2 border-white shadow-md">
                        <Zap size={12} className="text-brand-yellow fill-brand-yellow" />
                        <span className="opacity-80">AI POWERED</span>
                    </div>
                    <UserAvatar onClick={() => {
                        setSettingsTab('profile');
                        if (setLastView) setLastView(currentView);
                        setCurrentView('settings');
                    }} />
                </div>
            </div>
        </header>
    );
};

const NavButton = ({ label, active, onClick }: { label: string, active: boolean, onClick: () => void }) => (
    <button
        onClick={onClick}
        className={`text-xs font-bold font-mono transition-colors ${active ? 'text-brand-blue underline decoration-2 underline-offset-4' : 'text-slate-500 hover:text-black'}`}
    >
        {label}
    </button>
);
