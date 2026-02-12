import React, { useState, useEffect } from 'react';
import { IMAGE_MODELS } from '../services/imageModels';
import { TEXT_MODELS } from '../services/modelPolicy';
import { getAllModelKeys, setModelSpecificKey, deleteModelKey } from '../services/appSettings';
import { Button } from './Button';
import { Trash2, Edit2, Save, Key, CheckCircle2 } from 'lucide-react';

export const KeyManager: React.FC = () => {
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [selectedModelId, setSelectedModelId] = useState<string>(TEXT_MODELS[0]?.id || IMAGE_MODELS[0]?.id || "");
    const [inputKey, setInputKey] = useState("");
    const [isEditing, setIsEditing] = useState(false);

    const availableModels = [
        ...IMAGE_MODELS,
        ...TEXT_MODELS.map((model) => ({
            id: model.id,
            label: `${model.label} (Text)`,
            provider: "gemini" as const
        }))
    ];

    useEffect(() => {
        setKeys(getAllModelKeys());
    }, []);

    const handleSave = () => {
        if (!inputKey.trim()) return;

        setModelSpecificKey(selectedModelId, inputKey.trim());
        setKeys(getAllModelKeys());
        setInputKey("");
        setIsEditing(false);
    };

    const handleDelete = (modelId: string) => {
        if (!confirm("Are you sure you want to delete this key?")) return;
        deleteModelKey(modelId);
        setKeys(getAllModelKeys());
    };

    const handleEdit = (modelId: string) => {
        setSelectedModelId(modelId);
        setInputKey(keys[modelId] || "");
        setIsEditing(true);
    };

    const getModelLabel = (id: string) => {
        return availableModels.find(m => m.id === id)?.label || id;
    };

    const selectedModel = availableModels.find((model) => model.id === selectedModelId);
    const selectedProvider = selectedModel?.provider || (selectedModelId.includes('flux') ? 'flux' : 'gemini');

    return (
        <div className="bg-slate-50 border-2 border-black rounded-xl p-6 space-y-6">
            <h3 className="font-display text-xl">API Key Configuration</h3>

            {/* Input Section */}
            <div className="bg-white border-2 border-black rounded-lg p-4 space-y-4">
                <div className="space-y-2">
                    <label className="text-xs font-bold uppercase">Select Model</label>
                    <select
                        value={selectedModelId}
                        onChange={(e) => {
                            setSelectedModelId(e.target.value);
                            setInputKey("");
                            setIsEditing(false);
                        }}
                        className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm bg-white"
                    >
                        {availableModels.map(m => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                    </select>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-bold uppercase">Enter API Key</label>
                    <div className="relative">
                        <Key className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                            type="password"
                            value={inputKey}
                            onChange={(e) => setInputKey(e.target.value)}
                            placeholder={`Key for ${availableModels.find(m => m.id === selectedModelId)?.label || selectedModelId}`}
                            className="w-full border-2 border-black rounded-lg pl-10 pr-3 py-2 text-sm font-mono"
                        />
                    </div>
                    <p className="text-[10px] text-slate-500">
                        {selectedProvider === 'flux'
                            ? "Requires Pixazo Flux key for Flux models."
                            : "Requires Google AI Studio Gemini key (starts with AI...)."}
                    </p>
                </div>

                <div className="flex justify-end">
                    <Button size="sm" onClick={handleSave} icon={<Save size={14} />} disabled={!inputKey}>
                        {keys[selectedModelId] ? "Update Key" : "Save Key"}
                    </Button>
                </div>
            </div>

            {/* List Section */}
            <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase text-slate-500">Configured Keys</h4>
                {Object.keys(keys).length === 0 && (
                    <div className="text-sm text-slate-400 italic">No custom keys configured. Using system defaults.</div>
                )}
                {Object.entries(keys).map(([modelId, key]) => (
                    <div key={modelId} className="flex items-center justify-between bg-white border-2 border-black rounded-lg p-3">
                        <div>
                            <div className="text-sm font-bold flex items-center gap-2">
                                {getModelLabel(modelId)}
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                            </div>
                            <div className="text-[10px] font-mono text-slate-500 mt-1">
                                {key.slice(0, 4)}••••••••{key.slice(-4)}
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => handleEdit(modelId)}
                                className="p-2 hover:bg-slate-100 rounded text-slate-600"
                                title="Edit"
                            >
                                <Edit2 size={14} />
                            </button>
                            <button
                                onClick={() => handleDelete(modelId)}
                                className="p-2 hover:bg-red-50 rounded text-red-500"
                                title="Delete"
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
