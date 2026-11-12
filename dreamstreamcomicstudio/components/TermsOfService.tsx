import React from 'react';
import { Callout, DocLink, ExternalLink, LIST, LegalDocument, MailLink, SubHeading, type LegalSection } from './legal/LegalDocument';
import {
    COVERED_SITES,
    GOOGLE_PRIVACY_POLICY_URL,
    GOOGLE_SECURITY_PERMISSIONS_URL,
    MIN_SIGNUP_AGE_YEARS,
    OPERATOR_NAME,
    PRIVACY_EMAIL,
    RETENTION,
    STREAM_FAIR_USE,
    SUPPORT_EMAIL,
    YOUTUBE_TERMS_URL
} from './legal/legalFacts';
import type { LegalPageProps } from './legal/LegalDocument';

// Terms of Service: one document, one name ("Terms of Service") for every studio. Each factual
// statement is tied to the code by components/legal/*.test.* and the legal suite's claims ledger.

const sections: LegalSection[] = [
    {
        id: 'agreement',
        title: 'Agreeing to these Terms',
        content: (
            <>
                <p>These Terms of Service ("Terms") are an agreement between you and {OPERATOR_NAME} ("DreamStream", "we", "us" or "our"). They apply whenever you use {COVERED_SITES.join(', ')}, and the studios, apps, links and pages they serve (together, the "Service").</p>
                <p>You accept these Terms when you create an account (the sign-up form asks you to accept them and the <DocLink to="privacy" />), when you join a Stream Studio event, meeting or shared baby-monitor link, or when you otherwise use the Service. If you don't agree, please don't use the Service.</p>
                <p>These documents form part of these Terms and apply with them: the <DocLink to="acceptable-use" />, the <DocLink to="copyright" /> and the <DocLink to="cookies" /> notice. The <DocLink to="privacy" /> explains how we handle personal information.</p>
                <p>If you use the Service for an organisation, you confirm you may accept these Terms for it, and "you" includes that organisation.</p>
            </>
        )
    },
    {
        id: 'beta',
        title: 'A service in beta',
        content: (
            <>
                <p>DreamStream is in a controlled beta. The main site's sign-up form opens only with an invitation, and Stream Studio asks for a welcome code once. Features, models, integrations, limits, browser support, viewer caps, guest seats, recording and replay may be added, changed or removed as reliability work continues, sometimes without notice.</p>
                <p>We don't promise that the Service, or any feature, will be available at any particular time, without interruption, or forever.</p>
            </>
        )
    },
    {
        id: 'eligibility',
        title: 'Who can use DreamStream',
        content: (
            <>
                <p>To create an account you must give your date of birth, and the sign-up form only accepts people who are at least {MIN_SIGNUP_AGE_YEARS} years old. You must also be able to form a binding agreement where you live, or have a parent or guardian who agrees to these Terms for you and is responsible for your use.</p>
                <p>People who join a Stream Studio event, meeting or shared baby-monitor link without an account are not asked their age. The <DocLink to="privacy" hash="children">Children section of the Privacy Policy</DocLink> explains what this means for children's information.</p>
                <p>You may not use the Service if we have previously suspended or removed your access, or if the law that applies to you forbids it.</p>
            </>
        )
    },
    {
        id: 'accounts',
        title: 'Your account and its security',
        content: (
            <>
                <p>One DreamStream account works across Comic Studio, Chat Studio and Stream Studio. You agree to:</p>
                <ul className={LIST}>
                    <li>give accurate information when you sign up and keep it current;</li>
                    <li>keep your password and devices secure, and not share your account;</li>
                    <li>choose a username and display name that don't impersonate anyone or mislead people about who you are;</li>
                    <li>tell us promptly at <MailLink email={SUPPORT_EMAIL} /> if you think someone else has used your account.</li>
                </ul>
                <p>You are responsible for what happens under your account. On the main DreamStream site, a session that hasn't been used for 30 days is signed out on its next visit.</p>
                <SubHeading>Your own API keys</SubHeading>
                <p>Some features let you add your own key for an AI or image provider ("bring your own key"). Requests that use your key run under your own account with that provider: you are responsible for keeping the key safe, for the provider's charges, and for following its terms. If a key may be exposed, rotate it with the provider at once.</p>
            </>
        )
    },
    {
        id: 'service',
        title: 'What the Service includes',
        content: (
            <>
                <ul className={LIST}>
                    <li><strong>Comic Studio:</strong> plan, write, draw and letter comics with AI help, keep versions, export your work, and publish a comic through a public or unlisted share link.</li>
                    <li><strong>Chat Studio:</strong> chat with AI models, use tools such as web search, maps and weather, keep memory notes, add MCP servers, and connect your own Google account so the AI can work with your email, files, calendar, spreadsheets and videos.</li>
                    <li><strong>Stream Studio:</strong> live streams and meetings from your browser, a private baby monitor with alerts, a baby tracker for the family, and voice and video calls.</li>
                    <li>Community features such as public profiles, the public gallery, comments, likes and follows, plus learning guides and a model catalog.</li>
                </ul>
                <p>We license you to use the Service under these Terms: a personal, limited, revocable, non-exclusive, non-transferable licence. The software, designs, logos and the DreamStream name remain ours or our licensors'. These Terms don't give you any right to them except to use the Service as intended.</p>
            </>
        )
    },
    {
        id: 'your-content',
        title: 'Your content',
        content: (
            <>
                <p>"Your content" means what you put into the Service (scripts, prompts, uploads, reference images, messages, chats, comments, event titles, tracker entries and so on) and what the Service generates for you.</p>
                <ul className={LIST}>
                    <li><strong>You keep your rights.</strong> We don't claim ownership of your content.</li>
                    <li><strong>The licence you give us.</strong> You give DreamStream a worldwide, non-exclusive, royalty-free licence to host, store, copy, process, transmit and display your content only as needed to run, secure and improve the Service for you: for example, to save your projects, to send your prompts to the AI provider that answers them, to deliver a stream to your viewers, or to show a published comic to its readers. The licence ends when your content is deleted from the Service, except for copies we must keep by law or that others already received (for example, a comic a reader downloaded).</li>
                    <li><strong>Public and shared content.</strong> When you publish a comic, make a project public, post a comment or share a link, you allow DreamStream to show it to the people it's shared with, including in the gallery, on your profile, in link previews and in embeds of a shared comic. Unpublishing stops new views through our Service; it can't recall copies people already made.</li>
                    <li><strong>Your promises.</strong> You confirm you have the rights you need in your content (including permission from people who appear in it), and that it, and your use of the Service, follow these Terms, the <DocLink to="acceptable-use" /> and the law.</li>
                    <li><strong>Feedback.</strong> If you send us ideas or feedback, we may use them without obligation to you.</li>
                </ul>
                <p>We don't promise to keep backups of your content for you. Export or save what matters to you (Comic Studio exports, recordings saved to your device or Google Drive, tracker CSV downloads).</p>
            </>
        )
    },
    {
        id: 'ai',
        title: 'AI features and AI-generated content',
        content: (
            <>
                <Callout title="AI notice">
                    <p>Chat Studio's assistant, the site-wide assistant on our pages, Comic Studio's director, and the image-generation and translation features are AI systems. When you talk to them you are interacting with an AI, not a person. Text, images and pages they produce are generated by AI models run by third-party providers.</p>
                    <p>DreamStream does not currently add a visible label or machine-readable marking to the images and pages it generates. If you publish or share AI-generated content, you are responsible for any disclosure the law or a platform requires where you share it.</p>
                </Callout>
                <ul className={LIST}>
                    <li><strong>Outputs can be wrong.</strong> AI output may be inaccurate, incomplete, out of date, offensive or similar to other people's work, and may describe things that aren't true. Review it before you rely on it, publish it or act on it. It is not professional (medical, legal, financial or safety) advice.</li>
                    <li><strong>Who owns outputs.</strong> As between you and DreamStream, we don't claim ownership of the outputs you generate, and you may use them subject to these Terms. Whether an output can be protected by copyright, and whether you may use it commercially, depends on the law where you are, the terms of the AI provider for the model that made it, and what it contains (for example another person's character, logo or likeness). We don't promise that any output is original, exclusive to you or free of other people's rights. Others may receive similar outputs.</li>
                    <li><strong>Providers' rules.</strong> Requests are sent to AI providers, through OpenRouter or directly (the <DocLink to="subprocessors" /> page lists them). Their usage policies apply to what you ask them to do, in addition to the <DocLink to="acceptable-use" />.</li>
                    <li><strong>Safety checks.</strong> Comic Studio runs automated checks on prompts, uploads, generated pages and publishing, and may soften, block or hold content it flags. Automated checks can be wrong in both directions. You can ask for a flagged page to be checked again in Comic Studio.</li>
                    <li><strong>We don't train our own AI models on your content.</strong> DreamStream does not use your content to train AI models of its own. How an AI provider handles a request it receives is governed by that provider's terms; the <DocLink to="privacy" hash="ai-processing">Privacy Policy</DocLink> explains what is sent.</li>
                </ul>
            </>
        )
    },
    {
        id: 'acceptable-use',
        title: 'Acceptable use',
        content: (
            <>
                <p>You must follow the <DocLink to="acceptable-use" />. In short: nothing illegal; no sexual content involving minors, ever; no harassment, hate or threats; no content that infringes other people's rights; no recording or watching people without the consent the law requires; and no attacks on, scraping of, or attempts to get around the limits and safeguards of the Service.</p>
            </>
        )
    },
    {
        id: 'stream-studio',
        title: 'Stream Studio: streams, meetings, recordings and calls',
        content: (
            <>
                <ul className={LIST}>
                    <li>Stream Studio is meant for private creator sessions, family use, workshops, classes and small-to-medium live events. It is not a high-scale webinar, gaming or emergency broadcast service.</li>
                    <li>Hosting needs an account. Viewers and invited guests join from a link with just a name; they are bound by these Terms and the <DocLink to="acceptable-use" /> while they take part.</li>
                    <li>Private studio, guest, admin, or recap links are bearer capability links: anyone with one may gain control or private access. Keep private control links off public pages and share viewer links instead.</li>
                    <li><strong>Recording is your responsibility.</strong> As a host you can record on your own device and, if you choose, keep a 7-day cloud copy. Stream Studio does not show viewers or guests that you are recording. Before you record, tell the people taking part and get any consent the law where they are requires (in some places, every participant must agree).</li>
                    <li>Replays of a live stream are kept for about {RETENTION.replayHours} hours. A 7-day cloud copy is deleted about {RETENTION.cloudCopyDays} days after it's made; Google Drive and on-device copies are yours to keep. Recording and replay availability are not guaranteed: browser permissions, network quality, codecs, retention windows or storage errors can affect capture and playback.</li>
                    <li><strong>Calls.</strong> Members can find each other by name and call each other. Unless you change "Who can call you" to only the people in your nurseries, any Stream Studio member can call you. You can decline and block anyone.</li>
                    <li><strong>Fair use.</strong> Stream Studio doesn't charge you. To keep it that way, it has allowances: {STREAM_FAIR_USE.relayDataGbPerAccountMonth} GB of relay data a month for the calls you place, {STREAM_FAIR_USE.relayDataGbPerNurseryMonth} GB a month for each nursery's viewers, up to {STREAM_FAIR_USE.serverPictureHoursPerNurseryDay} hours a day of the baby monitor's picture through our server per nursery, and {STREAM_FAIR_USE.cloudCopyGbRolling} GB of 7-day copies at a time. The app tells you at 80% and 100%. The baby monitor's sound and alerts are never limited.</li>
                </ul>
            </>
        )
    },
    {
        id: 'baby-monitor',
        title: 'Baby monitor and baby tracker: important safety terms',
        content: (
            <>
                <Callout title="Not a medical device. Not a substitute for supervision.">
                    <p>The baby monitor watches and listens. It does not monitor breathing, heart rate, temperature, oxygen or sleep position, and it cannot prevent sudden infant death syndrome (SIDS) or any injury. Always follow safe-sleep guidance and supervise your child.</p>
                </Callout>
                <ul className={LIST}>
                    <li>Alerts, sound detection and smart vision can miss events or raise false alarms. Smart vision is a beta and can't see blankets or pillows.</li>
                    <li>The monitor depends on things outside our control: phones, batteries, browsers, permissions, Wi-Fi and mobile networks, notification services and our own servers. Any of them can fail or delay a picture, a sound or an alert, sometimes without warning. A "camera offline" alert is sent when the camera stops reporting, but it can be delayed or not arrive.</li>
                    <li>The baby tracker's prompts (for example about wet diapers, stool colour or fevers) follow published pediatric guidance and say when to call your pediatrician. They are general information, not a diagnosis or medical advice, and the tracker never calculates medicine doses. In an emergency, call your local emergency number.</li>
                    <li>Only use the monitor to watch your own child, or a child you care for with the permission of their parent or guardian, in a place where you have the right to do so. Never use it to watch or listen to adults without their knowledge.</li>
                </ul>
            </>
        )
    },
    {
        id: 'connected-accounts',
        title: 'Connected accounts and third-party services',
        content: (
            <>
                <p>The Service relies on, and lets you connect, services run by other companies. Their own terms and privacy policies apply to your use of them, and we are not responsible for them.</p>
                <SubHeading id="youtube">YouTube</SubHeading>
                <p>DreamStream uses YouTube API Services. If you connect your YouTube account, you agree to be bound by the <ExternalLink href={YOUTUBE_TERMS_URL}>YouTube Terms of Service</ExternalLink>. Google's handling of your data is described in the <ExternalLink href={GOOGLE_PRIVACY_POLICY_URL}>Google Privacy Policy</ExternalLink>. You can remove DreamStream's access to your YouTube data at any time from your <ExternalLink href={GOOGLE_SECURITY_PERMISSIONS_URL}>Google security settings</ExternalLink>.</p>
                <SubHeading>Google</SubHeading>
                <p>Connecting Gmail, Google Drive, Google Calendar, Google Sheets or YouTube is optional and needs your permission on Google's own screen. What we access and how we use it is set out in the <DocLink to="privacy" hash="google-user-data">Google User Data section of the Privacy Policy</DocLink>. Calendar changes are made only after you confirm them in the app.</p>
                <SubHeading>MCP servers and links</SubHeading>
                <p>MCP servers you add to Chat Studio, websites the AI reads or links to, and other third-party content are used at your own risk; we don't control or endorse them.</p>
            </>
        )
    },
    {
        id: 'payments',
        title: 'Plans, usage limits and payments',
        content: (
            <>
                <ul className={LIST}>
                    <li><strong>No charges today.</strong> Paid billing is switched off: DreamStream does not take payments, and subscriptions, paid plans, credit packs, or overage billing are not active unless DreamStream presents an explicit checkout/payment flow and published pricing terms for your account. Stream Studio never charges.</li>
                    <li><strong>Usage limits.</strong> Free use of AI features runs against usage allowances. When you reach one, you may be asked to wait, use a lower-cost option, or add your own key.</li>
                    <li><strong>Your own keys.</strong> Charges from a provider for requests made with your own key are between you and that provider.</li>
                    <li><strong>If paid plans start.</strong> We will show the price, billing period, renewal, cancellation and refund terms before you pay, and you won't be charged unless you agree to them at checkout.</li>
                </ul>
            </>
        )
    },
    {
        id: 'copyright',
        title: 'Copyright complaints and repeat infringers',
        content: (
            <p>If you believe content on the Service infringes your copyright, follow the <DocLink to="copyright" />. We remove or disable access to content when we receive a valid notice, and we end the accounts of people who repeatedly infringe others' rights, in appropriate circumstances.</p>
        )
    },
    {
        id: 'termination',
        title: 'Suspension, termination and deleting your account',
        content: (
            <>
                <ul className={LIST}>
                    <li><strong>You can stop at any time.</strong> To delete your account and its data, email <MailLink email={PRIVACY_EMAIL} subject="Delete my account" /> from your account's email address. There is no self-service delete button yet; the <DocLink to="privacy" hash="your-rights">Privacy Policy</DocLink> explains how requests are handled.</li>
                    <li><strong>What we may do.</strong> We may remove or make private content, limit features (for example pause uploads and publishing), suspend or end an account, or block a link, if we reasonably believe it's needed because of a breach of these Terms or the <DocLink to="acceptable-use" />, a legal requirement, a risk to people's safety, or a threat to the Service's security or integrity. Where it is safe and lawful, we tell you what we did and why, and you can reply to <MailLink email={SUPPORT_EMAIL} /> if you think we got it wrong.</li>
                    <li><strong>What survives.</strong> Sections that by their nature should continue after your access ends (your content licences for content that stays public, AI and safety terms, disclaimers, limits of liability, indemnity and general terms) continue.</li>
                </ul>
            </>
        )
    },
    {
        id: 'changes',
        title: 'Changes to the Service and to these Terms',
        content: (
            <>
                <p>We may change the Service and these Terms. When we change these Terms we update the date at the top of this page. If a change is material, we will give you reasonable notice in the product or by email before it takes effect, unless we must change sooner for legal or safety reasons. If you keep using the Service after a change takes effect, the new Terms apply; if you don't agree, stop using the Service and you may ask us to delete your account.</p>
            </>
        )
    },
    {
        id: 'disclaimers',
        title: 'Disclaimers',
        content: (
            <>
                <p>The Service is provided "as is" and "as available". To the fullest extent the law allows, DreamStream disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, non-infringement and that the Service will be uninterrupted, secure or error-free, or that outputs will be accurate, original or legally suitable for your use. Some places don't allow these exclusions, so some may not apply to you.</p>
            </>
        )
    },
    {
        id: 'liability',
        title: 'Limitation of liability',
        content: (
            <>
                <p>To the fullest extent the law allows, DreamStream is not liable for indirect, incidental, special, consequential or punitive damages, or for loss of profits, revenue, data or goodwill, arising from or related to the Service or these Terms, even if we were told they were possible.</p>
                <p>Nothing in these Terms excludes or limits liability that cannot be excluded or limited by law, such as liability for fraud, or for death or personal injury caused by negligence, or your rights as a consumer under the mandatory law of the place where you live.</p>
            </>
        )
    },
    {
        id: 'indemnity',
        title: 'Indemnity',
        content: (
            <p>To the extent the law allows, you agree to defend and indemnify DreamStream against claims, losses and costs (including reasonable legal fees) brought by others that arise from your content, your misuse of the Service or your breach of these Terms. This doesn't apply to the extent a claim is caused by our own breach.</p>
        )
    },
    {
        id: 'disputes',
        title: 'Disputes',
        content: (
            <>
                <p>If you have a concern about the Service, please contact us first at <MailLink email={SUPPORT_EMAIL} />; most problems can be fixed quickly that way. Nothing in these Terms takes away rights you have under the mandatory consumer-protection laws of the country or state where you live, including the right to bring a claim in your local courts where that law gives you one.</p>
            </>
        )
    },
    {
        id: 'general',
        title: 'General',
        content: (
            <ul className={LIST}>
                <li>These Terms, with the documents they mention, are the whole agreement between you and DreamStream about the Service.</li>
                <li>If any part of these Terms can't be enforced, the rest stays in effect.</li>
                <li>If we don't enforce a term straight away, we haven't given up the right to enforce it later.</li>
                <li>You may not transfer your rights under these Terms. We may transfer ours as part of a reorganisation, merger or sale of the Service, and we will tell you if we do.</li>
                <li>We may send you notices about the Service by email to your account address or in the product.</li>
            </ul>
        )
    },
    {
        id: 'contact',
        title: 'Contact',
        content: (
            <ul className={LIST}>
                <li>Questions about these Terms or the Service: <MailLink email={SUPPORT_EMAIL} />.</li>
                <li>Privacy questions and requests: <MailLink email={PRIVACY_EMAIL} />.</li>
                <li>Copyright notices: see the <DocLink to="copyright" />.</li>
                <li>Security problems: see <DocLink to="privacy" hash="security">Security in the Privacy Policy</DocLink>.</li>
            </ul>
        )
    }
];

const intro = (
    <p>
        These Terms explain the rules for using DreamStream: what you can expect from us, what we expect from you, and what happens when something goes wrong. We've written them in plain English. Please read them, together with the <DocLink to="privacy" /> and the <DocLink to="acceptable-use" />.
    </p>
);

const summary = (
    <Callout title="The short version">
        <ul className={LIST}>
            <li>You keep your content; you give us the permission we need to run the Service with it.</li>
            <li>AI output can be wrong and isn't always yours alone; check it before you use it.</li>
            <li>The baby monitor is not a medical device and never replaces supervision.</li>
            <li>Hosts must get consent before recording people.</li>
            <li>DreamStream doesn't charge anything today.</li>
            <li>If you connect YouTube, the YouTube Terms of Service apply too.</li>
        </ul>
    </Callout>
);

export const TermsOfService: React.FC<LegalPageProps> = ({ onBack, onOpenDoc, onHistoryBack }) => (
    <LegalDocument doc="terms" intro={intro} summary={summary} sections={sections} onBack={onBack} onOpenDoc={onOpenDoc} onHistoryBack={onHistoryBack} />
);
