
import React, { useState, useEffect, useRef } from 'react';
import { Users, Wand2, Check, UploadCloud, Download, Image as ImageIcon, CheckSquare, Square, Zap, Box, MapPin, AlertCircle } from 'lucide-react';
import { extractWorldDetails, checkConsistency } from '../../services/geminiService';
import { generateImage } from '../../services/imageService';
import { Scene, Character, Item, Location, ComicState, ContinuityState } from '../../types';
import { getImageUrl, saveImage } from '../../services/db';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { buildContinuityFromWorld } from '../../services/continuity';
import { saveCharacterToLibrary } from '../../services/characterLibrary';

const CharacterLibraryModal = React.lazy(() => import('../modals/CharacterLibraryModal').then(module => ({ default: module.CharacterLibraryModal })));

// Declare HTML2Canvas and jsPDF for downloadable cards
declare const html2canvas: any;
declare const jspdf: any;

const LoaderIcon = () => (
  <svg className="animate-spin h-8 w-8 text-brand-blue" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
  </svg>
);

interface ReferenceBuilderProps {
  scenes: Scene[];
  script?: string; // Add script prop
  currentStyle: ComicState['stylePrompt'];
  projectId: string;
  initialCharacters: Character[];
  initialItems: Item[];
  initialLocations: Location[];
  initialContinuity?: ContinuityState;
  onDataUpdate: (data: { characters: Character[], items: Item[], locations: Location[], continuity?: ContinuityState }) => void;
  onConfirm: () => void;
}

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

type Tab = 'characters' | 'items' | 'locations';

