// Service & connection detection (Sprint 4.1, agentic auto-wiring — detection half).
//
// Reads the generated project's code and infers which backend services it expects (Supabase, a
// Postgres DB, Stripe, object storage, an LLM provider, …) and which environment variables it
// references. This powers the "Services & connections" panel — the studio knowing what the AI's
// code needs, so it can offer to wire it up (scaffold a .env, connect the user's accounts). Pure +
// dependency-free (unit-tested). Conservative signatures to avoid false positives.

export type ServiceId =
  | 'supabase' | 'postgres' | 'prisma' | 'mongodb' | 'firebase'
  | 'stripe' | 'storage' | 'openai' | 'anthropic' | 'redis';

export interface DetectedService {
  id: ServiceId;
  label: string;
}

export interface DetectedServices {
  services: DetectedService[];
  /** Unique, sorted env var names the code references (process.env / import.meta.env). */
  envVars: string[];
}

interface Signature {
  id: ServiceId;
  label: string;
  re: RegExp;
}

// Order = display order. Each regex is matched against the concatenated source (incl. package.json,
// so dependency names count). Kept specific to avoid matching prose/comments.
const SIGNATURES: Signature[] = [
  { id: 'supabase', label: 'Supabase', re: /@supabase\/supabase-js|supabase\.(from|auth|storage|rpc|channel)\(|SUPABASE_/ },
  { id: 'prisma', label: 'Prisma', re: /@prisma\/client|new PrismaClient/ },
  { id: 'postgres', label: 'Postgres', re: /from ['"]pg['"]|require\(['"]pg['"]\)|postgres(ql)?:\/\/|DATABASE_URL/ },
  { id: 'mongodb', label: 'MongoDB', re: /\bmongoose\b|mongodb(\+srv)?:\/\/|MONGO(DB)?_/ },
  { id: 'firebase', label: 'Firebase', re: /\bfirebase\b|FIREBASE_/ },
  { id: 'stripe', label: 'Stripe', re: /\bstripe\b|STRIPE_/ },
  { id: 'storage', label: 'Object storage (S3)', re: /@aws-sdk\/client-s3|\baws-sdk\b|new S3Client|\.storage\.from\(/ },
  { id: 'openai', label: 'OpenAI', re: /\bopenai\b|OPENAI_API_KEY/ },
  { id: 'anthropic', label: 'Anthropic (Claude)', re: /@anthropic-ai|ANTHROPIC_API_KEY/ },
  { id: 'redis', label: 'Redis', re: /\bioredis\b|from ['"]redis['"]|REDIS_URL/ },
];

const ENV_RE = /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)/g;
// Build-time/runtime noise that isn't a real "connection" the user must provide.
const ENV_IGNORE = new Set(['NODE_ENV', 'PORT', 'PWD', 'HOME', 'PATH', 'BASE_URL', 'PUBLIC_URL']);

/** Infer services + referenced env vars from a project's files. */
export const detectServices = (files: { path: string; content?: string }[]): DetectedServices => {
  const source = files.map((f) => f.content ?? '').join('\n');

  const services = SIGNATURES.filter((s) => s.re.test(source)).map(({ id, label }) => ({ id, label }));

  const envSet = new Set<string>();
  let m: RegExpExecArray | null;
  ENV_RE.lastIndex = 0;
  while ((m = ENV_RE.exec(source)) !== null) {
    const name = m[1];
    if (!ENV_IGNORE.has(name)) envSet.add(name);
  }
  const envVars = [...envSet].sort();

  return { services, envVars };
};

/** Build a .env.example body from referenced env var names (+ a short header). */
export const buildEnvExample = (envVars: string[]): string => {
  const header = '# Environment variables this app expects.\n# Fill in the values, then copy to .env (never commit real secrets).\n\n';
  if (envVars.length === 0) return `${header}# (none detected)\n`;
  return header + envVars.map((k) => `${k}=`).join('\n') + '\n';
};
