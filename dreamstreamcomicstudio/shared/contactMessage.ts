// Settings › Contact (CONTACT-1): the reply-to address shape and the caps, in one place for the server
// (POST /api/contact, server/src/routes/contact.ts; server/src/services/contactStore.ts re-exports the caps),
// the admin reader (components/admin/ContactMessages.tsx) and the form (components/AccountSettings.tsx), so
// what the form accepts, what the server stores and what an admin's Reply link opens never disagree.

/** The caps server/sql/contact_messages.sql checks. Postgres char_length counts code points. */
export const CONTACT_EMAIL_MIN = 3;
export const CONTACT_EMAIL_MAX = 320;
export const CONTACT_MESSAGE_MAX = 5000;

/**
 * Characters a reply-to address never needs that mean something in a URL, a mailto: link or a header:
 * whitespace, a second @, ? # & % / \ : ; , < > ( ) [ ] " and '. Without them a stored address cannot
 * add Cc, Bcc, a subject or a body to the mailto: link an admin clicks to reply.
 */
const NOT_IN_ADDRESS = String.raw`\s@?#&%/\\:;,<>()[\]"'`;

/** something@something.tld: one @, at least one dot in the domain, no empty labels, none of the above. */
export const CONTACT_EMAIL_SHAPE = new RegExp(`^[^${NOT_IN_ADDRESS}]+@[^${NOT_IN_ADDRESS}.]+(?:\\.[^${NOT_IN_ADDRESS}.]+)+$`);

/** Length as Postgres char_length counts it (code points, not UTF-16 units). */
export const contactCodePoints = (value: string): number => Array.from(value).length;

/** True for an address POST /api/contact would store (already trimmed). */
export const isContactEmail = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const length = contactCodePoints(value);
  return length >= CONTACT_EMAIL_MIN && length <= CONTACT_EMAIL_MAX && CONTACT_EMAIL_SHAPE.test(value);
};
