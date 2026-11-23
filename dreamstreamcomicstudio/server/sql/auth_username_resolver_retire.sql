-- Post-release only: deploy the private /api/auth/username/signin route and
-- updated AuthPage first. Cached clients can continue to sign in by email.
-- The old RPC exposed a mailbox to anyone who supplied a public username.
revoke execute on function public.resolve_email_from_username(text) from public, anon, authenticated;
