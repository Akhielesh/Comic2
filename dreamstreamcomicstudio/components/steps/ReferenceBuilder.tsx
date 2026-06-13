
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Users, Wand2, Check, UploadCloud, Download, Image as ImageIcon, CheckSquare, Square, Zap, Box, MapPin, AlertCircle, RefreshCw } from 'lucide-react';
import { extractWorldDetails, checkConsistency } from '../../services/geminiService';
import { generateImage } from '../../services/imageService';
import { Scene, Character, Item, Location, ComicState, ContinuityState, ComicAgentSettings } from '../../types';
import { getImageUrl, saveImage } from '../../services/db';
import { Button } from '../Button';
import { ImagePreviewModal } from '../modals/ImagePreviewModal';
import { buildImagePrompt } from '../../services/imagePrompt';
import { buildContinuityFromWorld } from '../../services/continuity';
import { saveCharacterToLibrary } from '../../services/characterLibrary';
import { ExtractWorldResponse } from '../../apiTypes';
import { syncCharacterDescription, syncItemDescription, syncLocationDescription } from '../../services/worldSchema';
import { AgentStageShell } from '../AgentStageShell';
import { shouldAutoRunComicAgent } from '../../services/comicAgentSettings';

const CharacterLibraryModal = React.lazy(() => import('../modals/CharacterLibraryModal').then(module => ({ default: module.CharacterLibraryModal })));

// Declare HTML2Canvas and jsPDF for downloadable cards
declare const html2canvas: any;
declare const jspdf: any;

const LoaderIcon = () => (
  <svg className="animate-spin h-8 w-8 text-zinc-100" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
  </svg>
);

