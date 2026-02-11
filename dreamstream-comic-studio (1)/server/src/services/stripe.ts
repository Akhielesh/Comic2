import Stripe from 'stripe';
import { supabase } from './supabase.js';

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2023-10-16', // Use latest or pinned version
});

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

export const createCheckoutSession = async (userId: string, email: string) => {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
        throw new Error('Stripe configuration missing (STRIPE_SECRET_KEY or STRIPE_PRICE_ID)');
    }

    // 1. Check if user already has a stripe_customer_id in metadata or profiles (optional optimization)
    // For now, we'll let Stripe handle email matching or create a new one. 
    // Ideally, we store stripe_customer_id in Supabase profiles.

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer_email: email, // Pre-fill email
        client_reference_id: userId, // Pass Supabase User ID to webhook
        line_items: [
            {
                price: process.env.STRIPE_PRICE_ID,
                quantity: 1,
            },
        ],
        mode: 'subscription', // or 'payment' for one-time
        success_url: `${CLIENT_URL}/settings?success=true`,
        cancel_url: `${CLIENT_URL}/settings?canceled=true`,
        metadata: {
            userId: userId,
        },
    });

    return session;
};

export const handleStripeWebhook = async (sig: string, body: Buffer) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET missing');

    let event: Stripe.Event;

    try {
        event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch (err: any) {
        throw new Error(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object as Stripe.Checkout.Session;
            const userId = session.client_reference_id || session.metadata?.userId;

            if (userId) {
                console.log(`[Stripe] Upgrade successful for user ${userId}`);

                // Update User Profile / Usage Limits to 'Pro'
                // Using Admin Supabase client (service role) to bypass RLS if needed, or RLS allows update?
                // Usually usage_limits is linked to auth.users. 
                // We need to update `is_premium` = true.

                const { error } = await supabase
                    .from('usage_limits')
                    .update({ is_premium: true })
                    .eq('user_id', userId);

                if (error) {
                    console.error('[Stripe] Failed to update premium status:', error);
                }
            }
            break;

        // Handle other events (payment_failed, subscription deleted, etc.)
        default:
            console.log(`[Stripe] Unhandled event type ${event.type}`);
    }

    return { received: true };
};
