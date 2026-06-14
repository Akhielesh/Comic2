import { describe, it, expect } from 'vitest';
import { connectorsRouter } from './connectors.js';

// Express matches routes in registration order. A static path like '/google/connect'
// MUST be registered before the param route '/:connectorId/connect', or the latter
// captures "google" as a connector id and the request 404s. This guards that ordering.
const routePaths = (router: any): string[] =>
  (router?.stack || []).filter((l: any) => l.route).map((l: any) => l.route.path);

describe('connectors route ordering', () => {
  it('registers /google/connect before /:connectorId/connect (no 404 shadowing)', () => {
    const paths = routePaths(connectorsRouter);
    const google = paths.indexOf('/google/connect');
    const param = paths.indexOf('/:connectorId/connect');
    expect(google, '/google/connect must be registered').toBeGreaterThanOrEqual(0);
    expect(param, '/:connectorId/connect must be registered').toBeGreaterThanOrEqual(0);
    expect(google, '/google/connect must come BEFORE /:connectorId/connect').toBeLessThan(param);
  });
});
