import React, { useState } from 'react';
import { LayoutTemplate, UploadCloud, Wand2, Check } from 'lucide-react';
import { ComicState, LayoutType, TextLayout } from '../../types';
import { analyzeLayoutFromImages } from '../../services/geminiService';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';

interface LayoutSelectorProps {
  onLayoutConfirmed: (layout: LayoutType, customPrompt?: string) => void;
  currentLayoutType?: LayoutType;
  projectId: string;
  currentTextLayout?: TextLayout;
  onTextLayoutChange?: (layout: TextLayout) => void;
}

const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
});

export const LayoutSelector: React.FC<LayoutSelectorProps> = ({ onLayoutConfirmed, currentLayoutType, projectId, currentTextLayout = 'caption', onTextLayoutChange }) => {
  const [customImages, setCustomImages] = useState<string[]>([]);
  const [customLayoutPrompt, setCustomLayoutPrompt] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  const layouts: { id: LayoutType, title: string, desc: string, visual: React.ReactNode }[] = [
    { id: 'grid', title: 'Classic Grid', desc: 'Traditional Western comic book layout. Great for dynamic action.', visual: <div className="w-full h-full grid grid-cols-2 grid-rows-3 gap-2 p-3 bg-white border-2 border-black"><div className="bg-brand-blue/20 border-2 border-black rounded-sm col-span-2 row-span-1"></div><div className="bg-brand-yellow/20 border-2 border-black rounded-sm"></div><div className="bg-brand-red/20 border-2 border-black rounded-sm"></div><div className="bg-slate-200 border-2 border-black rounded-sm col-span-2"></div></div> },
    { id: 'webtoon', title: 'Webtoon Scroll', desc: 'Vertical scrolling format optimized for mobile.', visual: <div className="w-full h-full flex flex-col gap-4 p-4 overflow-hidden bg-white border-2 border-black"><div className="w-full h-1/3 bg-brand-blue/20 border-2 border-black rounded-sm shrink-0"></div><div className="w-3/4 h-1/4 bg-brand-yellow/20 border-2 border-black rounded-sm self-end shrink-0"></div><div className="w-full h-1/3 bg-brand-red/20 border-2 border-black rounded-sm shrink-0"></div></div> },
    { id: 'strip', title: '4-Panel Strip', desc: 'Classic newspaper or "yonkoma" style. Simple and effective.', visual: <div className="w-full h-full flex flex-col gap-2 p-4 bg-white border-2 border-black"><div className="flex-1 bg-slate-100 border-2 border-black rounded-sm"></div><div className="flex-1 bg-slate-100 border-2 border-black rounded-sm"></div><div className="flex-1 bg-slate-100 border-2 border-black rounded-sm"></div><div className="flex-1 bg-slate-100 border-2 border-black rounded-sm"></div></div> },
    { id: 'manga', title: 'Manga Action', desc: 'Dynamic angles, diagonal cuts, and high impact.', visual: <div className="w-full h-full relative p-2 bg-white border-2 border-black overflow-hidden"><div className="absolute top-0 left-0 w-[70%] h-[40%] bg-brand-red/20 border-r-2 border-b-2 border-black -skew-x-12"></div><div className="absolute top-0 right-0 w-[35%] h-[30%] bg-brand-blue/20 border-l-2 border-b-2 border-black"></div><div className="absolute bottom-0 w-full h-[50%] bg-slate-200 border-t-2 border-black"></div></div> },
    { id: 'cinematic', title: 'Cinematic Wide', desc: 'Widescreen aspect ratios for an epic movie feel.', visual: <div className="w-full h-full flex flex-col gap-1 p-2 bg-white border-2 border-black"><div className="flex-1 bg-black/80 border-2 border-black"></div><div className="h-4"></div><div className="flex-1 bg-black/80 border-2 border-black"></div></div> },
    { id: 'graphic_novel', title: 'Graphic Novel', desc: 'Sophisticated, varying panel sizes for complex narratives.', visual: <div className="w-full h-full p-2 bg-white border-2 border-black grid grid-cols-3 grid-rows-3 gap-1"><div className="col-span-2 row-span-2 bg-brand-yellow/20 border-2 border-black"></div><div className="col-span-1 row-span-3 bg-slate-200 border-2 border-black"></div><div className="col-span-2 row-span-1 bg-brand-red/20 border-2 border-black"></div></div> },
    { id: 'conversation_grid', title: 'Conversation Grid', desc: 'Balanced panels for dialogue-heavy scenes.', visual: <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-2 p-3 bg-white border-2 border-black"><div className="bg-slate-200 border-2 border-black rounded-sm"></div><div className="bg-slate-200 border-2 border-black rounded-sm"></div><div className="bg-slate-200 border-2 border-black rounded-sm"></div><div className="bg-slate-200 border-2 border-black rounded-sm"></div></div> },
    { id: 'splash_insets', title: 'Splash + Insets', desc: 'Big hero panel with small inset details.', visual: <div className="w-full h-full grid grid-cols-3 grid-rows-3 gap-1 p-3 bg-white border-2 border-black"><div className="col-span-3 row-span-2 bg-brand-yellow/20 border-2 border-black"></div><div className="bg-brand-blue/20 border-2 border-black"></div><div className="bg-brand-red/20 border-2 border-black"></div><div className="bg-slate-200 border-2 border-black"></div></div> },
    { id: 'golden_ratio', title: 'Golden Ratio', desc: 'Elegant asymmetry and visual rhythm.', visual: <div className="w-full h-full grid grid-cols-3 grid-rows-3 gap-1 p-3 bg-white border-2 border-black"><div className="col-span-2 row-span-2 bg-brand-blue/20 border-2 border-black"></div><div className="bg-brand-yellow/20 border-2 border-black"></div><div className="bg-slate-200 border-2 border-black"></div><div className="bg-brand-red/20 border-2 border-black"></div></div> },
    { id: 'diagonal_action', title: 'Diagonal Action', desc: 'Energetic framing for action beats.', visual: <div className="w-full h-full grid grid-cols-2 grid-rows-3 gap-1 p-3 bg-white border-2 border-black"><div className="col-span-2 bg-brand-red/20 border-2 border-black"></div><div className="bg-brand-yellow/20 border-2 border-black"></div><div className="bg-brand-blue/20 border-2 border-black"></div><div className="col-span-2 bg-slate-200 border-2 border-black"></div></div> },
    { id: 'storyboard', title: 'Cinematic Storyboard', desc: 'Tight sequential shots for clarity.', visual: <div className="w-full h-full grid grid-cols-3 grid-rows-2 gap-1 p-3 bg-white border-2 border-black"><div className="bg-slate-200 border-2 border-black"></div><div className="bg-slate-200 border-2 border-black"></div><div className="bg-slate-200 border-2 border-black"></div><div className="bg-slate-200 border-2 border-black"></div><div className="bg-slate-200 border-2 border-black"></div><div className="bg-slate-200 border-2 border-black"></div></div> },
  ];

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const files = Array.from(e.target.files).slice(0, 4);
    const base64s = await Promise.all(files.map(fileToBase64));
    setCustomImages(base64s);
    setCustomLayoutPrompt(null); // Reset analysis on new upload
  };
  
  const handleAnalyzeLayout = async () => {
    if (customImages.length === 0) return;
    setIsAnalyzing(true);
    try {
        const result = await analyzeLayoutFromImages(customImages, projectId);
        setCustomLayoutPrompt(result);
    } catch (e) {
        console.error(e);
        setCustomLayoutPrompt("Error: Could not analyze layout.");
    } finally {
        setIsAnalyzing(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-fade-in">
        <div className="text-center space-y-2 bg-white p-6 rounded-xl border-4 border-black shadow-comic max-w-2xl mx-auto transform -rotate-1">
            <h2 className="text-4xl font-display text-black">Choose Your Layout</h2>
            <p className="text-slate-600 font-comic font-bold">How should the reader experience your story?</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {layouts.map(layout => {
                const isSelected = currentLayoutType === layout.id;
                return (
                <div key={layout.id} className={`group relative bg-white rounded-xl border-4 shadow-comic transition-all duration-300 flex flex-col overflow-hidden ${isSelected ? 'border-brand-blue ring-4 ring-brand-blue/30 scale-105 z-10' : 'border-black hover:-translate-y-2 hover:shadow-[8px_8px_0px_0px_#000]'}`}>
                    <div className="aspect-[3/4] bg-slate-50 p-4 border-b-4 border-black relative">
                        {layout.visual}
                        {isSelected && <div className="absolute top-2 right-2 bg-brand-blue text-white p-1 rounded-full border-2 border-white shadow-md"><Check size={20} strokeWidth={3}/></div>}
                    </div>
                    <div className="p-6 flex flex-col flex-1">
                        <h3 className="text-xl font-display text-black mb-2 uppercase">{layout.title}</h3>
                        <p className="text-xs text-slate-600 font-comic mb-6 flex-1">{layout.desc}</p>
                        <Button onClick={() => onLayoutConfirmed(layout.id)} variant={isSelected ? "primary" : "outline"} className={`w-full ${!isSelected ? 'group-hover:bg-brand-yellow group-hover:text-black group-hover:border-black' : ''}`}>
                            {isSelected ? "Selected" : "Select"}
                        </Button>
                    </div>
                </div>
            )})}

            {/* Custom Layout Card */}
             <div className={`group relative bg-white rounded-xl border-4 shadow-comic transition-all duration-300 flex flex-col overflow-hidden md:col-span-2 lg:col-span-1 ${currentLayoutType === 'custom' ? 'border-brand-blue ring-4 ring-brand-blue/30 scale-105 z-10' : 'border-black hover:-translate-y-2 hover:shadow-[8px_8px_0px_0px_#000]'}`}>
                <div className="aspect-[3/4] bg-slate-50 p-4 border-b-4 border-black flex flex-col gap-2 relative">
                     {currentLayoutType === 'custom' && <div className="absolute top-2 right-2 bg-brand-blue text-white p-1 rounded-full border-2 border-white shadow-md z-10"><Check size={20} strokeWidth={3}/></div>}
                    <label className="flex-1 border-2 border-dashed border-slate-400 rounded-lg flex flex-col items-center justify-center text-center p-2 text-slate-400 cursor-pointer hover:bg-slate-100 hover:border-brand-blue">
                        <UploadCloud size={32} />
                        <span className="text-xs font-bold mt-1">Upload up to 4 reference images</span>
                        <input type="file" multiple accept="image/*" className="hidden" onChange={handleFileChange} />
                    </label>
                    <div className="grid grid-cols-2 gap-2 h-1/2">
                        {customImages.map((src, i) => <img key={i} src={src} className="w-full h-full object-cover rounded border-2 border-black cursor-pointer" onClick={() => setPreviewImage(src)}/>)}
                    </div>
                </div>
                <div className="p-6 flex flex-col flex-1">
                    <h3 className="text-xl font-display text-black mb-2 uppercase">Custom Layout</h3>
                    <p className="text-xs text-slate-600 font-comic mb-4 flex-1">Let Gemini analyze your favorite layouts.</p>
                    
                    {customLayoutPrompt && (
                        <div className="mb-4 p-3 bg-brand-yellow/20 border-2 border-dashed border-black rounded-lg text-xs font-bold text-black">
                            <span className="font-display">AI Analysis: </span>{customLayoutPrompt}
                        </div>
                    )}

                    {customLayoutPrompt ? (
                         <Button onClick={() => onLayoutConfirmed('custom', customLayoutPrompt)} variant={currentLayoutType === 'custom' ? "primary" : "secondary"} icon={<Check/>}>
                             {currentLayoutType === 'custom' ? "Selected" : "Use This Layout"}
                         </Button>
                    ) : (
                         <Button onClick={handleAnalyzeLayout} variant="secondary" isLoading={isAnalyzing} disabled={customImages.length === 0} icon={<Wand2/>}>Analyze Images</Button>
                    )}
                </div>
            </div>
        </div>

        <div className="bg-white p-6 rounded-xl border-4 border-black shadow-comic max-w-4xl mx-auto">
            <h3 className="text-2xl font-display text-black mb-4">Text Layout</h3>
            <p className="text-xs text-slate-600 font-comic mb-4">Choose how dialogue is rendered on top of panels.</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(['caption', 'speech_bubbles', 'chat_bubbles', 'none'] as TextLayout[]).map(layout => (
                    <button
                        key={layout}
                        onClick={() => onTextLayoutChange?.(layout)}
                        className={`border-2 border-black rounded-lg px-3 py-3 text-xs font-bold uppercase ${currentTextLayout === layout ? 'bg-brand-yellow' : 'bg-white'}`}
                    >
                        {layout.replace('_', ' ')}
                    </button>
                ))}
            </div>
        </div>

        {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
};
