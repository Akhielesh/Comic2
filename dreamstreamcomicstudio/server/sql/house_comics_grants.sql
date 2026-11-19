-- House comics: the service role's grants (apply name: house_comics_grants). Apply after house_comics.sql.
--
-- house_comics.sql locks every house table and function away from public, anon and authenticated as it creates them
-- (RLS on with no policies, every client privilege revoked). This file only grants, and only to service_role, the
-- server's role. Supabase's default privileges already give service_role these on new tables and functions in
-- public; stating them here keeps the house money path working without relying on those defaults.
--   * the four tables: select, insert, update, delete;
--   * execute on the money functions the server calls, and on the two they call in turn (house_cap_refusal,
--     house_expire_holds) and the payers CHECK function (a CHECK runs with the writer's rights).
-- Idempotent: safe to re-run.

grant select, insert, update, delete on table public.house_config, public.house_runs, public.house_comics, public.house_spend
  to service_role;

grant execute on function public.house_payers_ok(jsonb) to service_role;
grant execute on function public.house_expire_holds() to service_role;
grant execute on function public.house_cap_refusal(public.house_config, uuid, date, text, numeric, boolean) to service_role;
grant execute on function public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean) to service_role;
grant execute on function public.house_settle(uuid, numeric, text, text, numeric) to service_role;
grant execute on function public.house_release(uuid) to service_role;
