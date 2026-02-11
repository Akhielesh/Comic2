
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
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).json({ error: { message: 'Missing Authorization header' } });
        return; // STOP execution
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        res.status(401).json({ error: { message: 'Invalid or expired token', details: error?.message } });
        return; // STOP execution
    }

    req.user = {
        id: user.id,
        email: user.email
    };

    next();
};
