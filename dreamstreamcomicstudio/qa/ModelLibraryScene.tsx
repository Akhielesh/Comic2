// Full-page, signed-out Model Library fixture for the bounded shared-responsive project.
// This deliberately avoids the kit's padded/overflow-hidden frame and the full app-scene
// matrix: the browser measures the real product's document width and view navigation.
import React from 'react';
import { ModelLibrary } from '../components/ModelLibrary';
import type { CatalogModel, CatalogResponse } from '../services/modelCatalog';
import { recordQaOp } from '../components/comicstudio/testing/qaController';

const NOW = Date.UTC(2026, 10, 13);
const model = (id: string, name: string, source: CatalogModel['source']): CatalogModel => ({
  id, name, source,
  description: 'Synthetic model for offline layout checks.',
  contextLength: 128_000,
  inputModalities: ['text'], outputModalities: ['text'], supportedParameters: [],
  pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imagePerImage: 0, requestFlat: 0 },
  isFree: false, costClass: 'paid', costBand: 'low',
  supportsImageOutput: false, supportsImageInput: false, supportsJsonOutput: false,
  roles: ['text-brain'], drawbacks: [], possibilities: ['Text chat']
});

const models = [model('qa/text-one', 'QA Text One', 'openrouter'), model('qa/text-two', 'QA Text Two', 'openai')];
const catalog: CatalogResponse = { models, count: models.length, total: models.length, fetchedAt: NOW, degraded: false };

/** Only GETs on the Model Library fixture use these synthetic API responses. */
export const modelLibraryResponse = (path: string): unknown => {
  switch (path) {
    case '/api/models/catalog': return catalog;
    case '/api/models/speed': return { models: {} };
    case '/api/models/popularity': return { window: 'week', generatedAt: new Date(NOW).toISOString(), models: [] };
    case '/api/models/bench-scores': return { runId: null, runAt: null, scores: [] };
    case '/api/models/usage-monthly': return { rows: [] };
    default: return undefined;
  }
};

export const ModelLibraryScene: React.FC = () => (
  <main aria-label="Model Library">
    <ModelLibrary onBack={() => recordQaOp('client', { type: 'model_library_back' })} />
  </main>
);