interface ReferenceBuilderProps {
  scenes: Scene[];
  script?: string; // Add script prop
  creativeDirection?: string;
  currentStyle: ComicState['stylePrompt'];
  styleImageId?: string;
  projectId: string;
  initialCharacters: Character[];
  initialItems: Item[];
  initialLocations: Location[];
  initialContinuity?: ContinuityState;
  onDataUpdate: (data: { characters: Character[], items: Item[], locations: Location[], continuity?: ContinuityState }) => void;
  onConfirm: () => void;
  agentSettings?: ComicAgentSettings;
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

const STRUCTURED_FIELDS: Record<Tab, Array<{ key: string; label: string; placeholder: string }>> = {
  characters: [
    { key: 'role', label: 'Role', placeholder: 'Captain, scout, rival...' },
    { key: 'genderPresentation', label: 'Gender / Presentation', placeholder: 'Script-stated gender, pronouns, presentation...' },
    { key: 'ageBand', label: 'Age Band', placeholder: 'Child, teen, adult, elder...' },
    { key: 'physicalTraits', label: 'Physical Traits', placeholder: 'Build, fur, face marks, silhouette...' },
    { key: 'distinguishingFeatures', label: 'Distinguishing Features', placeholder: 'Hair, face, posture, scars, signature marks...' },
    { key: 'outfit', label: 'Outfit/Gear', placeholder: 'Clothing, armor, accessories...' },
    { key: 'colorPalette', label: 'Palette', placeholder: 'Dominant colors and accents...' },
    { key: 'personality', label: 'Personality Cues', placeholder: 'Body language and expression vibe...' },
    { key: 'constraints', label: 'Constraints', placeholder: 'Avoid changes and identity bleed...' },
    { key: 'mustKeep', label: 'Must Keep', placeholder: 'Traits that must survive every panel...' },
    { key: 'evidence', label: 'Script Evidence', placeholder: 'Short source clue or quote...' }
  ],
  items: [
    { key: 'itemType', label: 'Item Type', placeholder: 'Artifact, weapon, device...' },
    { key: 'material', label: 'Material', placeholder: 'Steel, wood, neon polymer...' },
    { key: 'condition', label: 'Condition', placeholder: 'Pristine, rusty, cracked...' },
    { key: 'scale', label: 'Scale', placeholder: 'Handheld, two-handed, massive...' },
    { key: 'visualMotif', label: 'Visual Motif', placeholder: 'Runes, stars, hazard stripes...' },
    { key: 'constraints', label: 'Constraints', placeholder: 'Must remain lime-green, no glow...' }
  ],
  locations: [
    { key: 'environmentType', label: 'Environment Type', placeholder: 'Alley, temple, sewer junction...' },
    { key: 'eraMood', label: 'Era/Mood', placeholder: 'Victorian industrial, retro-future...' },
    { key: 'lighting', label: 'Lighting', placeholder: 'Dusk, flickering neon, moonlit...' },
    { key: 'landmarks', label: 'Landmarks', placeholder: 'Broken gate, vent fan, rusted valves...' },
    { key: 'palette', label: 'Palette', placeholder: 'Soot black, moss green, amber...' },
    { key: 'constraints', label: 'Constraints', placeholder: 'Keep bent bars and whirlpool visible...' }
  ]
};

export const ReferenceBuilder: React.FC<ReferenceBuilderProps> = ({
  scenes, script, creativeDirection, currentStyle, styleImageId, projectId, initialCharacters, initialItems, initialLocations, initialContinuity, onDataUpdate, onConfirm, agentSettings
}) => {
  const hasInitialWorldData = initialCharacters.length > 0 || initialItems.length > 0 || initialLocations.length > 0;
  const autoRunAgent = shouldAutoRunComicAgent(agentSettings);
  const [activeTab, setActiveTab] = useState<Tab>('characters');
  const [isLoading, setIsLoading] = useState(!hasInitialWorldData);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [isCheckingConsistency, setIsCheckingConsistency] = useState(false);
  const [consistencyWarnings, setConsistencyWarnings] = useState<Record<string, string[]>>({});
  const [previewImage, setPreviewImage] = useState<{ url: string, title: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const hasFetched = useRef(hasInitialWorldData);
  const [referenceUrlMap, setReferenceUrlMap] = useState<Record<string, string>>({});
  const [characters, setCharacters] = useState<Character[]>(initialCharacters);
  const [items, setItems] = useState<Item[]>(initialItems);
  const [locations, setLocations] = useState<Location[]>(initialLocations);
  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const [worldDiagnostics, setWorldDiagnostics] = useState<ExtractWorldResponse['diagnostics']>();
  const [worldDiagnosticsAcknowledged, setWorldDiagnosticsAcknowledged] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const entitiesRef = useRef({ characters: initialCharacters, items: initialItems, locations: initialLocations });
  const autoConfirmedWorldRef = useRef(false);

  const makeContinuity = useCallback(
    (nextCharacters: Character[], nextItems: Item[], nextLocations: Location[]) =>
      buildContinuityFromWorld(scenes, nextCharacters, nextItems, nextLocations, initialContinuity),
    [scenes, initialContinuity]
  );

  const commitWorldState = useCallback(
    (nextCharacters: Character[], nextItems: Item[], nextLocations: Location[]) => {
      const normalizedCharacters = nextCharacters.map(syncCharacterDescription);
      const normalizedItems = nextItems.map(syncItemDescription);
      const normalizedLocations = nextLocations.map(syncLocationDescription);
      entitiesRef.current = {
        characters: normalizedCharacters,
        items: normalizedItems,
        locations: normalizedLocations
      };
      setCharacters(normalizedCharacters);
      setItems(normalizedItems);
      setLocations(normalizedLocations);
      onDataUpdate({
        characters: normalizedCharacters,
        items: normalizedItems,
        locations: normalizedLocations,
        continuity: makeContinuity(normalizedCharacters, normalizedItems, normalizedLocations)
      });
    },
    [makeContinuity, onDataUpdate]
  );

  const runExtraction = useCallback(async () => {
    setExtractError(null);
    setIsLoading(true);
    try {
      const data = await extractWorldDetails(scenes, projectId, script, creativeDirection);
      commitWorldState(data.characters, data.items, data.locations);
      setWorldDiagnostics(data.diagnostics);
      setWorldDiagnosticsAcknowledged(false);
    } catch (e: any) {
      console.error(e);
      setExtractError(
        e?.message ||
        'World extraction failed — the model may have timed out. Retry, or add your cast manually.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [commitWorldState, scenes, projectId, script, creativeDirection]);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    runExtraction();
  }, [runExtraction]);

  useEffect(() => {
    autoConfirmedWorldRef.current = false;
  }, [projectId]);

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
    if (initialCharacters.length > 0 || initialItems.length > 0 || initialLocations.length > 0) {
      setIsLoading(false);
    }
  }, [initialCharacters.length, initialItems.length, initialLocations.length]);

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
    const {
      characters: currentCharacters,
      items: currentItems,
      locations: currentLocations
    } = entitiesRef.current;

    if (type === 'characters') {
      const nextCharacters = currentCharacters.map((entry) => (
        entry.id === id
          ? (Object.prototype.hasOwnProperty.call(updates, 'structured')
            ? syncCharacterDescription({ ...entry, ...updates })
            : { ...entry, ...updates })
          : entry
      ));
      commitWorldState(nextCharacters, currentItems, currentLocations);
    } else if (type === 'items') {
      const nextItems = currentItems.map((entry) => (
        entry.id === id
          ? (Object.prototype.hasOwnProperty.call(updates, 'structured')
            ? syncItemDescription({ ...entry, ...updates })
            : { ...entry, ...updates })
          : entry
      ));
      commitWorldState(currentCharacters, nextItems, currentLocations);
    } else {
      const nextLocations = currentLocations.map((entry) => (
        entry.id === id
          ? (Object.prototype.hasOwnProperty.call(updates, 'structured')
            ? syncLocationDescription({ ...entry, ...updates })
            : { ...entry, ...updates })
          : entry
      ));
      commitWorldState(currentCharacters, currentItems, nextLocations);
    }
  };

  const addEntity = (type: Tab) => {
    const id = `${type.slice(0, 4)}-${Date.now()}`;
    const name = "New " + (type === 'characters' ? "Character" : type === 'items' ? "Item" : "Location");
    const desc = "Description...";
    const {
      characters: currentCharacters,
      items: currentItems,
      locations: currentLocations
    } = entitiesRef.current;

    if (type === 'characters') {
      commitWorldState(
        [...currentCharacters, { id, name, description: desc, bio: desc, structured: {}, referenceImageIds: [] }],
        currentItems,
        currentLocations
      );
    } else if (type === 'items') {
      commitWorldState(
        currentCharacters,
        [...currentItems, { id, name, description: desc, structured: {}, referenceImageIds: [] }],
        currentLocations
      );
    } else {
      commitWorldState(
        currentCharacters,
        currentItems,
        [...currentLocations, { id, name, description: desc, structured: {}, referenceImageIds: [] }]
      );
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
      const isCharacter = type === 'characters';
      const subjectDescription = isCharacter
        ? (((entity as Character).description || (entity as Character).bio || ''))
        : (entity.description || '');
      const prompt = buildImagePrompt({
        stage: isCharacter ? "character_sheet" : "world",
        stylePrompt: currentStyle,
        subjectName: entity.name,
        subjectDescription,
        extraNotes: !isCharacter ? `Concept art for ${type === 'items' ? 'Item' : 'Location'}` : undefined,
      });
      // COST OPTIMIZATION: Smart Deduplication
      // If the entity already has a generated style-consistent image (imageId),
      // use ONLY that image as the reference. Do not send the user's uploaded photos (referenceImageIds)
      // because the generated image effectively "bakes in" those details into the correct style.
      // This saves tokens and strengthens style consistency.
      const refIds: string[] = [];

      if (styleImageId) refIds.push(styleImageId);

      if (entity.imageId) {
        refIds.push(entity.imageId);
      } else {
        refIds.push(...(entity.referenceImageIds || []));
      }
      const generated = await generateImage(prompt, "1:1", "1K", refIds, projectId, {
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
    await runWithLimit(allTasks, 4, async (task) => {
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
    const { items: currentItems, locations: currentLocations } = entitiesRef.current;
    commitWorldState([...entitiesRef.current.characters, newChar], currentItems, currentLocations);
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

  const activeList = activeTab === 'characters' ? characters : activeTab === 'items' ? items : locations;
  const contaminationDrops = (worldDiagnostics?.dropped_entities || []).filter((entry) => entry.reason === 'NOT_IN_SCRIPT');
  const requiresContaminationAck = contaminationDrops.length > 0;
  const canConfirmWorld = !requiresContaminationAck || worldDiagnosticsAcknowledged;
  const hasAnyWorld = characters.length > 0 || items.length > 0 || locations.length > 0;

  useEffect(() => {
    if (!autoRunAgent || autoConfirmedWorldRef.current) return;
    if (isLoading || extractError || isBatchGenerating || isCheckingConsistency) return;
    if (!hasAnyWorld || !canConfirmWorld) return;

    autoConfirmedWorldRef.current = true;
    onConfirm();
  }, [
    autoRunAgent,
    canConfirmWorld,
    extractError,
    hasAnyWorld,
    isBatchGenerating,
    isCheckingConsistency,
    isLoading,
    onConfirm
  ]);

  const renderEntityCard = (entity: any, type: Tab) => {
    const isSelected = selectedIds.has(entity.id);
    const editableDescription = type === 'characters'
      ? (entity.description || entity.bio || '')
      : (entity.description || '');
    return (
      <div id={`card-${entity.id}`} key={entity.id} className="group relative flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
        {/* Selection Checkbox */}
        <div
          className="absolute left-3 top-3 z-20 cursor-pointer"
          onClick={() => toggleSelection(entity.id)}
          data-export-ignore="true"
        >
          {isSelected ? <CheckSquare className="h-7 w-7 rounded-md bg-emerald-300 text-zinc-950 ring-2 ring-zinc-950" /> : <Square className="h-7 w-7 rounded-md bg-zinc-950/70 text-zinc-400 opacity-50 ring-1 ring-zinc-700 group-hover:opacity-100" />}
        </div>

        {/* Image Area */}
        <div className="relative aspect-square cursor-pointer border-b border-zinc-800 bg-zinc-900" onClick={() => entity.imageUrl && setPreviewImage({ url: entity.imageUrl, title: entity.name })}>
          {entity.imageUrl ? (
            <img src={entity.imageUrl} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(#27272a_1px,transparent_1px)] text-zinc-600 [background-size:10px_10px]">
              {type === 'characters' ? <Users size={40} /> : type === 'items' ? <Box size={40} /> : <MapPin size={40} />}
            </div>
          )}
          {generatingIds.has(entity.id) && <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm"><LoaderIcon /></div>}
        </div>

        {/* Content Area */}
        <div className="flex flex-1 flex-col gap-4 p-5">
          <div>
            <div className="flex justify-between items-start gap-2">
              <input
                value={entity.name}
                onChange={(e) => updateEntity(type, entity.id, { name: e.target.value })}
                className="w-full border-b border-transparent bg-transparent text-xl font-semibold text-zinc-100 outline-none hover:border-zinc-700 focus:border-zinc-400"
              />
              {consistencyWarnings[entity.id] && consistencyWarnings[entity.id].length > 0 && (
                <div className="group relative">
                  <AlertCircle className="w-5 h-5 text-amber-500 cursor-help" />
                  <div className="absolute right-0 top-6 z-30 hidden w-48 rounded border border-amber-800 bg-amber-950 p-2 text-[10px] text-amber-100 shadow-lg group-hover:block">
                    <strong>AI Insight:</strong>
                    <ul className="list-disc pl-3 mt-1 space-y-1">
                      {consistencyWarnings[entity.id].map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <textarea
              value={editableDescription}
              onChange={(e) => {
                const value = e.target.value;
                if (type === 'characters') {
                  updateEntity(type, entity.id, { bio: value, description: value });
                } else {
                  updateEntity(type, entity.id, { description: value });
                }
              }}
              className="mt-2 w-full resize-none rounded border border-transparent bg-transparent p-1 text-sm leading-5 text-zinc-500 outline-none hover:border-zinc-800 focus:border-zinc-500 focus:text-zinc-200"
              rows={3}
              placeholder="Enter description..."
            />
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase text-zinc-500">Structured fields</div>
            <div className="grid grid-cols-1 gap-2">
              {STRUCTURED_FIELDS[type].map((field) => (
                <div key={field.key} className="space-y-1">
                  <label className="text-[10px] font-semibold uppercase text-zinc-500">{field.label}</label>
                  <input
                    value={entity.structured?.[field.key] || ''}
                    onChange={(e) => {
                      const structured = {
                        ...(entity.structured || {}),
                        [field.key]: e.target.value
                      };
                      updateEntity(type, entity.id, { structured });
                    }}
                    className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder-zinc-600 focus:border-zinc-500"
                    placeholder={field.placeholder}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Refs */}
          <div className="flex gap-2">
            {(entity.referenceImageIds || []).map((id: string, i: number) => (
              <img key={i} src={referenceUrlMap[id]} className="h-10 w-10 rounded border border-zinc-700 object-cover" />
            ))}
            <label className="flex h-10 w-10 cursor-pointer items-center justify-center rounded border border-dashed border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900">
              <UploadCloud size={16} className="text-zinc-500" />
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
      <div className="mx-auto flex max-w-2xl flex-col items-center justify-center space-y-6 rounded-lg border border-zinc-800 bg-zinc-950 py-20 text-zinc-100 shadow-2xl">
        <div className="h-12 w-12 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-100"></div>
        <p className="text-xl font-semibold">Scouting locations and casting characters...</p>
      </div>
    )
  }

  // Auto-extraction failed (e.g. the text model timed out / 500'd). Don't strand the user on a
  // dead screen — let them retry or skip straight to building the cast by hand.
  if (extractError && !hasAnyWorld) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center justify-center space-y-5 rounded-lg border border-zinc-800 bg-zinc-950 px-6 py-16 text-center text-zinc-100 shadow-2xl">
        <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-red-950 text-red-200 ring-1 ring-red-800">
          <AlertCircle className="h-7 w-7" />
        </div>
        <p className="text-xl font-semibold">Couldn't auto-build your world</p>
        <p className="max-w-md text-sm leading-6 text-zinc-500">{extractError}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={runExtraction} icon={<RefreshCw className="w-4 h-4" />}>Retry extraction</Button>
          <Button variant="secondary" onClick={() => setExtractError(null)} icon={<Wand2 className="w-4 h-4" />}>
            Add cast manually
          </Button>
        </div>
      </div>
    )
  }

  // Add Button Card
  const AddButtonCard = ({ type }: { type: Tab }) => {
    const handleActivate = () => addEntity(type);
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleActivate();
      }
    };

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
        className="group flex min-h-[300px] cursor-pointer flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-zinc-700 bg-zinc-950 text-zinc-500 transition-all hover:border-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-zinc-900 transition-colors group-hover:bg-zinc-800">
          <Users className="w-8 h-8" />
        </div>
        <div className="text-sm font-semibold">Add {type === 'characters' ? 'character' : type === 'items' ? 'prop' : 'location'}</div>
        {type === 'characters' && (
          <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setShowLibraryModal(true); }}>
            Load from Library
          </Button>
        )}
      </div>
    );
  };

  return (
    <AgentStageShell
      eyebrow="Cast agent"
      title="Lock cast and world"
      description={autoRunAgent ? 'Autopilot will lock grounded world data and continue unless contamination needs review.' : 'Review extracted characters, locations, and props before the agent spends on reference art.'}
      icon={<Users className="h-5 w-5" />}
      actions={(
        <Button
          variant="secondary"
          onClick={onConfirm}
          disabled={!canConfirmWorld}
          className="border-zinc-100"
          icon={<Check className="h-4 w-4" />}
        >
          {autoRunAgent && canConfirmWorld ? 'Autopilot locking' : 'Use world'}
        </Button>
      )}
      sidebar={(
        <div className="space-y-5">
          <div>
            <div className="text-sm font-semibold text-zinc-200">Extracted</div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                { key: 'characters', label: 'Cast', count: characters.length },
                { key: 'items', label: 'Props', count: items.length },
                { key: 'locations', label: 'Places', count: locations.length }
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => { setActiveTab(item.key as Tab); setSelectedIds(new Set()); }}
                  className={`rounded-lg px-3 py-2 text-left transition-colors ${activeTab === item.key ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
                >
                  <span className="block text-lg font-semibold">{item.count}</span>
                  <span className="text-[10px] font-semibold uppercase">{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-sm font-semibold text-zinc-200">Continuity</div>
            <div className="mt-2 text-sm leading-6 text-zinc-500">
              {requiresContaminationAck
                ? `${contaminationDrops.length} dropped item${contaminationDrops.length === 1 ? '' : 's'} need review.`
                : 'World data is grounded and ready to lock.'}
            </div>
          </div>

          {script && (
            <Button
              onClick={handleCheckConsistency}
              isLoading={isCheckingConsistency}
              variant="secondary"
              className="w-full border-zinc-100"
              icon={<Zap className="w-4 h-4 text-amber-500" />}
            >
              Check continuity
            </Button>
          )}
          {selectedIds.size > 0 ? (
            <Button variant="secondary" onClick={downloadSelectedAsPDF} className="w-full border-zinc-100" icon={<Download />}>Download {selectedIds.size}</Button>
          ) : (
            <Button variant="secondary" onClick={handleGenerateAll} isLoading={isBatchGenerating} className="w-full border-zinc-100" icon={<Wand2 />}>Generate refs</Button>
          )}

        </div>
      )}
    >
      <div className="flex min-h-[680px] flex-col">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-zinc-200">
              {activeTab === 'characters' ? 'Cast board' : activeTab === 'items' ? 'Props board' : 'Places board'}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {activeList.length} {activeTab === 'characters' ? 'character' : activeTab === 'items' ? 'prop' : 'place'}{activeList.length === 1 ? '' : 's'}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => addEntity(activeTab)}
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-900 hover:text-white"
          >
            Add
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {requiresContaminationAck && (
            <div className="mb-5 rounded-lg border border-red-800 bg-red-950/50 p-4 text-red-100">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
                <div>
                  <div className="text-sm font-semibold">Script contamination block</div>
                  <div className="mt-1 text-sm leading-6 text-red-100/80">
                    Proposed entities not found in the source were dropped. Review before continuing.
                  </div>
                </div>
              </div>
              <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-red-900 bg-zinc-950 p-3 text-xs font-mono text-red-100/80">
                {contaminationDrops.map((entry, index) => (
                  <div key={`${entry.kind}-${entry.name}-${index}`}>
                    [{entry.kind}] {entry.name} - {entry.reason}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  id="world-contamination-ack"
                  type="checkbox"
                  checked={worldDiagnosticsAcknowledged}
                  onChange={(event) => setWorldDiagnosticsAcknowledged(event.target.checked)}
                  className="h-4 w-4"
                />
                <label htmlFor="world-contamination-ack" className="text-sm font-semibold text-red-100">
                  I reviewed dropped entities.
                </label>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
            {activeList.map(entity => renderEntityCard(entity, activeTab))}
            <AddButtonCard type={activeTab} />
          </div>
        </div>
      </div>

      {previewImage && <ImagePreviewModal imageUrl={previewImage.url} title={previewImage.title} onClose={() => setPreviewImage(null)} />}
      {showLibraryModal && (
        <React.Suspense fallback={null}>
          <CharacterLibraryModal onClose={() => setShowLibraryModal(false)} onSelect={handleLibrarySelect} />
        </React.Suspense>
      )}
    </AgentStageShell>
  );
};
