import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { ModalPortal } from "./ModalPortal";
import { IconButton } from "../ds/IconButton";
import { cn } from "../../lib/utils";
import {
  CHIP,
  CHIP_VARIANT,
  DIALOG_TITLE,
  FOCUS_RING,
  OVERLAY,
  OVERLINE,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  SCRIM,
  SPARK_RING_ON_ART,
  Z
} from "../chat/studioDesign";

export type MasterGalleryItem = {
  imageId: string;
  url: string;
  tag?: string;
  label?: string;
  category?: string;
  usedIn?: string[];
};

interface MasterGalleryModalProps {
  items: MasterGalleryItem[];
  initialIndex?: number;
  onClose: () => void;
}

/** One labelled fact beside the picture (tag, category, where it is used). */
const FACT = `${RADIUS_CONTROL} border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-3`;

/**
 * The project's image lightbox (the "Mastery Gallery"): one picture at a time with its tag, category and uses,
 * and a strip to jump between them. A centred modal dialog on the scrim, a layer above the Project info dialog it
 * opens from (Z.sheet over Z.scrim), titled with DIALOG_TITLE. Escape closes it; ← / → step through the pictures.
 */
export const MasterGalleryModal: React.FC<MasterGalleryModalProps> = ({ items, initialIndex = 0, onClose }) => {
  const safeIndex = Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(safeIndex);
  const titleId = `gallery-title-${useId().replace(/:/g, "")}`;
  const closeRef = useRef<HTMLButtonElement>(null);

  const active = items[activeIndex];
  const hasItems = items.length > 0 && active;

  const goPrev = () => {
    if (!hasItems) return;
    setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
  };

  const goNext = () => {
    if (!hasItems) return;
    setActiveIndex((prev) => (prev + 1) % items.length);
  };

  const metaLabel = useMemo(() => {
    if (!active) return "";
    const bits = [active.tag, active.label].filter(Boolean);
    return bits.join(" · ");
  }, [active]);

  // Focus moves into the dialog when it opens and returns where it was when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
    };
  }, []);

  // Escape closes; the arrow keys step (outside a text field). Only while this dialog is on top.
  const latest = useRef({ onClose, goPrev, goNext });
  latest.current = { onClose, goPrev, goNext };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        latest.current.onClose();
      } else if (e.key === "ArrowLeft" && items.length > 1) {
        e.preventDefault();
        latest.current.goPrev();
      } else if (e.key === "ArrowRight" && items.length > 1) {
        e.preventDefault();
        latest.current.goNext();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [items.length]);

  return (
    <ModalPortal>
      <div className={cn("fixed inset-0 flex items-center justify-center p-3 sm:p-4", Z.sheet, SCRIM)} onClick={onClose} data-testid="master-gallery">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={cn("relative flex max-h-[90dvh] w-full max-w-6xl min-w-0 flex-col overflow-y-auto p-4 sm:p-5", OVERLAY)}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={OVERLINE}>Mastery Gallery</p>
              <h2 id={titleId} className={cn(DIALOG_TITLE, "truncate")}>
                {metaLabel || "Image Preview"}
              </h2>
            </div>
            <IconButton ref={closeRef} label="Close the gallery" onClick={onClose} className="shrink-0 text-[var(--ds-muted)]">
              <X />
            </IconButton>
          </div>

          {hasItems ? (
            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_260px]">
              <div className={cn("relative flex min-w-0 items-center justify-center overflow-hidden border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)]", RADIUS_PANEL)}>
                <img src={active.url} alt={active.tag || active.label || "Mastery"} className="max-h-[60vh] w-auto max-w-full object-contain" />
                {items.length > 1 && (
                  <>
                    <IconButton
                      label="Previous image"
                      variant="outline"
                      onClick={goPrev}
                      className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full"
                    >
                      <ChevronLeft />
                    </IconButton>
                    <IconButton
                      label="Next image"
                      variant="outline"
                      onClick={goNext}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
                    >
                      <ChevronRight />
                    </IconButton>
                  </>
                )}
              </div>
              <dl className="m-0 flex min-w-0 flex-col gap-3">
                <div className={FACT}>
                  <dt className={OVERLINE}>Tag</dt>
                  <dd className="m-0 mt-1 font-mono text-sm [overflow-wrap:anywhere]">{active.tag || "n/a"}</dd>
                </div>
                <div className={FACT}>
                  <dt className={OVERLINE}>Category</dt>
                  <dd className="m-0 mt-1 text-sm font-medium [overflow-wrap:anywhere]">{active.category || "n/a"}</dd>
                </div>
                <div className={FACT}>
                  <dt className={OVERLINE}>Used In</dt>
                  <dd className="m-0 mt-2 flex flex-wrap gap-2">
                    {(active.usedIn || []).length === 0 && <span className="text-sm text-[var(--ds-muted)]">No usage data.</span>}
                    {(active.usedIn || []).map((item) => (
                      <span key={item} className={cn(CHIP, CHIP_VARIANT.filled)}>
                        {item}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="text-sm text-[var(--ds-muted)]">No images available.</p>
          )}

          {items.length > 1 && (
            <div className="mt-4 border-t border-[var(--ds-hairline-soft)] pt-3">
              <p className={cn(OVERLINE, "mb-2")}>Quick Scroll</p>
              <div className="flex gap-2 overflow-x-auto p-1 pb-2">
                {items.map((item, idx) => {
                  const current = idx === activeIndex;
                  return (
                    <button
                      key={item.imageId}
                      type="button"
                      onClick={() => setActiveIndex(idx)}
                      aria-current={current ? "true" : undefined}
                      aria-label={`Show ${item.tag || item.label || `image ${idx + 1}`}`}
                      className={cn(
                        "h-20 w-20 shrink-0 overflow-hidden border bg-[var(--ds-well)]",
                        RADIUS_CONTROL,
                        // The chosen picture: selection on art is the spark ring, set off the art (CL-0; a ring, never a fill).
                        current
                          ? cn("border-transparent", SPARK_RING_ON_ART)
                          : "border-[var(--ds-hairline)] opacity-80 hover:opacity-100",
                        FOCUS_RING
                      )}
                    >
                      <img src={item.url} alt="" className="h-full w-full object-cover" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
};
