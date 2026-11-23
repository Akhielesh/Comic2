import type { RequestHandler } from 'express';
import { resolveAccessProfile } from '../services/rbac.js';
import { getSupabaseAdmin } from '../services/supabase.js';

/** No product rows is the existing open-beta grant. Once scoped, an account needs an
 * active grant for this studio or server-verified admin access. */
export const requireStudioProduct = (
  product: 'chat_studio' | 'comic_studio',
  label: string,
  destination: string
): RequestHandler => async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  const user = req.user;
  if (!user?.id) return void res.status(401).json({ error: { message: `Sign in to open ${destination}.` } });
  try {
    const { data, error } = await getSupabaseAdmin().from('product_access').select('product,active').eq('user_id', user.id);
    if (error || !Array.isArray(data)) throw new Error('Product grants unavailable');
    if (data.length && !data.some(row => row.product === product && row.active === true)) {
      const { isAdmin } = await resolveAccessProfile({ userId: user.id, email: user.email });
      if (!isAdmin) return void res.status(403).json({ error: { message: `This account does not have ${label} access.` } });
    }
  } catch {
    return void res.status(503).json({ error: { message: `Could not verify ${label} access. Try again.` } });
  }
  next();
};
