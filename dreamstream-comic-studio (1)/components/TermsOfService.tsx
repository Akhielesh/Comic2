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
                    <p>These Terms of Service ("Terms") govern your use of DreamStream Studio. By accessing or using the service, you agree to these Terms.</p>

                    <h3>1. Eligibility and Account Responsibility</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>You must use accurate account information and maintain account security.</li>
                        <li>You are responsible for all activity from your account and API key usage.</li>
                        <li>You must comply with all applicable laws and platform safety rules.</li>
                    </ul>

                    <h3>2. License to Use the Service</h3>
                    <p>We grant a limited, revocable, non-exclusive, non-transferable license to use DreamStream according to these Terms. This does not transfer ownership of DreamStream software or branding.</p>

                    <h3>3. Content and Intellectual Property</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>You retain rights in content you submit, subject to third-party provider terms and applicable law.</li>
                        <li>You represent that your prompts/uploads do not violate copyright, trademark, privacy, or other rights.</li>
                        <li>You grant DreamStream a limited license to host/process your content solely to operate and improve the service.</li>
                    </ul>

                    <h3>4. Acceptable Use Restrictions</h3>
                    <p>You may not use DreamStream for unlawful, abusive, deceptive, infringing, or harmful activity, including attempts to bypass safeguards, attack infrastructure, or distribute prohibited content.</p>

                    <h3>5. Payments, Plans, and Availability</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>Paid plans and limits may change over time; pricing terms are shown at purchase time.</li>
                        <li>Features may depend on third-party providers and may be unavailable, delayed, or modified.</li>
                        <li>Refund handling follows applicable billing policies and law.</li>
                    </ul>

                    <h3>6. Suspension and Termination</h3>
                    <p>We may suspend or terminate access for Terms violations, abuse, legal risk, or security issues. You may stop using the service at any time.</p>

                    <h3>7. Disclaimers and Liability Limits</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>The service is provided "as is" and "as available".</li>
                        <li>We do not guarantee uninterrupted service, error-free output, or legal suitability of generated content for your use case.</li>
                        <li>To the maximum extent permitted by law, DreamStream is not liable for indirect or consequential damages from service use.</li>
                    </ul>

                    <h3>8. Indemnity</h3>
                    <p>You agree to defend and indemnify DreamStream from claims arising out of your content, misuse, or violation of these Terms.</p>

                    <h3>9. Changes to Terms</h3>
                    <p>We may update these Terms. Continued use after updates means you accept the revised Terms.</p>

                    <h3>Terms FAQs</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Can I use generated comics commercially?</strong> Generally yes, but you are responsible for compliance with model/provider terms and local law.</li>
                        <li><strong>Can DreamStream remove my content?</strong> We may remove content that violates policy, law, or creates legal/security risk.</li>
                        <li><strong>Will features always stay the same?</strong> No. Features and limits may change as the platform evolves.</li>
                        <li><strong>Who is responsible for legal review?</strong> You are responsible for reviewing and clearing your final content before publication.</li>
                    </ul>
                </div>
            </main>
        </div>
    );
};
