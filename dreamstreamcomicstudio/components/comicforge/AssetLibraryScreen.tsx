import React, { useMemo, useState } from 'react';
import { ComicForgeAssetCard } from '../../types';
import { Button } from '../Button';

interface AssetLibraryScreenProps {
  cards: ComicForgeAssetCard[];
  approved: boolean;
  onRefresh: () => Promise<void>;
  onCreateCard: (input: {
    cardType: ComicForgeAssetCard['cardType'];
    name: string;
    canonicalDescription: string;
  }) => Promise<void>;
  onGenerateRefs: (assetCardId: string) => Promise<void>;
  onApprove: () => void;
}

export const AssetLibraryScreen: React.FC<AssetLibraryScreenProps> = ({ cards, approved, onRefresh, onCreateCard, onGenerateRefs, onApprove }) => {
  const [cardType, setCardType] = useState<ComicForgeAssetCard['cardType']>('character');
  const [name, setName] = useState('');
  const [canonicalDescription, setCanonicalDescription] = useState('');
  const [isWorking, setIsWorking] = useState(false);

  const lockedCount = useMemo(() => cards.filter((card) => card.status === 'locked').length, [cards]);

  const handleCreate = async () => {
    if (!name.trim() || !canonicalDescription.trim()) return;
    setIsWorking(true);
    try {
      await onCreateCard({ cardType, name: name.trim(), canonicalDescription: canonicalDescription.trim() });
      setName('');
      setCanonicalDescription('');
    } finally {
      setIsWorking(false);
    }
  };

  const handleRefresh = async () => {
    setIsWorking(true);
    try {
      await onRefresh();
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-3 gap-3">
        <select
          className="border-2 border-black rounded-lg px-3 py-2"
          value={cardType}
          onChange={(event) => setCardType(event.target.value as ComicForgeAssetCard['cardType'])}
        >
          <option value="character">Character</option>
          <option value="location">Location</option>
          <option value="prop">Prop</option>
          <option value="vehicle">Vehicle</option>
          <option value="sfx">SFX</option>
        </select>
        <input
          className="border-2 border-black rounded-lg px-3 py-2"
          placeholder="Asset name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button onClick={handleCreate} isLoading={isWorking}>Add Card</Button>
      </div>

      <textarea
        className="w-full border-2 border-black rounded-xl p-3 min-h-[90px]"
        placeholder="Canonical description"
        value={canonicalDescription}
        onChange={(event) => setCanonicalDescription(event.target.value)}
      />

      <div className="flex gap-3 flex-wrap">
        <Button variant="secondary" onClick={handleRefresh} isLoading={isWorking}>Refresh Cards</Button>
        <Button variant="secondary" disabled={cards.length === 0 || approved} onClick={onApprove}>Approve Assets</Button>
      </div>

      <div className="border-2 border-black rounded-xl bg-white p-4 text-sm">
        <div className="mb-3"><strong>Total cards:</strong> {cards.length} | <strong>Locked:</strong> {lockedCount}</div>
        <div className="space-y-2">
          {cards.map((card) => (
            <div key={card.id} className="border border-black rounded-lg p-3 bg-slate-50">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <strong>{card.name}</strong> <span className="text-xs uppercase">({card.cardType})</span>
                  <p className="text-xs mt-1">{card.canonicalDescription}</p>
                </div>
                <Button size="sm" onClick={() => onGenerateRefs(card.id)}>Generate Refs</Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
