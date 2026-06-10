import React, { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import type { CatalogModel } from '../../services/modelCatalog';
import { getModelVendor, getVendorById, type VendorMeta } from '../../services/modelVendors';
import { ProviderIcon } from './ProviderIcon';
import { SectionHeader } from './SectionHeader';

/**
 * "Browse by provider" — the catalog grouped Anthropic → its models, Google → its
 * models, etc. Every group uses the SAME standardized header (brand icon, name,
 * counts, link), the fix for ad-hoc / misaligned category headers.
 */
export const ProviderSections: React.FC<{
  models: CatalogModel[];
  renderCard: (model: CatalogModel) => React.ReactNode;
}> = ({ models, renderCard }) => {
  const groups = useMemo(() => {
    const byVendor = new Map<string, CatalogModel[]>();
    for (const model of models) {
      const id = getModelVendor(model).id;
      const list = byVendor.get(id);
      if (list) list.push(model);
      else byVendor.set(id, [model]);
    }
    return [...byVendor.entries()]
      .map(([id, list]) => ({ vendor: getVendorById(id), list }))
      .sort((a, b) => b.list.length - a.list.length || a.vendor.label.localeCompare(b.vendor.label));
  }, [models]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (!groups.length) return <div className="mt-8 text-center text-slate-500 py-16">No models match your filters.</div>;

  return (
    <div className="mt-4 space-y-6">
      {groups.map(({ vendor, list }) => (
        <ProviderGroup
          key={vendor.id}
          vendor={vendor}
          models={list}
          collapsed={collapsed.has(vendor.id)}
          onToggle={() => toggle(vendor.id)}
          renderCard={renderCard}
        />
      ))}
    </div>
  );
};

const ProviderGroup: React.FC<{
  vendor: VendorMeta;
  models: CatalogModel[];
  collapsed: boolean;
  onToggle: () => void;
  renderCard: (model: CatalogModel) => React.ReactNode;
}> = ({ vendor, models, collapsed, onToggle, renderCard }) => {
  const freeCount = models.filter((m) => m.isFree).length;
  const imageCount = models.filter((m) => m.supportsImageOutput).length;
  const textCount = models.length - imageCount;
  const meta = [
    textCount > 0 ? `${textCount} text` : null,
    imageCount > 0 ? `${imageCount} image` : null,
    freeCount > 0 ? `${freeCount} free` : null
  ].filter(Boolean).join(' · ');

  return (
    <section className="border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden">
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="w-full text-left px-4 py-3 bg-slate-50 hover:bg-brand-yellow/20 transition-colors border-b-2 border-black flex items-center gap-3"
      >
        <ProviderIcon vendorId={vendor.id} className="w-6 h-6 shrink-0" />
        <SectionHeader
          className="flex-1"
          title={vendor.label}
          count={`${models.length} model${models.length === 1 ? '' : 's'}`}
          subtitle={meta}
        />
        {vendor.url && (
          <a
            href={vendor.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-slate-400 hover:text-brand-blue shrink-0"
            title={`${vendor.label} — official docs`}
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>
      {!collapsed && (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {models.map((model) => (
            <React.Fragment key={model.id}>{renderCard(model)}</React.Fragment>
          ))}
        </div>
      )}
    </section>
  );
};
