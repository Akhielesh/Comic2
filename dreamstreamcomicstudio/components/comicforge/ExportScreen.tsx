import React, { useState } from 'react';
import { ComicForgeExportPreset, ComicForgeJobSummary } from '../../types';
import { Button } from '../Button';

interface ExportScreenProps {
  latestJob?: ComicForgeJobSummary;
  onExport: (input: { preset: ComicForgeExportPreset; upscaleIfNeeded?: boolean }) => Promise<void>;
}

export const ExportScreen: React.FC<ExportScreenProps> = ({ latestJob, onExport }) => {
  const [preset, setPreset] = useState<ComicForgeExportPreset>('digital_pdf');
  const [upscaleIfNeeded, setUpscaleIfNeeded] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await onExport({ preset, upscaleIfNeeded });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-2 gap-4">
        <label className="font-bold text-sm">
          Export preset
          <select
            className="mt-1 w-full border-2 border-black rounded-lg px-3 py-2"
            value={preset}
            onChange={(event) => setPreset(event.target.value as ComicForgeExportPreset)}
          >
            <option value="webtoon_episode">Webtoon Episode</option>
            <option value="tapas_episode">Tapas Episode</option>
            <option value="print_a4_300dpi">Print A4 (300dpi)</option>
            <option value="print_us_letter_300dpi">Print US Letter (300dpi)</option>
            <option value="digital_pdf">Digital PDF</option>
            <option value="social_cover_crop">Social Cover Crop</option>
            <option value="character_card_export">Character Card Export</option>
          </select>
        </label>

        <label className="font-bold text-sm flex items-center gap-3 mt-6">
          <input
            type="checkbox"
            checked={upscaleIfNeeded}
            onChange={(event) => setUpscaleIfNeeded(event.target.checked)}
            className="h-4 w-4"
          />
          Upscale if needed
        </label>
      </div>

      <Button onClick={handleExport} isLoading={isExporting}>Export</Button>

      {latestJob && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-1">
          <div><strong>Job:</strong> {latestJob.id}</div>
          <div><strong>Status:</strong> {latestJob.status}</div>
          {latestJob.result?.downloadUrl && (
            <a className="text-blue-700 underline" href={String(latestJob.result.downloadUrl)} target="_blank" rel="noreferrer">
              Download Export
            </a>
          )}
        </div>
      )}
    </div>
  );
};
