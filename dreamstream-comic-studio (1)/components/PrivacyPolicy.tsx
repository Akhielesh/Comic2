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
                    <p>DreamStream Studio ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our web application (the "Service").</p>

                    <h3>1. Information We Collect</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Account Information:</strong> When you sign up, we collect your email address and authentication credentials via Supabase.</li>
                        <li><strong>Usage Data:</strong> We track the number of comics generated and API usage to enforce plan limits.</li>
                        <li><strong>Content:</strong> Comics, scripts, and characters you create are stored in our database.</li>
                    </ul>

                    <h3>2. How We Use Your Information</h3>
                    <p>We use your information to:</p>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>Provide and maintain the Service.</li>
                        <li>Process AI generations via third-party providers (Google Gemini, Black Forest Labs).</li>
                        <li>Communicate with you regarding your account or support requests.</li>
                    </ul>

                    <h3>3. AI & Third-Party Sharing</h3>
                    <p>Your text prompts are sent to AI providers (Google, BFL) to generate content. We do not use your private content to train our own models without your explicit consent. We do not sell your personal data to advertisers.</p>

                    <h3>4. Data Security</h3>
                    <p>We use industry-standard encryption for data in transit and at rest. API keys provided by you are encrypted before storage.</p>

                    <h3>5. Contact Us</h3>
                    <p>If you have any questions about this Privacy Policy, please contact us via the support form in your account settings.</p>
                </div>
            </main>
        </div>
    );
};
