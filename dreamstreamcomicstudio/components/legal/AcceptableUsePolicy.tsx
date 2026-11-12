import React from 'react';
import { Callout, DocLink, LINK, LIST, LegalDocument, MailLink, SubHeading, type LegalSection } from './LegalDocument';
import { ABUSE_SUBJECT, COMIC_PG_CEILING_UNDER_AGE, SECURITY_EMAIL, SECURITY_SUBJECT, SUPPORT_EMAIL } from './legalFacts';
import type { LegalPageProps } from './LegalDocument';

// Acceptable Use Policy. Enforcement is described as it works today: reader reports, Comic Studio's
// automated checks, moderator review, host and caller tools, and email. Nothing here claims
// automated moderation the product doesn't run.

const sections: LegalSection[] = [
    {
        id: 'scope',
        title: 'Who this applies to',
        content: (
            <p>This policy applies to everyone who uses DreamStream: account holders, and people who join a Stream Studio event, meeting, call or baby-monitor link without an account. It covers everything you create, upload, generate, publish, stream, say or share through the Service, including what you ask an AI to make. It is part of our <DocLink to="terms" />.</p>
        )
    },
    {
        id: 'child-safety',
        title: 'Child safety',
        content: (
            <>
                <Callout title="Zero tolerance">
                    <p>Never create, request, upload, share or link to sexual content involving anyone under 18, including drawn, animated or AI-generated content and content that sexualises children. We remove it, end the accounts involved, and report child sexual abuse material to the authorities where the law requires.</p>
                </Callout>
                <ul className={LIST}>
                    <li>Don't use the Service to contact, groom, exploit or endanger a child, or to collect information about children you have no right to.</li>
                    <li>Don't use Stream Studio's people search or calls to seek out children.</li>
                    <li>Don't share images, video or details of a child in a way that puts them at risk.</li>
                </ul>
            </>
        )
    },
    {
        id: 'illegal',
        title: 'Illegal content and activity',
        content: (
            <ul className={LIST}>
                <li>Nothing that breaks the law where you are or where the content is seen, or that helps someone else break it.</li>
                <li>No content that promotes or gives instructions for terrorism or violent extremism, serious violence, weapons capable of mass harm, or trafficking.</li>
                <li>No fraud, scams, phishing, impersonating a business or official, or selling illegal goods or services.</li>
            </ul>
        )
    },
    {
        id: 'people',
        title: 'Harassment, hate and harm to people',
        content: (
            <ul className={LIST}>
                <li>No harassment, bullying, threats, stalking or intimidation, in comics, comments, chat, streams or calls.</li>
                <li>No content that attacks people for who they are, such as their race, ethnicity, national origin, religion, disability, sex, gender identity, sexual orientation or age.</li>
                <li>No content that encourages self-harm, suicide or eating disorders.</li>
                <li>No sharing of someone's private information (such as their address, phone number or documents) without their permission.</li>
                <li>No repeated calls or messages to someone who has declined or blocked you, and no new accounts to get around a block.</li>
            </ul>
        )
    },
    {
        id: 'content-limits',
        title: 'Sexual content, violence and Comic Studio\'s content limits',
        content: (
            <>
                <ul className={LIST}>
                    <li>No sexually explicit content or pornography, and no non-consensual intimate imagery of anyone, real or AI-generated.</li>
                    <li>No gratuitous gore or extreme violence.</li>
                    <li>Comic Studio's content limit is PG-13, and PG for accounts whose date of birth shows an age under {COMIC_PG_CEILING_UNDER_AGE}. Comic Studio applies automated checks against these limits, as described in <a href="#enforcement" className={LINK}>Enforcement</a>.</li>
                </ul>
            </>
        )
    },
    {
        id: 'real-people',
        title: 'Real people, likeness and impersonation',
        content: (
            <ul className={LIST}>
                <li>Don't create sexual, degrading or deceptive content about a real person, and don't create deepfakes that could be mistaken for real footage, audio or images of someone.</li>
                <li>Don't use someone's name, face, voice or likeness without permission where that misleads people or harms them.</li>
                <li>Don't impersonate another person, brand or organisation, including through your username, display name, avatar or profile.</li>
            </ul>
        )
    },
    {
        id: 'intellectual-property',
        title: 'Other people\'s rights',
        content: (
            <ul className={LIST}>
                <li>Only upload, publish or stream content you have the right to use. Don't pass off someone else's characters, artwork, logos or writing as your own, or use AI to copy a protected work.</li>
                <li>Copyright owners can report infringement under our <DocLink to="copyright" />.</li>
            </ul>
        )
    },
    {
        id: 'privacy-surveillance',
        title: 'Privacy, recording and surveillance',
        content: (
            <ul className={LIST}>
                <li>Before you record a stream, meeting or call, tell the people in it and get any consent the law requires. Stream Studio doesn't show viewers or guests that you are recording, so telling them is up to you.</li>
                <li>Use the baby monitor only to watch your own child, or a child in your care with their parent's or guardian's permission. Never use it, or calls, to watch or listen to adults, a partner, employees or anyone else without their knowledge.</li>
                <li>Don't stream or share video of people in private places (homes, bathrooms, changing areas) without their consent.</li>
                <li>Only connect accounts that are yours or that you're authorised to use, and don't use Chat Studio to process other people's personal information unlawfully.</li>
                <li>Don't share private studio, guest, recap or nursery links in public places; they work like passwords.</li>
            </ul>
        )
    },
    {
        id: 'ai-misuse',
        title: 'Misusing AI',
        content: (
            <ul className={LIST}>
                <li>Don't use AI output to deceive people: no fake news presented as real, fake reviews or endorsements, or AI content passed off as genuine footage or records of real events.</li>
                <li>Don't use the Service to write malware, plan cyberattacks, or create content for spam or influence operations.</li>
                <li>Don't try to get around the AI's safeguards or Comic Studio's content checks, for example with jailbreak prompts or by splitting prohibited requests into pieces.</li>
                <li>Don't plant instructions in content (pages, files, emails or calendar events) designed to manipulate someone else's AI assistant.</li>
                <li>Follow the usage policies of the AI provider whose model you use; they apply in addition to this policy.</li>
            </ul>
        )
    },
    {
        id: 'platform-abuse',
        title: 'Protecting the Service',
        content: (
            <>
                <ul className={LIST}>
                    <li>No scraping, crawling or bulk downloading of the Service, other people's content or AI outputs by automated means, except search-engine indexing allowed by our robots.txt.</li>
                    <li>No getting around usage allowances, fair-use limits, rate limits, bot checks, invitations or welcome codes, for example with multiple accounts or by sharing an account.</li>
                    <li>No sharing, selling or publishing of access to DreamStream, an account, or an API key.</li>
                    <li>No interfering with or overloading the Service, uploading malware, or probing, scanning or testing our systems' security, except good-faith research reported to us privately (see below).</li>
                    <li>No reverse engineering of the Service except where the law allows it despite this restriction.</li>
                    <li>No using the Service to send spam or unwanted invitations.</li>
                </ul>
                <SubHeading>Security research</SubHeading>
                <p>If you find a vulnerability, report it privately to <MailLink email={SECURITY_EMAIL} subject={SECURITY_SUBJECT} /> and give us a reasonable chance to fix it before telling anyone else. Don't access or change other people's data, degrade the Service, or keep data you come across.</p>
            </>
        )
    },
    {
        id: 'enforcement',
        title: 'Enforcement',
        content: (
            <>
                <SubHeading>How we find out</SubHeading>
                <ul className={LIST}>
                    <li><strong>Reports:</strong> readers can report a shared comic with its Report button; anyone can email us.</li>
                    <li><strong>Automated checks in Comic Studio:</strong> prompts, uploads, generated pages and publishing are checked automatically against the content limits above. A flagged page can be softened, blocked or held back from publishing.</li>
                    <li><strong>Review:</strong> moderators review reports and appeals, and can look at flagged content.</li>
                </ul>
                <p>We don't watch everything people do on DreamStream. Live video, calls and baby-monitor video are never screened. Outside Comic Studio, the only automatic checks are narrow ones, such as a profanity and spam filter in live-stream chat. Automated checks can miss things or flag things by mistake.</p>
                <SubHeading>What we may do</SubHeading>
                <ul className={LIST}>
                    <li>Remove content, or make a project private.</li>
                    <li>Limit an account (for example, pause its uploads and publishing while it can still read and edit its comics).</li>
                    <li>Pause generation automatically: in Comic Studio, repeated blocked requests pause generation for 15 minutes, or for 24 hours if they keep happening over a week.</li>
                    <li>Suspend or end an account, or end access to a link or event.</li>
                    <li>Report illegal content to the authorities, where the law requires or allows it.</li>
                </ul>
                <p>We decide based on how serious the problem is, whether it was intentional and whether it happened before. Where it's safe and lawful, we tell the person affected what we did and why.</p>
                <SubHeading>Your own tools</SubHeading>
                <ul className={LIST}>
                    <li>Hosts can remove viewers and guests from their events, and make a new invite link to cut off old ones.</li>
                    <li>Anyone can decline and block a caller, and choose who can call them.</li>
                    <li>Nursery parents can remove anyone from a nursery and end guest links.</li>
                </ul>
                <SubHeading>Appeals</SubHeading>
                <p>In Comic Studio you can ask for a flagged page to be checked again. For any other decision, reply to our message or email <MailLink email={SUPPORT_EMAIL} /> and tell us why you think we got it wrong.</p>
            </>
        )
    },
    {
        id: 'report',
        title: 'How to report',
        content: (
            <ul className={LIST}>
                <li>A shared comic: use the Report button on the comic.</li>
                <li>Anything else: email <MailLink email={SUPPORT_EMAIL} subject={ABUSE_SUBJECT} /> with a link or description of what you saw, where and when.</li>
                <li>Copyright: follow the <DocLink to="copyright" />.</li>
                <li>If someone is in immediate danger, contact your local emergency services first.</li>
            </ul>
        )
    }
];

const intro = (
    <p>DreamStream is for making comics, chatting with AI, streaming and looking after your family. This policy sets out what isn't allowed, so the Service stays safe and useful for everyone, and how we enforce it.</p>
);

export const AcceptableUsePolicy: React.FC<LegalPageProps> = ({ onBack, onOpenDoc, onHistoryBack }) => (
    <LegalDocument doc="acceptable-use" intro={intro} sections={sections} onBack={onBack} onOpenDoc={onOpenDoc} onHistoryBack={onHistoryBack} />
);
