import React from 'react';

export const PrivacyPolicy: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    return (
        <div className="min-h-screen bg-slate-50 font-sans">
            <header className="bg-white border-b-4 border-black sticky top-0 z-30">
                <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
                    <h1 className="font-display text-2xl">Privacy Policy</h1>
                    <button onClick={onBack} className="font-bold hover:underline">Back</button>
                </div>
            </header>
            <main className="max-w-4xl mx-auto px-6 py-12 prose prose-slate">
                <p className="font-bold text-sm text-slate-500 uppercase">Last Updated: February 06, 2026</p>
                <div className="bg-white p-8 border-2 border-slate-200 rounded-xl shadow-sm">
                    <p>DreamStream Studio ("DreamStream", "we", "our", or "us") provides tools for creating and sharing AI-assisted comics. This Privacy Policy explains what information we collect, how we use it, and what controls you have.</p>

                    <h3>1. Information We Collect</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Account Data:</strong> Email, authentication identifiers, and profile metadata (for example: username, avatar) through Supabase authentication.</li>
                        <li><strong>Creative Content:</strong> Scripts, prompts, generated panels, project metadata, comments, and public-profile content that you create in the app.</li>
                        <li><strong>Operational Data:</strong> Usage counts, generation logs, diagnostics, and product analytics used to operate limits, performance monitoring, and abuse prevention.</li>
                        <li><strong>Support Data:</strong> Information you submit through contact/support forms.</li>
                    </ul>

                    <h3>2. How We Use Data</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>To provide project storage, generation workflows, collaboration/community features, and account access.</li>
                        <li>To process requests through third-party AI or infrastructure providers when needed to complete your requested actions.</li>
                        <li>To detect security issues, prevent abuse, enforce platform rules, and improve reliability.</li>
                        <li>To communicate account, billing, legal, or support updates.</li>
                    </ul>

                    <h3>3. AI Processing and Third Parties</h3>
                    <p>When you run generation or assistant features, your prompts and relevant context may be sent to AI providers to return results. We use third-party processors (for example: authentication, storage, model APIs, and payments) under their terms. We do not sell personal data.</p>

                    <h3>4. Keys and Security</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>Data is transmitted over encrypted channels.</li>
                        <li>User-supplied API keys are handled through secure storage patterns designed to reduce exposure.</li>
                        <li>No system is perfectly secure; users are responsible for safeguarding account credentials and device access.</li>
                    </ul>

                    <h3>5. Public vs Private Content</h3>
                    <p>Comics marked public, public profile fields, comments, and likes are visible to other users. Private projects remain private unless explicitly published.</p>

                    <h3>6. Retention and Deletion</h3>
                    <p>We retain data while your account is active or as required for legal, fraud-prevention, accounting, and service-continuity reasons. You may request deletion subject to legal/operational obligations.</p>

                    <h3>7. Children</h3>
                    <p>The service is not intended for children under applicable legal age requirements. If you believe a child has submitted personal data, contact support for review/removal steps.</p>

                    <h3>8. Policy Updates</h3>
                    <p>We may update this policy when features, processors, or legal requirements change. Material changes may be announced in-product.</p>

                    <h3>Privacy FAQs</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Do you train your own model on my private comics?</strong> Not by default. Any future training program would require explicit opt-in.</li>
                        <li><strong>Can other users see my drafts?</strong> No, unless you publish/share content publicly.</li>
                        <li><strong>What data is shown publicly?</strong> Public profile fields, published comics, and public interactions (likes/comments).</li>
                        <li><strong>Can I change or remove profile data?</strong> Yes, from account settings (subject to retention constraints for legal/security logs).</li>
                        <li><strong>Where do I ask privacy questions?</strong> Use the contact/support section in account settings.</li>
                    </ul>
                </div>
            </main>
        </div>
    );
};
