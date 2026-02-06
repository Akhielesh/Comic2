import React, { useEffect, useRef, useState } from 'react';
import { ComicState, ComicPanel } from '../types';
import { Zap } from 'lucide-react';

interface ComicGeneratorProps {
  state: ComicState;
  onStart: () => void;
  onCancel: () => void;
  onGenerationComplete: (panels: ComicPanel[]) => void;
}

const playCompletionSound = () => {
    try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(987.77, audioContext.currentTime); // B5 note
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.5);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
        console.error("Could not play sound", e);
    }
};

export const ComicGenerator: React.FC<ComicGeneratorProps> = ({ state, onStart, onCancel, onGenerationComplete }) => {
  const hasTriggeredStart = useRef(false);
  const hasAutoAdvanced = useRef(false);
  const status = state.generationStatus;
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopInput, setStopInput] = useState('');

  useEffect(() => {
    // If not active and not finished, start it
    if (!status?.isActive && state.panels.length === 0 && !hasTriggeredStart.current) {
        hasTriggeredStart.current = true;
        onStart();
    }
  }, [status, state.panels, onStart]);

  useEffect(() => {
    if (status?.isActive && !hasTriggeredStart.current) {
      hasTriggeredStart.current = true;
    }
  }, [status?.isActive]);

  useEffect(() => {
    // Watch for completion
    const isComplete = status && !status.isActive && (
      status.progress >= 99 ||
      (typeof status.completedPanels === 'number' && typeof status.totalPanels === 'number' && status.completedPanels >= status.totalPanels) ||
      status.currentStepDescription === 'Complete'
    );
    if (isComplete && hasTriggeredStart.current && !hasAutoAdvanced.current) {
        playCompletionSound();
        hasAutoAdvanced.current = true;
        onGenerationComplete(state.panels);
    }
  }, [status, state.panels, onGenerationComplete]);

  useEffect(() => {
    if (!status || status.isActive) return;
    if (state.panels.length === 0) return;
    if (hasAutoAdvanced.current) return;
    const timer = setTimeout(() => {
      if (!status.isActive && state.panels.length > 0 && !hasAutoAdvanced.current) {
        hasAutoAdvanced.current = true;
        onGenerationComplete(state.panels);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [status?.isActive, state.panels, onGenerationComplete]);

  if (!status) return <div className="text-center py-20 font-display text-xl">Initializing Build Protocol...</div>;

  const handleStopKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && stopInput.trim().toLowerCase() === 'stop') {
      onCancel();
      setShowStopConfirm(false);
      setStopInput('');
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-20 text-center space-y-10 animate-fade-in">
        <div className="space-y-6 relative">
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 text-6xl font-display text-brand-yellow animate-bounce drop-shadow-lg" style={{ textShadow: '4px 4px 0 #000' }}>
                POW!
            </div>
            <div className="w-32 h-32 mx-auto bg-white rounded-full flex items-center justify-center border-4 border-black shadow-comic relative overflow-hidden">
                <div className="absolute inset-0 bg-brand-blue/10 animate-pulse"></div>
                <Zap className="w-16 h-16 text-brand-yellow fill-brand-yellow animate-pulse relative z-10" />
            </div>
            <h2 className="text-5xl font-display text-white drop-shadow-[4px_4px_0_#000]">Making Magic...</h2>
            <p className="text-white font-comic text-lg font-bold bg-black/20 inline-block px-4 py-1 rounded-full backdrop-blur-sm">Est. Remaining: {status.estimatedTimeRemaining}</p>
        </div>

        <div className="bg-white h-8 w-full rounded-full border-4 border-black shadow-comic overflow-hidden relative">
            <div 
                className="h-full bg-brand-yellow border-r-4 border-black transition-all duration-500 ease-out relative"
                style={{ width: `${Math.min(status.progress, 100)}%` }}
            >
                <div className="absolute inset-0 opacity-20 bg-[linear-gradient(45deg,#000_25%,transparent_25%,transparent_50%,#000_50%,#000_75%,transparent_75%,transparent)] bg-[length:20px_20px]"></div>
            </div>
        </div>

        <div className="bg-white rounded-xl border-4 border-black shadow-comic p-4 space-y-3">
          <div className="flex flex-col md:flex-row items-center justify-between gap-3">
            <div className="text-left">
              <div className="font-display text-lg">Live Panels</div>
              <div className="text-xs font-comic text-slate-500">Watch pages appear as they finish.</div>
            </div>
            {!showStopConfirm ? (
              <button
                onClick={() => setShowStopConfirm(true)}
                className="bg-brand-red text-white border-2 border-black px-4 py-2 rounded-lg font-bold uppercase text-xs"
              >
                Stop Generation
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  value={stopInput}
                  onChange={(e) => setStopInput(e.target.value)}
                  onKeyDown={handleStopKey}
                  placeholder='Type \"stop\" + Enter'
                  className="border-2 border-black rounded px-3 py-2 text-xs font-mono"
                />
                <button
                  onClick={() => { setShowStopConfirm(false); setStopInput(''); }}
                  className="border-2 border-black px-3 py-2 rounded text-xs font-bold bg-white"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 max-h-48 overflow-y-auto custom-scrollbar">
            {state.panels.filter(p => p.imageUrl).map((panel) => (
              <div key={panel.id} className="border-2 border-black rounded overflow-hidden">
                <img src={panel.imageUrl} alt={panel.description} className="w-full h-24 object-cover" />
              </div>
            ))}
            {state.panels.filter(p => p.imageUrl).length === 0 && (
              <div className="col-span-full text-xs text-slate-500 font-comic">No panels yet — they will appear here.</div>
            )}
          </div>
        </div>

        <div className="h-64 overflow-y-auto bg-black rounded-xl border-4 border-white p-6 text-left font-mono text-sm text-brand-yellow shadow-comic custom-scrollbar">
            <div className="mb-2 border-b border-white/20 pb-1 flex items-start text-white opacity-50">
                <span>Current Step: {status.currentStepDescription}</span>
            </div>
            {[...status.logs].reverse().map((log, i) => (
                <div key={i} className="mb-2 border-b border-white/20 pb-1 flex items-start">
                    <span className="mr-2 text-brand-red">{'>'}</span> {log.message}
                </div>
            ))}
            <div className="animate-pulse text-white">{'>'} _</div>
        </div>
    </div>
  );
};
