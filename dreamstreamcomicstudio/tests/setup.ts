import '@testing-library/jest-dom';

// jsdom doesn't implement matchMedia, which responsive components (ComicReader,
// AIChatPlatform, …) call to detect viewport width. Provide a desktop-defaulting stub
// so they render in tests instead of throwing.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}
