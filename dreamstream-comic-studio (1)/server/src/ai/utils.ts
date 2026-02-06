export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const withRetry = async <T>(
  operation: () => Promise<T>,
  retries = 3,
  baseDelay = 1000,
  label = 'Operation'
): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (e: any) {
      lastError = e;
      const message = String(e?.message || e || '');
      const isRetryable =
        message.includes('429') ||
        message.includes('503') ||
        message.toLowerCase().includes('quota') ||
        message.toLowerCase().includes('load failed');

      if (!isRetryable || i === retries - 1) {
        throw e;
      }

      const delay = baseDelay * Math.pow(2, i);
      console.warn(`${label} failed (Attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`, message);
      await wait(delay);
    }
  }
  throw lastError;
};

export const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
