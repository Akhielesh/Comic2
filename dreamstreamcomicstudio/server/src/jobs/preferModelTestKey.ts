// Side-effect import — MUST be the FIRST import of a model-test entrypoint.
//
// Routes the whole process onto the dedicated DREAMSTREAMSTUDIO_MODELTEST key (when
// set) by overriding OPENROUTER_API_KEY before config.ts resolves it, so verification
// traffic is billed to the test key — never to the user-serving DREAMSTREAMSTUDIO_ALL
// key. User-facing jobs (catalog refresh, pricing sync, billing reconciliation) must
// NOT import this: billing reconciliation in particular has to read the ALL key's data.
const testKey = (process.env.DREAMSTREAMSTUDIO_MODELTEST || process.env.dreamstreamstudio_modeltest || '').trim();
if (testKey) process.env.OPENROUTER_API_KEY = testKey;

export {};
