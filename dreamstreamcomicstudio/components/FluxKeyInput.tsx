import React, { useEffect, useState } from "react";
import { syncByokKeyToServer } from "../services/byokSync";
import { Key } from "lucide-react";
import { clearFluxKey, getFluxKeyInfo, getFluxKeySuffix, setFluxKey } from "../services/appSettings";
import { Button } from "./Button";

interface FluxKeyInputProps {
  className?: string;
  compact?: boolean;
  onStatusChange?: (hasKey: boolean) => void;
}

export const FluxKeyInput: React.FC<FluxKeyInputProps> = ({ className = "", compact = false, onStatusChange }) => {
  const [input, setInput] = useState("");
  const [suffix, setSuffix] = useState<string | null>(getFluxKeySuffix());
  const [source, setSource] = useState<string>(getFluxKeyInfo().source);

  useEffect(() => {
    const info = getFluxKeyInfo();
    setSuffix(info.key ? info.key.slice(-4) : null);
    setSource(info.source);
  }, []);

  const handleSave = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setFluxKey(trimmed);

    // Mirror to the cloud via the server (server-side encryption with a server-only secret).
    await syncByokKeyToServer('flux', trimmed);

    const info = getFluxKeyInfo();
    setSuffix(info.key ? info.key.slice(-4) : null);
    setSource(info.source);
    setInput("");
    onStatusChange?.(!!info.key);
  };

  const handleClear = () => {
    clearFluxKey();
    const info = getFluxKeyInfo();
    setSuffix(info.key ? info.key.slice(-4) : null);
    setSource(info.source);
    onStatusChange?.(!!info.key);
  };

  return (
    <div className={`bg-white border-2 border-black rounded-lg p-4 ${className}`}>
      <div className="flex items-center gap-2 text-xs font-bold uppercase mb-2">
        <Key className="w-4 h-4" /> Pixazo Flux Schnell Key
      </div>
      <input
        type="password"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste Pixazo API key"
        className="w-full border-2 border-black rounded px-3 py-2 text-sm mb-2"
      />
      <div className="flex gap-2">
        <Button onClick={handleSave} size="sm" className="flex-1">
          Save Key
        </Button>
        <Button onClick={handleClear} size="sm" variant="secondary" className="flex-1">
          Clear
        </Button>
      </div>
      <div className={`mt-2 text-[11px] ${compact ? "text-slate-500" : "text-slate-600"}`}>
        Stored locally. Current: {suffix ? `••••${suffix}` : "none"} {source !== "localStorage" ? `(source: ${source})` : ""}
      </div>
    </div>
  );
};
