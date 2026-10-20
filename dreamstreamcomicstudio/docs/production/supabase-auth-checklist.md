# Supabase Auth Setup Checklist

Use this checklist to make signup verification and account policies work in production.

## Auth Console Configuration

1. Open Supabase Dashboard > `Authentication` > `URL Configuration` (project "Comic",
   ref `bdjfmxfmhqhzvgrhbbzm`).
2. Set `Site URL` to `https://dreamstreamstudio.ai`. **Never leave it on `localhost`** — any
   redirect that isn't allowed falls back to the Site URL, so a localhost value sends every
   confirmation / reset / magic link to a dead page on the user's phone.
3. Add Redirect URLs:
   - `https://dreamstreamstudio.ai/**` (main app `/auth/callback`, Stream Studio `/live?after=…`)
   - `https://comic2.pages.dev/**` and `https://*.comic2.pages.dev/**` (Pages previews)
   - `http://localhost:*/**` (local development)
4. Verify without sending email (an invalid token redirects to the URL GoTrue accepted, or
   to the Site URL if it didn't):
   `curl -s -o /dev/null -w '%{redirect_url}\n' 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co/auth/v1/verify?token=probe&type=signup&redirect_to=https%3A%2F%2Fdreamstreamstudio.ai%2Flive'`
   must print `https://dreamstreamstudio.ai/live#error=…`, not `http://localhost:3000/#error=…`.
5. Open `Authentication` > `Email`.
6. Enable email confirmation for signups.
7. Configure SMTP using Resend, Postmark, or SES with a verified sender domain.
8. Confirm email templates for signup and magic link are enabled and non-empty.

## SQL Migration Order

Run these scripts in order from the SQL editor:

1. `server/sql/supabase_auth_profile_migration.sql`
2. `server/sql/profile_private_email_preferences.sql`
3. `server/sql/auth_signup_policy_min_age_8.sql`

## Post-Migration Verification

1. Create a new account with an age under 8 -> should fail.
2. Create a valid account and verify email delivery.
3. Attempt sign-in before email verification -> should be blocked.
4. Test resend verification from the login screen.
5. Attempt duplicate username signup -> should fail.
6. Attempt duplicate email signup -> should fail.
