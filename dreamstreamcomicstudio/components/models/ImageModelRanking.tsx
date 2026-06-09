import React, { useState } from 'react';
import { Star, Check, X, ExternalLink, ChevronDown, Image as ImageIcon } from 'lucide-react';
import { IMAGE_MODEL_RANKING, formatImagePrice, type ImageTier } from '../../services/imageModelRanking';
import { getModelVendor } from '../../services/modelVendors';

const TIER_CLASS: Record<ImageTier, string> = {
  flagship: 'bg-brand-red text-white',
  strong: 'bg-brand-blue text-white',
  budget: 'bg-green-600 text-white',
};

/**
 * Curated ranking of image models for comic generation. For comics the decisive trait is
 * reference / identity consistency (keeping a character on-model across panels), so that column is
 * called out. Collapsible so it doesn't crowd the catalog grid.
 */
export const ImageModelRanking: React.FC<{ defaultOpen?: boolean }> = ({ defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 p-4 text-left hover:bg-brand-yellow/10 transition-colors"
      >
        <ImageIcon className="w-4 h-4 shrink-0" />
        <span className="font-display text-lg">Image model ranking — best for comics</span>
        <span className="hidden sm:inline text-[11px] text-slate-500 font-normal">
          ranked by character consistency, then quality &amp; price
        </span>
        <ChevronDown className={`w-4 h-4 ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 pb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-[10px] font-bold uppercase text-slate-500 border-b-2 border-black">
                  <th className="text-left py-2 pr-2">#</th>
                  <th className="text-left py-2 pr-2">Model</th>
                  <th className="text-left py-2 pr-2">Tier</th>
                  <th className="text-center py-2 px-2" title="Native multi-image reference — keeps characters on-model across panels">Ref&nbsp;consistency</th>
                  <th className="text-left py-2 pr-2">~Price</th>
                  <th className="text-left py-2 pr-2 hidden md:table-cell">Size</th>
                  <th className="text-left py-2 pr-2 hidden lg:table-cell">Best at</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {IMAGE_MODEL_RANKING.map((m) => {
                  const vendor = getModelVendor({ id: `${m.vendorId}/x` });
                  return (
                    <tr key={m.id} className="border-b border-dashed border-slate-200 align-top">
                      <td className="py-2 pr-2 font-mono font-bold text-slate-500">{m.rank}</td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {m.preferred && <Star className="w-3.5 h-3.5 text-brand-yellow fill-brand-yellow" aria-label="Recommended" />}
                          <span className="font-bold leading-tight">{m.name}</span>
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-black ${vendor.color}`}>{vendor.label}</span>
                          {m.usableInApp && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-300">In app</span>}
                        </div>
                        <div className="text-[11px] text-slate-500 leading-snug mt-0.5">{m.note}</div>
                      </td>
                      <td className="py-2 pr-2"><span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${TIER_CLASS[m.tier]}`}>{m.tier}</span></td>
                      <td className="py-2 px-2 text-center">
                        {m.referenceCapable
                          ? <Check className="w-4 h-4 text-green-600 inline" aria-label="Reference-capable" />
                          : <X className="w-4 h-4 text-slate-300 inline" aria-label="No native reference" />}
                      </td>
                      <td className="py-2 pr-2 font-mono text-[12px] whitespace-nowrap">{formatImagePrice(m)}</td>
                      <td className="py-2 pr-2 text-[11px] text-slate-600 hidden md:table-cell whitespace-nowrap">{m.size || '—'}</td>
                      <td className="py-2 pr-2 text-[11px] text-slate-600 hidden lg:table-cell">{m.strengths.slice(0, 2).join(', ')}</td>
                      <td className="py-2">
                        <a href={m.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-slate-400 hover:text-brand-blue inline-flex" title={`${m.source} (${m.asOf})`}>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-slate-500 mt-2">
            ★ = recommended for this app. Figures are approximate, point-in-time — verify pricing/size at each source link.
          </div>
        </div>
      )}
    </div>
  );
};
