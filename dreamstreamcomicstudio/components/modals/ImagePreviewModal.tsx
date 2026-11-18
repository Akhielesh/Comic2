import React from 'react';
import { X, Download } from 'lucide-react';
import { buttonClasses } from '../ds/Button';
import { IconButton } from '../ds/IconButton';
import { HAIRLINE, RADIUS_PANEL, RADIUS_PILL, SCRIM, SHADOW_SOFT, TWO_LINE_TEXT, Z } from '../chat/studioDesign';
import { ModalPortal } from './ModalPortal';

interface ImagePreviewModalProps {
  imageUrl: string;
  title?: string;
  onClose: () => void;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({ imageUrl, title, onClose }) => {
  return (
    <ModalPortal>
      <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center p-4`} onClick={onClose}>
        <div className="relative flex max-h-[90vh] w-full max-w-5xl flex-col items-center" onClick={e => e.stopPropagation()}>
          <div className="absolute right-0 top-0 -mt-12 flex items-center gap-2">
            <a
              href={imageUrl}
              download={`dreamstream-${Date.now()}.png`}
              aria-label="Download"
              title="Download"
              className={buttonClasses({ variant: 'outline', size: 'icon' })}
              onClick={(e) => e.stopPropagation()}
            >
              <Download aria-hidden="true" />
            </a>
            <IconButton label="Close" variant="outline" size="lg" onClick={onClose}>
              <X />
            </IconButton>
          </div>

          <img
            src={imageUrl}
            alt={title || 'Preview'}
            className={`max-h-[80vh] max-w-full bg-[var(--ds-well)] ${RADIUS_PANEL} ${HAIRLINE} ${SHADOW_SOFT}`}
          />

          {title && (
            <div className={`mt-4 max-w-full bg-[var(--ds-raised)] px-4 py-1.5 text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)] ${RADIUS_PILL} ${HAIRLINE} ${SHADOW_SOFT} ${TWO_LINE_TEXT}`}>
              {title}
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
};
