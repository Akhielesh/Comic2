import { supabase } from './supabase';

export interface StudioStats {
    /** Distinct creators behind the public gallery (legit, anonymous-readable). */
    userCount: number;
    /** Comics actually published to the public gallery. */
    comicCount: number;
}

const EMPTY: StudioStats = { userCount: 0, comicCount: 0 };

/**
 * Public, honest studio stats for the landing page.
 *
 * Both numbers reflect ONLY what a logged-out visitor can legitimately see —
 * comics published to the public gallery (`is_public = true`) and the distinct
 * creators behind them. We never fall back to inflated marketing numbers: an
 * unavailable count shows as 0 rather than a made-up figure.
 */
export const getStudioStats = async (): Promise<StudioStats> => {
    try {
        // Count public comics only. Anonymous users can read these rows (the gallery
        // relies on the same policy), so this is an accurate, RLS-safe count.
        const { count: publicComicCount, error: comicError } = await supabase
            .from('projects')
            .select('*', { count: 'exact', head: true })
            .eq('is_public', true);

        const comicCount = comicError ? 0 : (publicComicCount || 0);

        // Active creators = distinct authors among the public comics. This avoids
        // counting the full `profiles` table (which RLS hides from anonymous users
        // and would otherwise read back as 0).
        let userCount = 0;
        if (comicCount > 0) {
            const { data, error } = await supabase
                .from('projects')
                .select('user_id')
                .eq('is_public', true);
            if (!error && Array.isArray(data)) {
                userCount = new Set(
                    data
                        .map((row: { user_id?: unknown }) => (typeof row.user_id === 'string' ? row.user_id : null))
                        .filter((id): id is string => !!id)
                ).size;
            }
        }

        return { userCount, comicCount };
    } catch (e) {
        console.warn('Failed to fetch studio stats', e);
        return { ...EMPTY };
    }
};
