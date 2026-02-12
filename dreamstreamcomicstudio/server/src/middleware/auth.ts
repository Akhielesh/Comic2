
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabase.js';

declare module 'express-serve-static-core' {
    interface Request {
        user?: {
            id: string;
            email?: string;
        };
    }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
        res.status(401).json({ error: { message: 'Missing Authorization header' } });
        return;
    }

    try {
        const user = await resolveAuthUser(token);
        if (!user) {
            res.status(401).json({ error: { message: 'Invalid or expired token' } });
            return;
        }

        req.user = {
            id: user.id,
            email: user.email
        };
        next();
    } catch (e: any) {
        res.status(503).json({
            error: {
                message: 'Auth provider unavailable',
                code: 'AUTH_PROVIDER_UNAVAILABLE',
                details: e?.message || String(e)
            }
        });
        return;
    }
};

export const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
        next();
        return;
    }

    try {
        const user = await resolveAuthUser(token);
        if (user) {
            req.user = {
                id: user.id,
                email: user.email
            };
        }
    } catch {
        // Fail-open by design for optional auth routes; request proceeds as guest.
    }

    next();
};

const extractBearerToken = (authorizationHeader: unknown): string | null => {
    if (typeof authorizationHeader !== 'string') return null;
    const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    return token || null;
};

const resolveAuthUser = async (token: string) => {
    const result = await supabase.auth.getUser(token);
    if (result.error || !result.data.user) return null;
    return result.data.user;
};
