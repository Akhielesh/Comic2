import React from 'react';

export const TermsOfService: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    return (
        <div className="min-h-screen bg-slate-50 font-sans">
            <header className="bg-white border-b-4 border-black sticky top-0 z-30">
                <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
                    <h1 className="font-display text-2xl">Terms of Service</h1>
                    <button onClick={onBack} className="font-bold hover:underline">Back</button>
                </div>
            </header>
            <main className="max-w-4xl mx-auto px-6 py-12 prose prose-slate">
                <p className="font-bold text-sm text-slate-500 uppercase">Effective Date: February 06, 2026</p>
                <div className="bg-white p-8 border-2 border-slate-200 rounded-xl shadow-sm">
                    <p>Welcome to DreamStream Studio. By accessing or using our Service, you agree to be bound by these Terms of Service ("Terms").</p>

                    <h3>1. Usage Licenses</h3>
                    <p>DreamStream grants you a limited, non-exclusive, non-transferable license to use the Service for personal or commercial purposes, subject to these Terms.</p>

                    <h3>2. Content Ownership</h3>
                    <p>You retain ownership of the comics and stories you create. However, you acknowledge that AI-generated content may be subject to specific rulings regarding copyrightability in your jurisdiction.</p>

                    <h3>3. User Conduct</h3>
                    <p>You agree not to use the Service to generate:</p>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>Illegal, harmful, or threatening content.</li>
                        <li>Content that infringes on the intellectual property rights of others.</li>
                        <li>NSFW or explicit material in violation of our safety guidelines.</li>
                    </ul>

                    <h3>4. Termination</h3>
                    <p>We reserve the right to suspend or terminate your account at any time for violations of these Terms or for any other reason at our sole discretion.</p>

                    <h3>5. Disclaimer of Warranties</h3>
                    <p>The Service is provided "AS IS" without warranties of any kind. We do not guarantee that the AI generation will be error-free or meet your specific requirements.</p>
                </div>
            </main>
        </div>
    );
};
