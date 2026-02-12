import React from 'react';

export const PrivacyPolicy: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    return (
        <div className="min-h-screen bg-slate-50 font-sans">
            <main className="max-w-4xl mx-auto px-6 py-12 prose prose-slate">
                <div className="flex items-center justify-between mb-6 not-prose">
                    <h1 className="font-display text-3xl text-black">Privacy Policy</h1>
                    <button onClick={onBack} className="text-xs font-bold hover:underline">Back</button>
                </div>
                <p className="font-bold text-sm text-slate-500 uppercase">Last Updated: February 11, 2026</p>
                <div className="bg-white p-8 border-2 border-slate-200 rounded-xl shadow-sm">
                    <p>DreamStream Studio ("DreamStream", "we", "our", or "us") provides tools for creating and sharing AI-assisted comics. This Privacy Policy explains what data we process, why we process it, how it moves through our APIs and providers, and what controls you have.</p>

                    <h3>1. Information We Collect</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Account and Profile Data:</strong> Email/login data from Supabase Auth, plus profile fields such as username, avatar, bio, and website.</li>
                        <li><strong>Consent Data:</strong> Terms acceptance and optional marketing consent values provided during signup.</li>
                        <li><strong>Creative and Project Data:</strong> Scripts, prompts, scene breakdowns, continuity data, generated images, project state, reviews, and comments.</li>
                        <li><strong>Community Data:</strong> Public profile data, follows, likes, views, notifications, and other social interactions tied to your account.</li>
                        <li><strong>Support Data:</strong> Contact/support messages you submit (for example, email and message body).</li>
                        <li><strong>Operational and Debug Data:</strong> Token ledger events, pricing snapshot metadata, provider/model timing metrics, error logs, and stored generation artifacts (which can include prompts and model responses).</li>
                        <li><strong>Billing Lifecycle Data:</strong> Subscription status, cancel-at-period-end flags, billing-period timestamps, webhook processing records, and overage capture metadata.</li>
                        <li><strong>Device-Stored Data:</strong> Browser local storage and IndexedDB records used for saved keys, guest projects, test runs/images, reader state, and learning progress.</li>
                    </ul>

                    <h3>2. How We Use Data</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>To authenticate users, manage accounts, and provide profile/community features.</li>
                        <li>To run text/image/vision generation workflows you request and return results.</li>
                        <li>To store projects, images, artifacts, and support interactions.</li>
                        <li>To enforce plan/usage limits, fraud-abuse controls, and operational safeguards.</li>
                        <li>To monitor reliability, troubleshoot issues, and improve core product behavior.</li>
                        <li>To send account, legal, billing, and support-related communications.</li>
                    </ul>

                    <h3>3. AI Processing and Third Parties</h3>
                    <p>When you use generation features, relevant request data (for example prompts, selected model, and any reference images you submit) may be sent to model providers to produce output.</p>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Supabase:</strong> Authentication, database tables, and cloud storage.</li>
                        <li><strong>Google Gemini APIs:</strong> Text, image, and vision processing.</li>
                        <li><strong>Pixazo Flux endpoint:</strong> Flux image generation requests.</li>
                        <li><strong>Stripe:</strong> Payment processing and tokenized payment-method storage for subscriptions, credit packs, and overage flows.</li>
                    </ul>
                    <p>These providers process data under their own terms and policies. We do not sell personal data.</p>

                    <h3>4. Keys and Security</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>Data is transmitted over encrypted channels.</li>
                        <li>Bring-your-own API keys may be stored in browser local storage and sent to the backend in request headers for provider calls.</li>
                        <li>Flux keys can also be synced to the database in encrypted form; decryption occurs client-side after login.</li>
                        <li>Payment methods are stored as Stripe token references; DreamStream does not store raw card numbers.</li>
                        <li>Billing policy actions (for example cancellation scheduling, reactivation, credit checkout completion, and overage charge events) are logged for accounting/security auditability.</li>
                        <li>No client-side storage method is perfect. You are responsible for securing your device, rotating keys, and protecting account credentials.</li>
                    </ul>

                    <h3>5. Public vs Private Content</h3>
                    <p>Projects are private unless you mark them public. Public projects, profile identifiers, comments, and engagement data (likes/views/follows) can be visible to other users.</p>

                    <h3>6. Cookies, Local Storage, and Device Data</h3>
                    <p>The current app code relies on browser storage (localStorage/IndexedDB) for key settings, local caches, guest-mode data, and session-related client state. The codebase does not include third-party advertising trackers.</p>

                    <h3>7. Retention and Deletion</h3>
                    <p>We keep account and project data while needed to operate the service and satisfy legal/security obligations. You can delete projects and some user content from the app; account deletion/support requests may be required for full removal workflows. Certain logs may be retained where required for abuse prevention, accounting, or legal compliance.</p>

                    <h3>8. Children</h3>
                    <p>The service is not intended for children under applicable legal age requirements. If you believe a child submitted personal data, contact support for review/removal.</p>

                    <h3>9. International Processing</h3>
                    <p>Depending on your location and selected providers, data may be processed in multiple countries where DreamStream and its processors operate infrastructure.</p>

                    <h3>10. Policy Updates</h3>
                    <p>We may update this policy when features, processors, data flows, or legal requirements change. Material updates may be announced in-product.</p>

                    <h3>11. Contact</h3>
                    <p>For privacy questions, use the in-app contact/support flow in Account Settings.</p>

                    <h3>Privacy FAQs</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Do you sell my personal data?</strong> No.</li>
                        <li><strong>Do you train your own model on my private projects?</strong> Not by default in this product flow. Third-party model providers may process requests under their own terms.</li>
                        <li><strong>What is sent to AI providers?</strong> The request data needed to fulfill your action, such as prompts, selected model context, and any reference images you submit.</li>
                        <li><strong>Where are my API keys stored?</strong> Keys can be stored in browser local storage; Flux keys may also be encrypted and synced to your account record for convenience.</li>
                        <li><strong>What billing data is stored?</strong> DreamStream stores wallet balances, token usage events, subscription lifecycle state (including cancellation scheduling), and Stripe payment-method references required for billing operations.</li>
                        <li><strong>Can other users see my drafts?</strong> No, unless you intentionally make a project public.</li>
                        <li><strong>What data stays on my device?</strong> Local caches including key settings, guest projects, test runs/images, and reader/learning state can be stored in localStorage/IndexedDB.</li>
                        <li><strong>How do I delete my data?</strong> Delete content in-app where available and use support contact for account-level/privacy deletion requests.</li>
                        <li><strong>Do you send marketing emails automatically?</strong> Marketing communication is optional and based on your signup consent choices.</li>
                    </ul>
                </div>
            </main>
        </div>
    );
};
