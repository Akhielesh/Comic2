
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabase.js';

type ProviderKey = 'gemini' | 'pixazo';

const providerKeyConfig: Record<ProviderKey, { headers: string[]; label: string }> = {
    gemini: {
        headers: ['X-Gemini-Key'],
        label: 'X-Gemini-Key'
    },
    pixazo: {
        headers: ['X-Pixazo-Key', 'X-Flux-Key'],
        label: 'X-Pixazo-Key'
    }
};

// Logic:
// 1. Check Usage Count in DB.
// 2. If < 30: Passthrough (User uses our Server Key).
// 3. If >= 30: Check if request has BYOK Key (Header).
//    - If Header Key exists: Passthrough (User pays).
//    - If NO Header Key: Check DB for Encrypted Key?
//      - MVP: We only trust Headers for BYOK to keep backend simple/stateless regarding decryption.
//      - Wait, if we use Encrypted DB Keys, the backend needs to decrypt them?
//      - Plan Change: The Implementation Plan said "Keys are encrypted client-side".
//        So the Client should decrypt them and send them in the header!
//        Existing `attachKeys` middleware already looks for `X-Gemini-Key`.
//        So limits middleware just needs to say: "If Limit Reached AND No Key in Header -> 402".

export const checkLimits = (requiredProvider: ProviderKey) => async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        res.status(401).json({ error: { message: 'User not authenticated' } });
        return;
    }

    const { headers, label } = providerKeyConfig[requiredProvider];
    const hasRequiredProviderKey = headers.some((header) => !!req.header(header));

    const { data, error } = await supabase
        .from('usage_limits')
        .select('images_generated_count, max_images_allowed')
        .eq('user_id', req.user.id)
        .single();

    if (error && error.code !== 'PGRST116') {
        console.error("Limit check error", error);
        // Fail open or closed? Closed for safety.
        res.status(500).json({ error: { message: 'Failed to check limits' } });
        return;
    }

    // If no record, assume default (0 usage) - though triggers should have created it.
    const count = data?.images_generated_count || 0;
    const max = data?.max_images_allowed || 30;

    if (count >= max) {
        if (hasRequiredProviderKey) {
            // User is over limit BUT provided keys. Allowed.
            // We should probably NOT increment usage count for BYOK?
            // Or we track "Total" vs "Paid"?
            // For MVP: We just track "Images Generated".
            // If they use BYOK, we can let them proceed.
            next();
            return;
        } else {
            // Over limit and NO keys. Block.
            res.status(402).json({
                error: {
                    message: `Free limit reached (${max} images). Please provide ${label} for this endpoint to continue.`,
                    code: 'LIMIT_REACHED'
                }
            });
            return;
        }
    }

    // Under limit. Allowed.
    next();
};

export const trackUsage = async (req: Request, _res: Response, next: NextFunction) => {
    // This runs AFTER the request is successful? 
    // Express middleware runs BEFORE.
    // To track usage only on success, we need to wrap `res.send` or use an event?
    // "Fire and Forget" approach: We increment logic at the START of generation?
    // Better: Increment only if we actually call the Provider.

    // For MVP, we'll increment *optimistically* or just define a helper function `incrementUsage(userId)` 
    // that the routes call after success.

    // Let's attach a helper to the request object?
    // Or just export a function the route handlers can call.
    next();
};

export const incrementUserUsage = async (userId: string) => {
    const { data, error } = await supabase.rpc('increment_user_usage', {
        p_user_id: userId,
    });

    if (error || typeof data !== 'number') {
        console.error('[USAGE] Failed to increment usage', {
            userId,
            error,
            returnedData: data,
        });

        const incrementError = new Error('Failed to record image usage');
        (incrementError as any).status = 500;
        (incrementError as any).code = 'USAGE_ACCOUNTING_FAILED';
        (incrementError as any).details = error?.message || 'increment_user_usage RPC returned an invalid response';
        throw incrementError;
    }

    return data;
};
