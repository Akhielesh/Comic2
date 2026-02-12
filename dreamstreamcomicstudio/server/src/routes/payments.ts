import express from 'express';
import { createCheckoutSession } from '../services/stripe.js';

const router = express.Router();

// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
    try {
        const { userId, email } = req.body;

        if (!userId || !email) {
            return res.status(400).json({ error: 'Missing userId or email' });
        }

        const session = await createCheckoutSession(userId, email);
        res.json({ url: session.url });
    } catch (err: any) {
        console.error('Checkout Session Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Webhook is handled in routes/webhook.ts to support raw body

export default router;
