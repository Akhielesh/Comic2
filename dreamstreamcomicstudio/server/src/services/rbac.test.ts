// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { isBootstrapAdminEmail, parseAdminEmails } from './rbac.js';

const savedAdminEmails = process.env.ADMIN_EMAILS;
afterEach(() => {
  if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = savedAdminEmails;
});

describe('bootstrap admin emails', () => {
  it('hard-codes only the owner inbox', () => {
    delete process.env.ADMIN_EMAILS;
    expect(parseAdminEmails()).toEqual(['akhieleshsrirangam@gmail.com']);
    expect(isBootstrapAdminEmail(' AkhieleshSrirangam@gmail.com ')).toBe(true);
  });

  it('never makes the typo address (or look-alikes) an admin on sign-up', () => {
    delete process.env.ADMIN_EMAILS;
    for (const email of ['akhielesh99@gmail.com', 'akhielesh999@gmail.com', 'akhieleshsrirangam@gmail.com.evil.com', '', null, undefined]) {
      expect(isBootstrapAdminEmail(email)).toBe(false);
    }
  });

  it('still adds ADMIN_EMAILS from the environment', () => {
    process.env.ADMIN_EMAILS = ' Ops@Example.com ,, akhieleshsrirangam@gmail.com';
    expect(parseAdminEmails()).toEqual(['akhieleshsrirangam@gmail.com', 'ops@example.com']);
  });
});
