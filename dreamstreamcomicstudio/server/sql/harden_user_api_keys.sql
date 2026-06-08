-- Harden the BYOK key mirror.
--
-- BYOK keys used to be encrypted in the BROWSER with a hardcoded secret shipped in
-- the bundle (services/crypto.ts), then upserted to user_api_keys directly by the
-- client. That made every stored key decryptable by anyone with the frontend / a DB
-- dump. The app now writes keys ONLY through the server (POST /api/account/byok),
-- which encrypts with a server-only secret via the service role.
--
-- So revoke client write access: the service role (server) bypasses RLS and remains
-- the only writer. SELECT is left untouched (there is no client read path, and rows
-- are now ciphertext the client can't decrypt anyway).

revoke insert, update, delete on public.user_api_keys from anon, authenticated;
