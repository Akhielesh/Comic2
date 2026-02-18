import { Router, Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin } from '../services/supabase.js';

const sharingRouter = Router();

// ---------- CREATE SHARE ----------
sharingRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: { message: 'Authentication required' } });

        const { projectId, shareType, allowedEmails, allowedUsernames, expiresInHours, allowDownload, allowReshare } = req.body;
        if (!projectId || !shareType || !['public', 'private'].includes(shareType)) {
            return res.status(400).json({ error: { message: 'projectId and shareType (public|private) required' } });
        }

        const admin = getSupabaseAdmin();

        // Verify ownership
        const { data: project, error: projErr } = await admin
            .from('projects')
            .select('id, user_id')
            .eq('id', projectId)
            .maybeSingle();
        if (projErr) throw projErr;
        if (!project || project.user_id !== userId) {
            return res.status(403).json({ error: { message: 'You can only share your own projects' } });
        }

        // If public, also set is_public on the project
        if (shareType === 'public') {
            await admin.from('projects').update({ is_public: true }).eq('id', projectId);
        }

        const expiresAt = expiresInHours
            ? new Date(Date.now() + Number(expiresInHours) * 3600000).toISOString()
            : null;

        const { data: share, error: insertErr } = await admin
            .from('comic_shares')
            .insert({
                project_id: projectId,
                owner_id: userId,
                share_type: shareType,
                allowed_emails: allowedEmails || [],
                allowed_usernames: allowedUsernames || [],
                expires_at: expiresAt,
                allow_download: allowDownload ?? false,
                allow_reshare: allowReshare ?? false,
            })
            .select()
            .single();

        if (insertErr) throw insertErr;

        res.status(201).json({ share });
    } catch (err) {
        next(err);
    }
});

// ---------- VALIDATE SHARE TOKEN ----------
// This route works with optionalAuth — it checks if the user is allowed
sharingRouter.get('/token/:token', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const token = req.params.token;
        if (!token) return res.status(400).json({ error: { message: 'Token required' } });

        const admin = getSupabaseAdmin();
        const { data: share, error } = await admin
            .from('comic_shares')
            .select('*')
            .eq('share_token', token)
            .is('revoked_at', null)
            .maybeSingle();

        if (error) throw error;
        if (!share) return res.status(404).json({ error: { message: 'Share not found or revoked' } });

        // Check expiry
        if (share.expires_at && new Date(share.expires_at) < new Date()) {
            return res.status(410).json({ error: { message: 'Share link has expired' } });
        }

        // Check access for private shares
        if (share.share_type === 'private') {
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ error: { message: 'Login required to view this comic' }, loginRequired: true });
            }

            // Get user email + username
            const { data: profile } = await admin
                .from('profiles')
                .select('email, username')
                .eq('id', userId)
                .maybeSingle();

            const userEmail = profile?.email?.toLowerCase() || '';
            const userName = profile?.username?.toLowerCase() || '';
            const allowedEmails = (share.allowed_emails || []).map((e: string) => e.toLowerCase());
            const allowedUsernames = (share.allowed_usernames || []).map((u: string) => u.toLowerCase());

            const isOwner = share.owner_id === userId;
            const emailAllowed = allowedEmails.includes(userEmail);
            const usernameAllowed = allowedUsernames.includes(userName);

            if (!isOwner && !emailAllowed && !usernameAllowed) {
                return res.status(403).json({ error: { message: 'You do not have access to this comic' } });
            }
        } else {
            // Public share — still require login
            if (!req.user?.id) {
                return res.status(401).json({ error: { message: 'Login required to view shared comics' }, loginRequired: true });
            }
        }

        // Fetch project
        const { data: project, error: projErr } = await admin
            .from('projects')
            .select('*')
            .eq('id', share.project_id)
            .maybeSingle();

        if (projErr) throw projErr;
        if (!project) return res.status(404).json({ error: { message: 'Project not found' } });

        res.json({
            project,
            share: {
                id: share.id,
                shareType: share.share_type,
                allowDownload: share.allow_download,
                allowReshare: share.allow_reshare,
                expiresAt: share.expires_at,
            }
        });
    } catch (err) {
        next(err);
    }
});

// ---------- LIST SHARES FOR A PROJECT ----------
sharingRouter.get('/project/:projectId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: { message: 'Authentication required' } });

        const admin = getSupabaseAdmin();
        const { data: shares, error } = await admin
            .from('comic_shares')
            .select('*')
            .eq('project_id', req.params.projectId)
            .eq('owner_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ shares: shares || [] });
    } catch (err) {
        next(err);
    }
});

// ---------- REVOKE SHARE ----------
sharingRouter.delete('/:shareId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: { message: 'Authentication required' } });

        const admin = getSupabaseAdmin();
        const { error } = await admin
            .from('comic_shares')
            .update({ revoked_at: new Date().toISOString() })
            .eq('id', req.params.shareId)
            .eq('owner_id', userId);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export { sharingRouter };
