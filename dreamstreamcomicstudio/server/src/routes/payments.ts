import express from 'express';
import { createCheckoutSession } from '../services/stripe.js';

const router = express.Router();

// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
    try {
        if (!req.user?.id || !req.user.email) {
            return res.status(401).json({ error: 'Missing authenticated user identity' });
        }

        const session = await createCheckoutSession(req.user.id, req.user.email);
        res.json({ url: session.url });
    } catch (err: any) {
        console.error('Checkout Session Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Webhook is handled in routes/webhook.ts to support raw body

export default router;
