/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_AUTH_REDIRECT_URL?: string;
  readonly VITE_PLATFORM_DOCS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The onnxruntime-web version transformers.js resolves (vite.config.ts `ortRuntime()`): the voice runtime's `/ort/<version>/`. */
declare const __ORT_WEB_VERSION__: string;
