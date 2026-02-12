import React, { useMemo, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { ModalPortal } from "./ModalPortal";

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

export const MasterGalleryModal: React.FC<MasterGalleryModalProps> = ({ items, initialIndex = 0, onClose }) => {
  const safeIndex = Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(safeIndex);

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

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[230] bg-black/80 flex items-center justify-center p-4 backdrop-blur" onClick={onClose}>
        <div className="relative w-full max-w-6xl max-h-[90vh] bg-white border-4 border-black rounded-2xl shadow-comic p-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-xs font-bold uppercase text-slate-500">Mastery Gallery</div>
              <div className="font-display text-xl">{metaLabel || "Image Preview"}</div>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-brand-red">
              <X className="w-6 h-6" />
            </button>
          </div>

          {hasItems ? (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
              <div className="relative bg-slate-50 border-2 border-black rounded-xl flex items-center justify-center overflow-hidden">
                <button
                  onClick={goPrev}
                  className="absolute left-3 top-1/2 -translate-y-1/2 bg-white/90 border-2 border-black rounded-full p-2"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <img src={active.url} alt={active.tag || active.label || "Mastery"} className="max-h-[60vh] w-auto object-contain" />
                <button
                  onClick={goNext}
                  className="absolute right-3 top-1/2 -translate-y-1/2 bg-white/90 border-2 border-black rounded-full p-2"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-3">
                <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                  <div className="text-xs font-bold uppercase text-slate-500">Tag</div>
                  <div className="mt-1 font-mono text-sm">{active.tag || "n/a"}</div>
                </div>
                <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                  <div className="text-xs font-bold uppercase text-slate-500">Category</div>
                  <div className="mt-1 text-sm font-bold">{active.category || "n/a"}</div>
                </div>
                <div className="border-2 border-black rounded-lg p-3 bg-slate-50">
                  <div className="text-xs font-bold uppercase text-slate-500">Used In</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(active.usedIn || []).length === 0 && (
                      <span className="text-xs font-comic text-slate-500">No usage data.</span>
                    )}
                    {(active.usedIn || []).map((item) => (
                      <span key={item} className="px-2 py-1 bg-white border-2 border-black rounded-full text-xs font-bold">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm font-comic text-slate-600">No images available.</div>
          )}

          {items.length > 1 && (
            <div className="mt-4 border-t-2 border-black pt-3">
              <div className="text-xs font-bold uppercase text-slate-500 mb-2">Quick Scroll</div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {items.map((item, idx) => (
                  <button
                    key={item.imageId}
                    onClick={() => setActiveIndex(idx)}
                    className={`w-20 h-20 border-2 rounded-lg overflow-hidden ${idx === activeIndex ? 'border-brand-blue ring-2 ring-brand-blue/50' : 'border-black'}`}
                  >
                    <img src={item.url} alt={item.tag || item.label || "thumbnail"} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
};