export const ReferenceBuilder: React.FC<ReferenceBuilderProps> = ({
  scenes, script, currentStyle, projectId, initialCharacters, initialItems, initialLocations, initialContinuity, onDataUpdate, onConfirm
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('characters');
  const [isLoading, setIsLoading] = useState(initialCharacters.length === 0 && initialItems.length === 0);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [isCheckingConsistency, setIsCheckingConsistency] = useState(false);
  const [consistencyWarnings, setConsistencyWarnings] = useState<Record<string, string[]>>({});
  const [previewImage, setPreviewImage] = useState<{ url: string, title: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const hasFetched = useRef(initialCharacters.length > 0);
  const [referenceUrlMap, setReferenceUrlMap] = useState<Record<string, string>>({});
  const [characters, setCharacters] = useState<Character[]>(initialCharacters);
  const [items, setItems] = useState<Item[]>(initialItems);
  const [locations, setLocations] = useState<Location[]>(initialLocations);
  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const entitiesRef = useRef({ characters: initialCharacters, items: initialItems, locations: initialLocations });

  const makeContinuity = (nextCharacters: Character[], nextItems: Item[], nextLocations: Location[]) =>
    buildContinuityFromWorld(scenes, nextCharacters, nextItems, nextLocations, initialContinuity);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    const fetchWorld = async () => {
      try {
        const data = await extractWorldDetails(scenes, projectId);
        onDataUpdate({ ...data, continuity: makeContinuity(data.characters, data.items, data.locations) });
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    };
    fetchWorld();
  }, [scenes, onDataUpdate, projectId]);

  useEffect(() => {
    setCharacters(initialCharacters);
  }, [initialCharacters]);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    setLocations(initialLocations);
  }, [initialLocations]);

  useEffect(() => {
    entitiesRef.current = { characters, items, locations };
  }, [characters, items, locations]);

  useEffect(() => {
    const loadReferenceUrls = async () => {
      const map: Record<string, string> = {};
      const allEntities = [...characters, ...items, ...locations];
      for (const entity of allEntities) {
        for (const id of entity.referenceImageIds || []) {
          if (!map[id]) {
            const url = await getImageUrl(id);
            if (url) map[id] = url;
          }
        }
      }
      setReferenceUrlMap(map);
    };
    loadReferenceUrls();
  }, [characters, items, locations, projectId]);

  // Generic handlers for updating any entity list
  const updateEntity = (type: Tab, id: string, updates: any) => {
    if (type === 'characters') {
      setCharacters(prev => {
        const updated = prev.map(c => c.id === id ? { ...c, ...updates } : c);
        const { items: currentItems, locations: currentLocations } = entitiesRef.current;
        onDataUpdate({
          characters: updated,
          items: currentItems,
          locations: currentLocations,
          continuity: makeContinuity(updated, currentItems, currentLocations)
        });
        return updated;
      });
    } else if (type === 'items') {
      setItems(prev => {
        const updated = prev.map(i => i.id === id ? { ...i, ...updates } : i);
        const { characters: currentCharacters, locations: currentLocations } = entitiesRef.current;
        onDataUpdate({
          characters: currentCharacters,
          items: updated,
          locations: currentLocations,
          continuity: makeContinuity(currentCharacters, updated, currentLocations)
        });
        return updated;
      });
    } else {
      setLocations(prev => {
        const updated = prev.map(l => l.id === id ? { ...l, ...updates } : l);
        const { characters: currentCharacters, items: currentItems } = entitiesRef.current;
        onDataUpdate({
          characters: currentCharacters,
          items: currentItems,
          locations: updated,
          continuity: makeContinuity(currentCharacters, currentItems, updated)
        });
        return updated;
      });
    }
  };

  const addEntity = (type: Tab) => {
    const id = `${type.slice(0, 4)}-${Date.now()}`;
    const name = "New " + (type === 'characters' ? "Character" : type === 'items' ? "Item" : "Location");
    const desc = "Description...";

    if (type === 'characters') {
      setCharacters(prev => [...prev, { id, name, description: desc, bio: desc, referenceImageIds: [] }]);
    } else if (type === 'items') {
      setItems(prev => [...prev, { id, name, description: desc, referenceImageIds: [] }]);
    } else {
      setLocations(prev => [...prev, { id, name, description: desc, referenceImageIds: [] }]);
    }
  };

  const handleRefUpload = async (type: Tab, id: string, files: FileList | null) => {
    if (!files) return;
    const fileArray = Array.from(files).slice(0, 3);
    const base64s = await Promise.all(fileArray.map(fileToBase64));
    const ids = await Promise.all(base64s.map(saveImage));

    const list = type === 'characters' ? characters : type === 'items' ? items : locations;
    const entity = list.find(e => e.id === id);
    if (entity) {
      updateEntity(type, id, { referenceImageIds: [...(entity.referenceImageIds || []), ...ids].slice(0, 3) });
    }
    const entries: Record<string, string> = {};
    for (const refId of ids) {
      const url = await getImageUrl(refId);
      if (url) entries[refId] = url;
    }
    setReferenceUrlMap(prev => ({ ...prev, ...entries }));
  };

  const markGenerating = (id: string, active: boolean) => {
    setGeneratingIds(prev => {
      const next = new Set(prev);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const generateEntityImage = async (type: Tab, entityId: string) => {
    const list = type === 'characters' ? characters : type === 'items' ? items : locations;
    const entity = list.find(e => e.id === entityId);
    if (!entity) return;

    markGenerating(entity.id, true);
    try {
      const prompt = buildImagePrompt({
        stage: "world",
        stylePrompt: currentStyle,
        subjectName: entity.name,
        subjectDescription: entity.description,
        extraNotes: `Concept art for ${type === 'characters' ? 'Character' : type === 'items' ? 'Item' : 'Location'}`
      });
      const generated = await generateImage(prompt, "1:1", "1K", entity.referenceImageIds || [], projectId, {
        stage: "world",
        meta: {
          source: { type: type === 'characters' ? 'character' : type === 'items' ? 'item' : 'location', id: entity.id, label: entity.name },
          entityType: type
        }
      });
      if (generated?.imageUrl) {
        updateEntity(type, entity.id, { imageId: generated.imageId, imageUrl: generated.imageUrl });
      }
    } catch (e) { console.error(e); }
    finally { markGenerating(entity.id, false); }
  };

  const handleCheckConsistency = async () => {
    if (!script) return;
    setIsCheckingConsistency(true);
    setConsistencyWarnings({});
    try {
      const warnings = await checkConsistency(script, {
        characters,
        items,
        locations
      });
      setConsistencyWarnings(warnings);
    } catch (e) {
      console.error("Consistency check failed", e);
    } finally {
      setIsCheckingConsistency(false);
    }
  };

  const handleGenerateAll = async () => {
    // Gather all entities that need images from ALL categories
    const allTasks: { type: Tab, id: string }[] = [];

    const missingChars = characters.filter(c => !c.imageUrl).map(c => ({ type: 'characters' as Tab, id: c.id }));
    const missingItems = items.filter(i => !i.imageUrl).map(i => ({ type: 'items' as Tab, id: i.id }));
    const missingLocs = locations.filter(l => !l.imageUrl).map(l => ({ type: 'locations' as Tab, id: l.id }));

    allTasks.push(...missingChars, ...missingItems, ...missingLocs);

    if (allTasks.length === 0) return;

    const runWithLimit = async <T,>(tasks: T[], limit: number, handler: (item: T) => Promise<void>) => {
      const queue = [...tasks];
      const workers = new Array(Math.min(limit, queue.length)).fill(null).map(async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) break;
          await handler(item);
        }
      });
      await Promise.all(workers);
    };

    setIsBatchGenerating(true);
    await runWithLimit(allTasks, 3, async (task) => {
      await generateEntityImage(task.type, task.id);
    });
    setIsBatchGenerating(false);
  };

  const downloadCardAs = async (elementId: string, name: string, format: 'pdf' | 'image') => {
    const element = document.getElementById(elementId);
    if (!element) return;

    try {
      const canvas = await html2canvas(element, {
        scale: 2,
        backgroundColor: '#ffffff',
        ignoreElements: (el: HTMLElement) => el.dataset.exportIgnore === 'true'
      });
      if (format === 'image') {
        const imgData = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `${name.replace(/\s+/g, '_')}_card.png`;
        link.href = imgData;
        link.click();
      } else {
        const { jsPDF } = jspdf;
        const pdf = new jsPDF('p', 'mm', 'a5');
        const imgData = canvas.toDataURL('image/png');
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        pdf.save(`${name.replace(/\s+/g, '_')}_card.pdf`);
      }
    } catch (e) { console.error("Download failed", e); }

  };

  const handleSaveToLibrary = async (character: Character) => {
    try {
      if (!confirm(`Save "${character.name}" to your Character Library? This will make it available in all your projects.`)) return;
      await saveCharacterToLibrary(character);
      alert("Saved to Library!");
    } catch (e: any) {
      alert("Failed to save: " + (e.message || "Unknown error"));
    }
  };

  const handleLibrarySelect = (libraryItem: Character) => {
    // Clone library item to new character with new ID to link to project
    const newChar: Character = {
      ...libraryItem,
      id: `char-lib-${Date.now()}`,
      referenceImageIds: libraryItem.referenceImageIds || []
    };
    setCharacters(prev => [...prev, newChar]);
    setShowLibraryModal(false);
  };

  const downloadSelectedAsPDF = async () => {
    if (selectedIds.size === 0) return;
    const { jsPDF } = jspdf;
    const pdf = new jsPDF('p', 'mm', 'a5');
    let isFirstPage = true;

    for (const id of selectedIds) {
      const element = document.getElementById(`card-${id}`);
      if (element) {
        if (!isFirstPage) {
          pdf.addPage();
        }
        const canvas = await html2canvas(element, {
          scale: 2,
          backgroundColor: '#ffffff',
          ignoreElements: (el: HTMLElement) => el.dataset.exportIgnore === 'true'
        });
        const imgData = canvas.toDataURL('image/png');
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        isFirstPage = false;
      }
    }
    pdf.save(`DreamStream_Collection.pdf`);
  };

  const toggleSelection = (id: string) => {
    const newSelection = new Set(selectedIds);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedIds(newSelection);
  };

  const renderEntityCard = (entity: any, type: Tab) => {
    const isSelected = selectedIds.has(entity.id);
    return (
      <div id={`card-${entity.id}`} key={entity.id} className="bg-white rounded-xl border-4 shadow-comic overflow-hidden flex flex-col relative group">
        {/* Selection Checkbox */}
        <div
          className="absolute top-3 left-3 z-20 cursor-pointer"
          onClick={() => toggleSelection(entity.id)}
          data-export-ignore="true"
        >
          {isSelected ? <CheckSquare className="w-8 h-8 text-white bg-brand-blue rounded-md border-2 border-white shadow-lg" /> : <Square className="w-8 h-8 text-black bg-white/70 rounded-md opacity-50 group-hover:opacity-100" />}
        </div>

        {/* Image Area */}
        <div className="aspect-square bg-slate-100 relative border-b-4 border-black cursor-pointer" onClick={() => entity.imageUrl && setPreviewImage({ url: entity.imageUrl, title: entity.name })}>
          {entity.imageUrl ? (
            <img src={entity.imageUrl} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-300 bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:10px_10px]">
              {type === 'characters' ? <Users size={40} /> : type === 'items' ? <Box size={40} /> : <MapPin size={40} />}
            </div>
          )}
          {generatingIds.has(entity.id) && <div className="absolute inset-0 bg-white/80 flex items-center justify-center backdrop-blur-sm"><LoaderIcon /></div>}
        </div>

        {/* Content Area */}
        <div className="p-5 flex-1 flex flex-col gap-4 bg-white">
          <div>
            <div className="flex justify-between items-start gap-2">
              <input
                value={entity.name}
                onChange={(e) => updateEntity(type, entity.id, { name: e.target.value })}
                className="w-full font-display text-2xl border-b-2 border-transparent hover:border-black focus:border-brand-blue outline-none bg-transparent"
              />
              {consistencyWarnings[entity.id] && consistencyWarnings[entity.id].length > 0 && (
                <div className="group relative">
                  <AlertCircle className="w-5 h-5 text-amber-500 cursor-help" />
                  <div className="absolute right-0 top-6 w-48 bg-amber-50 border border-amber-200 p-2 rounded text-[10px] text-amber-800 shadow-lg z-30 hidden group-hover:block">
                    <strong>AI Insight:</strong>
                    <ul className="list-disc pl-3 mt-1 space-y-1">
                      {consistencyWarnings[entity.id].map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <textarea
              value={entity.bio || entity.description} // Fallback for items/locs that might not have bio
              onChange={(e) => updateEntity(type, entity.id, { [type === 'characters' ? 'bio' : 'description']: e.target.value })}
              className="w-full text-sm font-comic text-slate-600 mt-2 resize-none bg-transparent border-2 border-transparent hover:border-slate-200 focus:border-brand-blue rounded p-1"
              rows={3}
              placeholder="Enter description..."
            />
          </div>

          {/* Refs */}
          <div className="flex gap-2">
            {(entity.referenceImageIds || []).map((id: string, i: number) => (
              <img key={i} src={referenceUrlMap[id]} className="w-10 h-10 rounded border border-black object-cover" />
            ))}
            <label className="w-10 h-10 flex items-center justify-center border-2 border-dashed border-slate-400 rounded cursor-pointer hover:bg-slate-100">
              <UploadCloud size={16} className="text-slate-400" />
              <input type="file" hidden multiple onChange={(e) => handleRefUpload(type, entity.id, e.target.files)} />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-2 mt-auto">
            <Button size="sm" variant="secondary" onClick={() => generateEntityImage(type, entity.id)} icon={<Wand2 size={14} />}>Gen</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadCardAs(`card-${entity.id}`, entity.name, 'image')} icon={<ImageIcon size={14} />}>Img</Button>
            <Button size="sm" variant="secondary" onClick={() => downloadCardAs(`card-${entity.id}`, entity.name, 'pdf')} icon={<Download size={14} />}>PDF</Button>

            {type === 'characters' && (
              <Button size="sm" variant="secondary" onClick={() => handleSaveToLibrary(entity)} icon={<UploadCloud size={14} />}>Save</Button>
            )}
          </div>
        </div>
      </div>
    )
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-6 bg-white rounded-xl border-4 border-black shadow-comic max-w-2xl mx-auto">
        <div className="animate-spin w-12 h-12 border-4 border-brand-blue border-t-transparent rounded-full"></div>
        <p className="font-display text-xl">Scouting Locations & Casting Actors...</p>
      </div>
    )
  }

  const activeList = activeTab === 'characters' ? characters : activeTab === 'items' ? items : locations;

  // Add Button Card
  const AddButtonCard = ({ type }: { type: Tab }) => (
    <button
      onClick={() => addEntity(type)}
      className="bg-slate-50 border-4 border-dashed border-slate-300 rounded-xl flex flex-col items-center justify-center min-h-[300px] gap-4 text-slate-400 hover:text-brand-blue hover:border-brand-blue hover:bg-brand-blue/5 transition-all group"
    >
      <div className="w-16 h-16 rounded-full bg-slate-200 group-hover:bg-brand-blue group-hover:text-white flex items-center justify-center transition-colors">
        <Users className="w-8 h-8" />
      </div>
      <div className="font-bold font-display text-lg">Add {type === 'characters' ? 'Character' : type === 'items' ? 'Item' : 'Location'}</div>
      {type === 'characters' && (
        <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setShowLibraryModal(true); }}>
          Load from Library
        </Button>
      )}
    </button>
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in">
      <div className="bg-white p-4 rounded-xl border-4 border-black shadow-comic flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h2 className="text-3xl font-display">World Builder</h2>
          <p className="text-slate-600 font-comic">Define your cast, props, and locations.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-2 bg-slate-100 p-1 rounded-lg border-2 border-black">
            {['characters', 'items', 'locations'].map((t) => (
              <button
                key={t}
                onClick={() => { setActiveTab(t as Tab); setSelectedIds(new Set()); }}
                className={`px-4 py-2 rounded font-bold uppercase text-xs transition-all ${activeTab === t ? 'bg-brand-yellow text-black shadow-sm border border-black' : 'text-slate-500 hover:text-black'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {script && (
            <Button
              onClick={handleCheckConsistency}
              isLoading={isCheckingConsistency}
              variant="secondary"
              className="text-amber-700 bg-amber-50 hover:bg-amber-100 border-amber-200"
              icon={<Zap className="w-4 h-4 text-amber-500" />}
            >
              Analyze
            </Button>
          )}
          {selectedIds.size > 0 ? (
            <Button onClick={downloadSelectedAsPDF} icon={<Download />}>Download {selectedIds.size} as PDF</Button>
          ) : (
            <Button onClick={handleGenerateAll} isLoading={isBatchGenerating} icon={<Wand2 />}>Generate All</Button>
          )}
          <Button onClick={onConfirm} variant="primary">Confirm World <Check className="ml-2 w-4 h-4" /></Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {activeList.map(entity => renderEntityCard(entity, activeTab))}
        <AddButtonCard type={activeTab} />
      </div>

      {previewImage && <ImagePreviewModal imageUrl={previewImage.url} title={previewImage.title} onClose={() => setPreviewImage(null)} />}
      {showLibraryModal && (
        <React.Suspense fallback={null}>
          <CharacterLibraryModal onClose={() => setShowLibraryModal(false)} onSelect={handleLibrarySelect} />
        </React.Suspense>
      )}
    </div>
  );
};
