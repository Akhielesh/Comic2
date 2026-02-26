import React, { useMemo, useState } from 'react';
import { ComicForgeFormatSpec } from '../../types';
import { Button } from '../Button';

interface FormatSetupScreenProps {
  formatSpec?: ComicForgeFormatSpec;
  approved: boolean;
  onSubmit: (input: {
    readingFormat: ComicForgeFormatSpec['readingFormat'];
    platform: ComicForgeFormatSpec['platform'];
    resolutionTarget: ComicForgeFormatSpec['resolutionTarget'];
    rtlReading: boolean;
  }) => Promise<void>;
  onApprove: () => void;
}

export const FormatSetupScreen: React.FC<FormatSetupScreenProps> = ({ formatSpec, approved, onSubmit, onApprove }) => {
  const [readingFormat, setReadingFormat] = useState<ComicForgeFormatSpec['readingFormat']>('digital_paged');
  const [platform, setPlatform] = useState<ComicForgeFormatSpec['platform']>('pdf_portfolio');
  const [resolutionTarget, setResolutionTarget] = useState<ComicForgeFormatSpec['resolutionTarget']>('screen_hd_150');
  const [rtlReading, setRtlReading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canApprove = useMemo(() => !!formatSpec, [formatSpec]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit({ readingFormat, platform, resolutionTarget, rtlReading });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="font-bold text-sm">
          Reading Format
          <select
            className="mt-1 w-full border-2 border-black rounded-lg px-3 py-2"
            value={readingFormat}
            onChange={(event) => setReadingFormat(event.target.value as ComicForgeFormatSpec['readingFormat'])}
          >
            <option value="print">Print</option>
            <option value="webtoon_vertical">Webtoon / Vertical</option>
            <option value="digital_paged">Digital Paged</option>
            <option value="social_shorts">Social Shorts</option>
          </select>
        </label>

        <label className="font-bold text-sm">
          Platform
          <select
            className="mt-1 w-full border-2 border-black rounded-lg px-3 py-2"
            value={platform}
            onChange={(event) => setPlatform(event.target.value as ComicForgeFormatSpec['platform'])}
          >
            <option value="webtoon">Webtoon</option>
            <option value="tapas">Tapas</option>
            <option value="print_a4">Print A4</option>
            <option value="print_us_letter">Print US Letter</option>
            <option value="pdf_portfolio">PDF Portfolio</option>
            <option value="instagram">Instagram</option>
          </select>
        </label>

        <label className="font-bold text-sm">
          Resolution
          <select
            className="mt-1 w-full border-2 border-black rounded-lg px-3 py-2"
            value={resolutionTarget}
            onChange={(event) => setResolutionTarget(event.target.value as ComicForgeFormatSpec['resolutionTarget'])}
          >
            <option value="screen_72">Screen (72 dpi)</option>
            <option value="screen_hd_150">HD Screen (150 dpi)</option>
            <option value="print_300">Print (300 dpi)</option>
          </select>
        </label>

        <label className="font-bold text-sm flex items-center gap-3 mt-6">
          <input
            type="checkbox"
            checked={rtlReading}
            onChange={(event) => setRtlReading(event.target.checked)}
            className="h-4 w-4"
          />
          Right-to-left reading
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={handleSubmit} isLoading={isSubmitting}>Generate Format Spec</Button>
        <Button variant="secondary" disabled={!canApprove || approved} onClick={onApprove}>Approve Format</Button>
      </div>

      {formatSpec && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
          <div><strong>Canvas:</strong> {formatSpec.canvasWidthPx} x {formatSpec.canvasHeightPx}</div>
          <div><strong>Panel Density Max:</strong> {formatSpec.panelDensityMax}</div>
          <div><strong>Safe Text Min:</strong> {formatSpec.safeTextSizeMinPt}pt</div>
          {formatSpec.warnings.length > 0 && (
            <ul className="list-disc ml-5">
              {formatSpec.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
