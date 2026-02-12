import React, { useMemo, useState } from "react";
import { Sparkles, FileText, Wand2 } from "lucide-react";
import { StoryBuilderState } from "../types";
import { Button } from "./Button";
import { generateScriptDraft, generateStoryOutline } from "../services/geminiService";

type StoryBuilderProps = {
  value?: StoryBuilderState;
  projectId?: string;
  onChange: (next: StoryBuilderState) => void;
  onInsertScript: (script: string) => void;
};

const STORY_TEMPLATES = [
  {
    id: "cyber-noir",
    label: "Cyberpunk Noir",
    genre: "Cyberpunk Noir",
    tone: "Gritty, cinematic",
    setting: "Neon‑lit megacity, rain‑soaked alleys",
    characters: "A cyber detective, an informant, a rogue AI",
    conflict: "A missing memory core that exposes a conspiracy",
    ending: "Bittersweet, truth revealed but at a cost",
    length: "medium"
  },
  {
    id: "fantasy-kingdom",
    label: "Fantasy Kingdom",
    genre: "Epic Fantasy",
    tone: "Heroic, wonder",
    setting: "Ancient kingdom on floating islands",
    characters: "Young mage, knight guardian, exiled queen",
    conflict: "A storm titan threatens the sky realm",
    ending: "Hopeful, alliance restored",
    length: "long"
  },
  {
    id: "slice-life",
    label: "Slice of Life",
    genre: "Slice of Life",
    tone: "Warm, comedic",
    setting: "Small coffee shop in a quiet town",
    characters: "Barista, regular customer, aspiring musician",
    conflict: "A local music contest deadline",
    ending: "Optimistic, supportive community",
    length: "short"
  }
];

const normalize = (value?: StoryBuilderState): StoryBuilderState => ({
  templateId: value?.templateId,
  genre: value?.genre || "",
  tone: value?.tone || "",
  setting: value?.setting || "",
  characters: value?.characters || "",
  conflict: value?.conflict || "",
  ending: value?.ending || "",
  length: value?.length || "medium",
  outline: value?.outline || "",
  draftScript: value?.draftScript || "",
  lastUpdatedAt: value?.lastUpdatedAt
});

export const StoryBuilder: React.FC<StoryBuilderProps> = ({ value, projectId, onChange, onInsertScript }) => {
  const [isOutlineLoading, setIsOutlineLoading] = useState(false);
  const [isDraftLoading, setIsDraftLoading] = useState(false);

  const data = useMemo(() => normalize(value), [value]);

  const update = (patch: Partial<StoryBuilderState>) => {
    onChange({ ...data, ...patch, lastUpdatedAt: Date.now() });
  };

  const applyTemplate = (id: string) => {
    const template = STORY_TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    update({
      templateId: template.id,
      genre: template.genre,
      tone: template.tone,
      setting: template.setting,
      characters: template.characters,
      conflict: template.conflict,
      ending: template.ending,
      length: template.length as StoryBuilderState["length"]
    });
  };

  const handleGenerateOutline = async () => {
    setIsOutlineLoading(true);
    try {
      const outline = await generateStoryOutline(
        {
          genre: data.genre,
          tone: data.tone,
          setting: data.setting,
          characters: data.characters,
          conflict: data.conflict,
          ending: data.ending,
          length: data.length
        },
        projectId
      );
      update({ outline });
    } catch (e) {
      console.error(e);
    } finally {
      setIsOutlineLoading(false);
    }
  };

  const handleGenerateDraft = async () => {
    setIsDraftLoading(true);
    try {
      const draft = await generateScriptDraft(
        {
          outline: data.outline,
          genre: data.genre,
          tone: data.tone,
          setting: data.setting,
          characters: data.characters,
          length: data.length
        },
        projectId
      );
      update({ draftScript: draft });
    } catch (e) {
      console.error(e);
    } finally {
      setIsDraftLoading(false);
    }
  };

  return (
    <div className="bg-white border-4 border-black rounded-xl shadow-comic p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-2xl font-display">Story Builder</h3>
          <p className="text-sm font-comic text-slate-600">Generate outlines and scripts with guided inputs.</p>
        </div>
        <Sparkles className="w-6 h-6 text-brand-yellow" />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <label className="text-xs font-bold uppercase text-slate-500">
          Template
          <select
            value={data.templateId || ""}
            onChange={(e) => applyTemplate(e.target.value)}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Custom</option>
            {STORY_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-bold uppercase text-slate-500">
          Length
          <select
            value={data.length}
            onChange={(e) => update({ length: e.target.value as StoryBuilderState["length"] })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
          >
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="long">Long</option>
          </select>
        </label>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <label className="text-xs font-bold uppercase text-slate-500">
          Genre
          <input
            value={data.genre}
            onChange={(e) => update({ genre: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs font-bold uppercase text-slate-500">
          Tone
          <input
            value={data.tone}
            onChange={(e) => update({ tone: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs font-bold uppercase text-slate-500 md:col-span-2">
          Setting
          <input
            value={data.setting}
            onChange={(e) => update({ setting: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs font-bold uppercase text-slate-500 md:col-span-2">
          Characters
          <textarea
            value={data.characters}
            onChange={(e) => update({ characters: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
            rows={2}
          />
        </label>
        <label className="text-xs font-bold uppercase text-slate-500 md:col-span-2">
          Conflict
          <textarea
            value={data.conflict}
            onChange={(e) => update({ conflict: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
            rows={2}
          />
        </label>
        <label className="text-xs font-bold uppercase text-slate-500 md:col-span-2">
          Ending
          <textarea
            value={data.ending}
            onChange={(e) => update({ ending: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
            rows={2}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={handleGenerateOutline} isLoading={isOutlineLoading} icon={<Wand2 className="w-4 h-4" />}>
          Generate Outline
        </Button>
        <Button onClick={handleGenerateDraft} isLoading={isDraftLoading} variant="secondary" icon={<FileText className="w-4 h-4" />}>
          Generate Script Draft
        </Button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <label className="text-xs font-bold uppercase text-slate-500">
          Outline
          <textarea
            value={data.outline}
            onChange={(e) => update({ outline: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm h-32"
          />
        </label>
        <label className="text-xs font-bold uppercase text-slate-500">
          Draft Script
          <textarea
            value={data.draftScript}
            onChange={(e) => update({ draftScript: e.target.value })}
            className="mt-2 w-full border-2 border-black rounded-lg px-3 py-2 text-sm h-32"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={() => data.draftScript && onInsertScript(data.draftScript)}
          disabled={!data.draftScript}
        >
          Insert Draft Into Script
        </Button>
      </div>
    </div>
  );
};
