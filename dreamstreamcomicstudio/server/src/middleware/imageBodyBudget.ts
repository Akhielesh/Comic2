import type { RequestHandler } from 'express';

// Hold a ticket until the response closes, including time spent awaiting Sharp or a provider.
// For compressed/chunked uploads the parser's INFLATED byte limit is the only safe estimate.
export function imageBodyBudget(parserLimit: number, aggregateLimit = Math.max(parserLimit, 48 * 1024 * 1024)): RequestHandler {
  let retained = 0;
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const length = Number(req.get('content-length'));
    const known = req.get('content-length') !== undefined && Number.isSafeInteger(length) && length >= 0 &&
      (!req.get('content-encoding') || req.get('content-encoding') === 'identity');
    // The parser already rejects declared bodies over its own limit without buffering them.
    const ticket = known ? Math.min(length, parserLimit) : parserLimit;
    if (retained + ticket > aggregateLimit) {
      req.resume(); // drain without collecting bytes into a Buffer or parsing the JSON
      res.set('Retry-After', '10').status(429).json({ error: { code: 'GENERATION_BUSY', message: 'Image uploads are busy. Please try again shortly.' } });
      return;
    }
    retained += ticket;
    const release = () => {
      retained -= ticket;
      res.off('close', release);
      res.off('finish', release);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
