-- Atomic venture spend increment (Epic F2 hardening). Replaces the read-modify-write in
-- recordSpend so concurrent ticks can't lose a spend update (budget under-counting). One
-- statement = atomic; the daily counter resets inline when the day rolls over. Additive.

create or replace function public.increment_venture_spend(
  p_venture_id uuid,
  p_user_id    uuid,
  p_usd        numeric,
  p_tokens     bigint,
  p_minutes    numeric
) returns void
language sql
as $$
  update public.venture_budgets
  set spent_usd_today = (case when day_anchor <> current_date then 0 else spent_usd_today end) + coalesce(p_usd, 0),
      spent_usd_total = spent_usd_total + coalesce(p_usd, 0),
      tokens_used = tokens_used + coalesce(p_tokens, 0),
      container_minutes_used = container_minutes_used + coalesce(p_minutes, 0),
      day_anchor = current_date,
      updated_at = now()
  where venture_id = p_venture_id and user_id = p_user_id;
$$;
