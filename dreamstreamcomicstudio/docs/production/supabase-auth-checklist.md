# Supabase Auth Setup Checklist

Use this checklist to make signup verification and account policies work in production.

## Auth Console Configuration

1. Open Supabase Dashboard > `Authentication` > `URL Configuration`.
2. Set `Site URL` to `https://comic2.pages.dev`.
3. Add redirect URL: `https://comic2.pages.dev/auth/callback`.
4. If you use previews/custom domains, add each callback URL to Redirect URLs (for example `https://<preview>.pages.dev/auth/callback`).
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
