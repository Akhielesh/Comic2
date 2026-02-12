import React from 'react';

export const TermsOfService: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    return (
        <div className="min-h-screen bg-slate-50 font-sans">
            <main className="max-w-4xl mx-auto px-6 py-12 prose prose-slate">
                <div className="flex items-center justify-between mb-6 not-prose">
                    <h1 className="font-display text-3xl text-black">Terms of Service</h1>
                    <button onClick={onBack} className="text-xs font-bold hover:underline">Back</button>
                </div>
                <p className="font-bold text-sm text-slate-500 uppercase">Effective Date: February 11, 2026</p>
                <div className="bg-white p-8 border-2 border-slate-200 rounded-xl shadow-sm">
                    <p>These Terms of Service ("Terms") govern your use of DreamStream Studio. By accessing or using the service, you agree to these Terms.</p>

                    <h3>1. Eligibility and Acceptance</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>You must be legally able to enter these Terms and use the service in your jurisdiction.</li>
                        <li>You agree to provide accurate account information and keep it current.</li>
                        <li>You must comply with applicable laws, third-party provider terms, and platform rules.</li>
                    </ul>

                    <h3>2. Account and Key Responsibility</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>You are responsible for activity under your account.</li>
                        <li>You are responsible for securing account credentials and any API keys you provide.</li>
                        <li>If your key is compromised, you should rotate it immediately through your provider.</li>
                    </ul>

                    <h3>3. License to Use the Service</h3>
                    <p>We grant you a limited, revocable, non-exclusive, non-transferable license to use DreamStream under these Terms. This does not transfer ownership of DreamStream software, marks, or infrastructure.</p>

                    <h3>4. Content and Intellectual Property</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>You retain rights in content you submit, subject to third-party provider terms and applicable law.</li>
                        <li>You represent that your prompts/uploads do not violate copyright, trademark, privacy, or other rights.</li>
                        <li>You grant DreamStream a limited license to host/process your content only as needed to operate and maintain the service.</li>
                        <li>If you make content public, you permit us to display and distribute that content within product features.</li>
                    </ul>

                    <h3>5. AI and Third-Party Providers</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>DreamStream relies on third-party services such as Supabase, Google Gemini APIs, Pixazo Flux APIs, and optionally Stripe when billing is enabled.</li>
                        <li>Your use of provider-backed features is also subject to those providers&apos; terms and policies.</li>
                        <li>Provider availability, pricing, latency, and behavior may change outside our control.</li>
                    </ul>

                    <h3>6. Plans, Usage Limits, and Payments</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>Usage is governed by Comic Tokens (CT) with plan-based monthly allocations and daily guardrails.</li>
                        <li>DreamStream displays estimated CT before generation and settled CT after generation where supported.</li>
                        <li>You are responsible for charges from third-party providers tied to keys you supply.</li>
                        <li>Direct credit purchases and subscriptions are processed through Stripe checkout/payment flows.</li>
                        <li>Usage beyond available credits may require a payment method on file and may be subject to overage caps.</li>
                        <li>Refund handling follows applicable law and any posted billing policy.</li>
                    </ul>

                    <h3>7. Acceptable Use Restrictions</h3>
                    <p>You may not use DreamStream for unlawful, abusive, deceptive, infringing, or harmful activity, including attempts to bypass safeguards, attack infrastructure, scrape or exfiltrate data improperly, or generate/distribute prohibited content.</p>

                    <h3>8. Enforcement and Suspension</h3>
                    <p>We may monitor for abuse and may remove content, restrict features, suspend, or terminate access for Terms violations, legal risk, security concerns, or platform integrity needs.</p>

                    <h3>9. Service Availability and Changes</h3>
                    <p>Features, models, integrations, and limits may be added, removed, or changed at any time. We do not guarantee uninterrupted availability.</p>

                    <h3>10. Disclaimers</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li>The service is provided "as is" and "as available".</li>
                        <li>AI outputs may be inaccurate, incomplete, offensive, or infringing; you are responsible for review before use or publication.</li>
                        <li>We do not guarantee uninterrupted service, error-free output, or legal suitability for your specific use case.</li>
                    </ul>

                    <h3>11. Liability Limits</h3>
                    <p>To the maximum extent permitted by law, DreamStream is not liable for indirect, incidental, special, consequential, or punitive damages, or for loss of profits, revenue, data, or goodwill arising from service use.</p>

                    <h3>12. Indemnity</h3>
                    <p>You agree to defend and indemnify DreamStream from claims arising out of your content, misuse, or violation of these Terms.</p>

                    <h3>13. Termination</h3>
                    <p>You may stop using the service at any time. We may terminate or suspend access in accordance with these Terms.</p>

                    <h3>14. Changes to Terms</h3>
                    <p>We may update these Terms. Continued use after updates means you accept the revised Terms.</p>

                    <h3>15. Contact</h3>
                    <p>For legal or terms-related questions, use the in-app support/contact flow in Account Settings.</p>

                    <h3>Terms FAQs</h3>
                    <ul className="list-disc pl-5 space-y-2">
                        <li><strong>Can I use generated comics commercially?</strong> Often yes, but you must confirm provider terms, rights clearance, and local law for each use case.</li>
                        <li><strong>Who pays provider API charges for BYOK?</strong> You do. Keys you provide are your responsibility, including provider-side charges.</li>
                        <li><strong>What happens when limits are reached?</strong> You may be prompted to upgrade, add credits, or wait for reset windows.</li>
                        <li><strong>Can DreamStream remove content or suspend accounts?</strong> Yes, for policy/legal/security reasons or Terms violations.</li>
                        <li><strong>Are AI outputs guaranteed to be original or accurate?</strong> No. You must review output for quality, rights, and compliance before publishing.</li>
                        <li><strong>Will features always stay the same?</strong> No. Integrations, models, and limits may change over time.</li>
                        <li><strong>Who is responsible for final legal review?</strong> You are responsible for final review and release decisions for your content.</li>
                    </ul>
                </div>
            </main>
        </div>
    );
};
