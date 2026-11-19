import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmartImage } from './SmartImage';

describe('SmartImage Component', () => {
    // Mock Image constructor
    const originalImage = window.Image;
    // What each preloader carried when its src was set (the moment the browser starts the fetch).
    let preloads: Array<{ src: string; fetchPriority: unknown; decoding: unknown }> = [];

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        vi.useFakeTimers();
        preloads = [];

        // Mock Image loading
        window.Image = class {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            fetchPriority: unknown = undefined;
            decoding: unknown = undefined;
            _src: string = '';

            set src(value: string) {
                this._src = value;
                preloads.push({ src: value, fetchPriority: this.fetchPriority, decoding: this.decoding });
                // Simulate async loading with timeout
                setTimeout(() => {
                    if (value === 'error-url') {
                        if (this.onerror) this.onerror();
                    } else {
                        if (this.onload) this.onload();
                    }
                }, 10);
            }
            get src() { return this._src; }
        } as any;
    });

    afterEach(() => {
        window.Image = originalImage;
        vi.useRealTimers();
    });

    it('renders loading state initially', () => {
        render(<SmartImage src="test.jpg" alt="Test Image" />);
        // Default loader has animate-spin class or similar structure.
        // Since we didn't specify loadingComponent, we check that img is not yet present (as it only shows when loaded)
        const img = screen.queryByRole('img');
        // The component renders a div with loader initially if loadingComponent not provided, or default loader.
        // The actual img tag with src is rendered only when loaded=true (if not using specific implementation details).
        // Let's check implementation: <img ... /> is rendered but maybe hidden? 
        // Actually SmartImage logic:
        // {isLoading && (loadingComponent || defaultLoader)}
        // {error && (fallback || defaultError)}
        // {!isLoading && !error && <img ... />}
        // So img should NOT be in document.
        expect(img).not.toBeInTheDocument();
    });

    it('renders image after loading', async () => {
        render(<SmartImage src="valid.jpg" alt="Loaded Image" />);

        // Fast-forward time to trigger onload
        await act(async () => {
            vi.advanceTimersByTime(20);
        });

        const img = screen.getByRole('img');
        expect(img).toHaveAttribute('src', 'valid.jpg');
        expect(img).toHaveAttribute('alt', 'Loaded Image');
    });

    it('renders error state on load failure', async () => {
        render(<SmartImage src="error-url" alt="Error Image" />);

        // Fast-forward time to trigger onerror
        await act(async () => {
            vi.advanceTimersByTime(20);
        });

        // Should show error icon, not the image tag with src="error-url"
        const img = screen.queryByRole('img');
        expect(img).not.toBeInTheDocument();
        // We could check for alert-circle or error text if we knew exact output.
    });

    it('gives the preloader, which makes the request, the fetch priority and decoding before its src is set', async () => {
        render(<SmartImage src="error-url" fallbackSources={['cover.webp']} alt="Cover" fetchPriority="high" decoding="async" />);
        // First candidate fails, then (after the re-render starts the next preloader) the fallback loads.
        for (let step = 0; step < 2; step += 1) {
            await act(async () => {
                vi.advanceTimersByTime(20);
            });
        }
        // The first candidate fails, so the fallback is fetched by a second preloader: both carry the hints.
        expect(preloads).toEqual([
            { src: 'error-url', fetchPriority: 'high', decoding: 'async' },
            { src: 'cover.webp', fetchPriority: 'high', decoding: 'async' }
        ]);
        const img = screen.getByRole('img');
        expect(img).toHaveAttribute('src', 'cover.webp');
        expect(img).toHaveAttribute('fetchpriority', 'high');
    });

    it('preloads at the browser default priority when none is given', () => {
        render(<SmartImage src="valid.jpg" alt="Plain" />);
        expect(preloads).toEqual([{ src: 'valid.jpg', fetchPriority: 'auto', decoding: 'auto' }]);
    });
});
