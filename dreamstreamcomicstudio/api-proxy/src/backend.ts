/**
 * The DreamStream Express backend, running as a Cloudflare Container
 * (image: ../Dockerfile.cloudflare). Replaces the Railway service.
 *
 * One instance (the proxy always addresses it by the same name), like the
 * single Railway replica it replaces: in-memory rate limits and caches stay
 * coherent. It boots on the first request and sleeps after `sleepAfter` with
 * no traffic — billing stops while it sleeps, so idle cost is ~zero.
 */
import { Container, type StopParams } from '@cloudflare/containers';
import { loadBackendEnv, type EnvDb } from './backendEnv';

interface BackendWorkerEnv {
  BACKEND_ENV?: EnvDb;
  [name: string]: unknown;
}

export class Backend extends Container<BackendWorkerEnv> {
  defaultPort = 8080;
  // Long enough that a working session never pays a second cold start, short
  // enough that an idle evening costs nothing.
  sleepAfter = '15m';
  // The backend calls AI providers, Supabase, Stripe, etc.
  enableInternet = true;

  private envReady: Promise<void> | null = null;

  /** Loads the env once per container start; a D1 edit applies on the next start. */
  private ensureEnv(): Promise<void> {
    if (!this.envReady) {
      this.envReady = loadBackendEnv(this.env, this.env.BACKEND_ENV).then(
        (vars) => {
          this.envVars = vars;
        },
        (err) => {
          this.envReady = null;
          throw err;
        },
      );
    }
    return this.envReady;
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await this.ensureEnv();
      if (!this.ctx.container?.running) {
        await this.startAndWaitForPorts({
          ports: this.defaultPort,
          cancellationOptions: { abort: request.signal, portReadyTimeoutMS: 60_000 },
        });
      }
    } catch (err) {
      console.error('[backend] start failed:', err instanceof Error ? err.message : String(err));
      return new Response(JSON.stringify({ error: { message: 'The server is starting up — please retry in a few seconds.', code: 'backend_starting' } }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' },
      });
    }
    return super.fetch(request);
  }

  override onStart(): void {
    console.log('[backend] container started');
  }

  override onStop(params: StopParams): void {
    // Re-read the env on the next start so rotated secrets take effect.
    this.envReady = null;
    console.log(`[backend] container stopped (exit ${params.exitCode}, ${params.reason})`);
  }

  override onError(error: unknown): unknown {
    console.error('[backend] container error:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
