import express from 'express';
import { handleStripeWebhook } from '../services/stripe.js';

const router = express.Router();

// POST /api/webhook/stripe
router.post('/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!sig) {
        return res.status(400).send('Webhook Error: Missing stripe-signature');
    }

    try {
        // req.body should be a Buffer here due to express.raw() in index.ts
        await handleStripeWebhook(sig as string, req.body);
        res.json({ received: true });
    } catch (err: any) {
        console.error('Webhook Error:', err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

export default router;
