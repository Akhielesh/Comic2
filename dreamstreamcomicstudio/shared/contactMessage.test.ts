// @vitest-environment node
// shared/contactMessage (CONTACT-1): one reply-to address shape for the form, POST /api/contact and the
// admin reader's mailto: link. It refuses the characters that would let a stored address add Cc, Bcc, a
// subject or a body to the link an admin clicks to reply.
import { describe, expect, it } from 'vitest';
import {
  CONTACT_EMAIL_MAX,
  CONTACT_EMAIL_MIN,
  CONTACT_EMAIL_SHAPE,
  CONTACT_MESSAGE_MAX,
  contactCodePoints,
  isContactEmail
} from './contactMessage';

describe('isContactEmail', () => {
  it.each(['a@b.co', 'reader.reply@example.com', 'first.last+tag@example.co.uk', 'o_brien-2@mail.example.org', 'josé@exämple.com'])(
    'accepts %s',
    (email) => {
      expect(isContactEmail(email)).toBe(true);
    }
  );

  it.each([
    ['no @', 'reader.example.com'],
    ['two @', 'a@b@example.com'],
    ['no domain dot (the form’s type="email" allows it)', 'me@localhost'],
    ['an empty label', 'a@example..com'],
    ['a trailing dot', 'a@example.com.'],
    ['a space', 'rea der@example.com'],
    ['a mailto: query (Cc and subject)', 'x@evil.com?cc=boss%40corp.com&subject=Invoice&body=pay'],
    ['a fragment', 'x@evil.com#x'],
    ['& in the local part', 'x&cc=a@evil.com'],
    ['a percent escape', 'x%0Abcc@evil.com'],
    ['a slash', 'x/y@evil.com'],
    ['a backslash', 'x\\y@evil.com'],
    ['a colon', 'mailto:x@evil.com'],
    ['a semicolon', 'x;y@evil.com'],
    ['a comma (two recipients)', 'x@evil.com,boss@corp.com'],
    ['angle brackets', '<x@evil.com>'],
    ['parentheses', 'x(y)@evil.com'],
    ['square brackets', 'x@[127.0.0.1]'],
    ['a double quote', '"x"@evil.com'],
    ['a single quote', "x'y@evil.com"],
    ['a newline', 'x@evil.com\nBcc: a@b.co']
  ])('refuses an address with %s', (_label, email) => {
    expect(isContactEmail(email)).toBe(false);
  });

  it('holds the SQL length caps, counted in code points', () => {
    expect([CONTACT_EMAIL_MIN, CONTACT_EMAIL_MAX, CONTACT_MESSAGE_MAX]).toEqual([3, 320, 5000]);
    const at320 = `${'a'.repeat(320 - '@example.com'.length)}@example.com`;
    expect(isContactEmail(at320)).toBe(true);
    expect(isContactEmail(`a${at320}`)).toBe(false);
    expect(contactCodePoints('🙂'.repeat(3))).toBe(3);
  });

  it('refuses anything that is not a string', () => {
    expect(isContactEmail(undefined)).toBe(false);
    expect(isContactEmail(['a@b.co'])).toBe(false);
  });

  it('is one anchored pattern without backtracking blow-up on a long near-miss', () => {
    const start = Date.now();
    expect(CONTACT_EMAIL_SHAPE.test(`${'a.'.repeat(5000)}@${'b'.repeat(5000)}`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
