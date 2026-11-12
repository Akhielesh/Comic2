import React from 'react';
import { Callout, DocLink, LIST, LegalDocument, MailLink, NUMBERED, type LegalSection } from './LegalDocument';
import { COPYRIGHT_SUBJECT, COUNTER_NOTICE_SUBJECT, SUPPORT_EMAIL } from './legalFacts';
import type { LegalPageProps } from './LegalDocument';

// Copyright & DMCA policy: notice-and-takedown, counter-notice and repeat infringers, handled by
// email. It names no registered designated agent: registering one is an owner decision.

const sections: LegalSection[] = [
    {
        id: 'our-approach',
        title: 'Our approach',
        content: (
            <>
                <p>DreamStream respects the rights of creators and expects everyone who uses it to do the same. Our <DocLink to="terms" /> and <DocLink to="acceptable-use" /> forbid content that infringes someone else's copyright. This policy explains how copyright owners can tell us about infringing content, and how the person who posted it can respond.</p>
                <p>It covers content people share through DreamStream, including published and public comics, profiles, comments, live streams and the recordings and replays they leave behind.</p>
            </>
        )
    },
    {
        id: 'notice',
        title: 'Reporting infringement (a takedown notice)',
        content: (
            <>
                <p>If you own a copyright, or are authorised to act for its owner, and believe content on DreamStream infringes it, email <MailLink email={SUPPORT_EMAIL} subject={COPYRIGHT_SUBJECT} /> with the subject line "{COPYRIGHT_SUBJECT}". For a shared comic, you can also use its Report button and choose “Copies someone else's work”, but an emailed notice with the details below lets us act fastest.</p>
                <p>Under the US Digital Millennium Copyright Act (17 U.S.C. § 512(c)(3)), your notice must include:</p>
                <ol className={NUMBERED}>
                    <li>Your physical or electronic signature (typing your full name is enough).</li>
                    <li>A description of the copyrighted work you believe has been infringed (or, if several, a representative list).</li>
                    <li>The exact location of the material on DreamStream, for example the share link or page address, so we can find it.</li>
                    <li>Your name, postal address, telephone number and email address.</li>
                    <li>A statement that you have a good-faith belief that the use is not authorised by the copyright owner, its agent or the law.</li>
                    <li>A statement that the information in your notice is accurate and, under penalty of perjury, that you are the owner or are authorised to act on the owner's behalf.</li>
                </ol>
                <p>Notices that are missing these details may not be actionable; we'll tell you what's missing.</p>
            </>
        )
    },
    {
        id: 'what-happens',
        title: 'What happens next',
        content: (
            <ul className={LIST}>
                <li>We review the notice and, if it is complete, remove or disable access to the material.</li>
                <li>We tell the person who posted it, give them a copy of the notice (we may remove your personal contact details from it), and explain how to send a counter-notice.</li>
                <li>We keep a record of the notice and of what we did.</li>
            </ul>
        )
    },
    {
        id: 'counter-notice',
        title: 'If your content was removed (a counter-notice)',
        content: (
            <>
                <p>If you believe your content was removed because of a mistake or misidentification, email <MailLink email={SUPPORT_EMAIL} subject={COUNTER_NOTICE_SUBJECT} /> with the subject line "{COUNTER_NOTICE_SUBJECT}". Under 17 U.S.C. § 512(g)(3), it must include:</p>
                <ol className={NUMBERED}>
                    <li>Your physical or electronic signature.</li>
                    <li>A description of the material that was removed and where it appeared before it was removed.</li>
                    <li>A statement, under penalty of perjury, that you have a good-faith belief the material was removed as a result of a mistake or misidentification.</li>
                    <li>Your name, address and telephone number, and a statement that you consent to the jurisdiction of the federal district court for the judicial district where your address is (or, if you are outside the United States, any judicial district in which DreamStream may be found), and that you will accept service of process from the person who sent the original notice or their agent.</li>
                </ol>
                <p>We send a valid counter-notice to the person who sent the original notice. If they don't tell us within 10 business days that they have filed a court action to stop the infringement, we may restore the material 10 to 14 business days after we received your counter-notice.</p>
            </>
        )
    },
    {
        id: 'misrepresentation',
        title: 'False notices',
        content: (
            <Callout>
                <p>Under 17 U.S.C. § 512(f), anyone who knowingly makes a material misrepresentation in a notice or counter-notice may be liable for damages. If you're not sure whether something infringes your rights (for example, it may be fair use), consider getting legal advice before you send a notice.</p>
            </Callout>
        )
    },
    {
        id: 'repeat-infringers',
        title: 'Repeat infringers',
        content: (
            <p>We end, in appropriate circumstances, the accounts of people who are repeat infringers. We may also limit or end an account after a single serious infringement, and we may take into account infringements reported to us in other ways.</p>
        )
    },
    {
        id: 'ai-content',
        title: 'AI-generated content',
        content: (
            <p>AI-generated comics and images are covered by this policy like anything else. The person who generated and shared them is responsible for them. If an AI output copies your protected work closely, send a notice as described above.</p>
        )
    },
    {
        id: 'other-claims',
        title: 'Trademark, impersonation and other rights',
        content: (
            <p>To report trademark misuse, impersonation, or use of your likeness or private information, email <MailLink email={SUPPORT_EMAIL} /> describing the content, where it is and the right you're relying on. We handle these under our <DocLink to="acceptable-use" />.</p>
        )
    }
];

const intro = (
    <p>How to report content on DreamStream that you believe infringes your copyright, how to respond if your content was removed, and our policy on repeat infringers. This page is information, not legal advice.</p>
);

export const CopyrightPolicy: React.FC<LegalPageProps> = ({ onBack, onOpenDoc, onHistoryBack }) => (
    <LegalDocument doc="copyright" intro={intro} sections={sections} onBack={onBack} onOpenDoc={onOpenDoc} onHistoryBack={onHistoryBack} />
);
