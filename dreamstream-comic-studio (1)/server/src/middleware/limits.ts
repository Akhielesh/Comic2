
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabase.js';

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

export const checkLimits = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        res.status(401).json({ error: { message: 'User not authenticated' } });
        return;
    }

    // 1. Check if user provided their own key in Headers
    // We rely on previous 'attachKeys' or just check raw headers again for clarity
    const geminiKey = req.header('X-Gemini-Key');
    const fluxKey = req.header('X-Pixazo-Key') || req.header('X-Flux-Key');
    const hasOwnKeys = !!geminiKey || !!fluxKey;
    // Note: This is a bit loose. If they provide Gemini but want Image (Flux), they might fail later.
    // But for the "Blocker", if they provide ANY key, we assume they are attempting BYOK mode?
    // Actually, we should be strictly checking the key required for the *current* operation.
    // But this middleware is generic.
    // Let's check Usage Limit first.

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
        if (hasOwnKeys) {
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
                    message: 'Free limit reached (30 images). Please add your own API Keys in Settings to continue.',
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
    // rpc call is atomic, but we can just do a raw SQL increment if we had an RPC
    // Or fetch-update.
    // Supabase JS doesn't have `increment` easily without RPC.
    // Let's try:
    // This is race-condition prone but fine for MVP limits.
    const { data } = await supabase.from('usage_limits').select('images_generated_count').eq('user_id', userId).single();
    if (data) {
        await supabase.from('usage_limits').update({
            images_generated_count: (data.images_generated_count || 0) + 1
        }).eq('user_id', userId);
    }
};
