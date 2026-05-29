import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { encryptKey } from "../services/crypto";
import { Key } from "lucide-react";
import {
  clearOpenRouterKey,
  getOpenRouterKeyInfo,
  getOpenRouterKeySuffix,
  setOpenRouterKey
} from "../services/appSettings";
import { Button } from "./Button";

interface OpenRouterKeyInputProps {
  className?: string;
  compact?: boolean;
  onStatusChange?: (hasKey: boolean) => void;
}

export const OpenRouterKeyInput: React.FC<OpenRouterKeyInputProps> = ({
  className = "",
  compact = false,
  onStatusChange
}) => {
  const [input, setInput] = useState("");
  const [suffix, setSuffix] = useState<string | null>(getOpenRouterKeySuffix());
  const [source, setSource] = useState<string>(getOpenRouterKeyInfo().source);

  useEffect(() => {
    const info = getOpenRouterKeyInfo();
    setSuffix(info.key ? info.key.slice(-4) : null);
    setSource(info.source);
  }, []);

  const refresh = () => {
    const info = getOpenRouterKeyInfo();
    setSuffix(info.key ? info.key.slice(-4) : null);
    setSource(info.source);
    onStatusChange?.(!!info.key);
  };

  const handleSave = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setOpenRouterKey(trimmed);

    // Best-effort sync to the encrypted user_api_keys table (mirrors FluxKeyInput).
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { encrypted, iv } = await encryptKey(trimmed);
        await supabase.from('user_api_keys').upsert({
          user_id: user.id,
          provider: 'openrouter',
          encrypted_key: encrypted,
          iv
        }, { onConflict: 'user_id,provider' });
      }
    } catch (e) {
      console.error("Failed to sync OpenRouter key to DB", e);
    }

    setInput("");
    refresh();
  };

  const handleClear = () => {
    clearOpenRouterKey();
    refresh();
  };

  return (
    <div className={`bg-white border-2 border-black rounded-lg p-4 ${className}`}>
      <div className="flex items-center gap-2 text-xs font-bold uppercase mb-2">
        <Key className="w-4 h-4" /> OpenRouter API Key
      </div>
      <p className="text-[11px] text-slate-600 mb-2">
        Bring your own OpenRouter key to run the unified model gateway on your own account.
        Get one at{" "}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-blue-600 underline">
          openrouter.ai/keys
        </a>
        . When set, generation uses your key and bypasses platform credits (BYOK free tier).
      </p>
      <input
        type="password"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste OpenRouter API key (sk-or-...)"
        className="w-full border-2 border-black rounded px-3 py-2 text-sm mb-2 font-mono"
      />
      <div className="flex gap-2">
        <Button onClick={handleSave} size="sm" className="flex-1" disabled={!input.trim()}>
          Save Key
        </Button>
        <Button onClick={handleClear} size="sm" variant="secondary" className="flex-1">
          Clear
        </Button>
      </div>
      <div className={`mt-2 text-[11px] ${compact ? "text-slate-500" : "text-slate-600"}`}>
        Stored locally. Current: {suffix ? `••••${suffix}` : "none"}{" "}
        {source !== "localStorage" ? `(source: ${source})` : ""}
      </div>
    </div>
  );
};
