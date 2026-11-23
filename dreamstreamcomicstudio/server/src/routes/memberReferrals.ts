import { Router } from 'express';
import { getSupabaseAdmin } from '../services/supabase.js';

const CODE = /^[0-9a-f]{32}$/;
export const memberReferralsRouter = Router();
memberReferralsRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
memberReferralsRouter.get('/me', async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ ok: false });
  try {
    const { data, error } = await getSupabaseAdmin().rpc('member_referral_summary', { p_owner: req.user.id }).maybeSingle();
    const row = data as { code: string; verified_signups: number } | null;
    if (error) return res.status(503).json({ ok: false });
    if (!row || !CODE.test(row.code)) return res.status(403).json({ ok: false });
    return res.json({ code: row.code, verifiedSignups: Number(row.verified_signups) });
  } catch { return res.status(503).json({ ok: false }); }
});
