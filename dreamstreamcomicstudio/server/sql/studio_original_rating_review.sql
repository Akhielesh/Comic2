-- Apply after studio_original_editions.sql. Editorial re-review has no public read or write path.
begin;

alter table public.studio_original_editions add column if not exists review_report jsonb;
create schema if not exists studio_original_review;
revoke all on schema studio_original_review from public, anon, authenticated, service_role;

-- Only an independently reconstructed legacy gate receipt can identify a missing historical
-- report. A future pin requires another reviewed migration. Runtime callers cannot register pins.
create table if not exists studio_original_review.legacy_rating_receipts (
  book_key text not null,
  prior_digest text not null check (prior_digest ~ '^[a-f0-9]{64}$'),
  prior_gate text not null check (prior_gate ~ '^[a-f0-9]{24}$'),
  prior_rating text not null check (prior_rating in ('G','PG')),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  rating text not null check (rating in ('PG','PG-13')),
  primary key (book_key,prior_digest,prior_gate,digest)
);
-- A pin may be installed before its edition exists. The claim locks and checks the actual canonical row.
insert into studio_original_review.legacy_rating_receipts values
  ('tide','81fac03b885770c225eb5f169f4243f55e5c9231312b66129ac2c3cfc1fcd9b0','395126b9733da1c781857d04','G',
   'd24c7230093e0f37d66d7b3cb680c0c7ab8ec9ddddfd7a816f4d3016de739803','PG')
on conflict do nothing;

create table if not exists studio_original_review.attempts (
  token uuid primary key,
  book_key text not null references public.studio_original_editions(book_key),
  prior_digest text not null,
  previous_decision jsonb not null,
  legacy_receipt boolean not null,
  digest text not null,
  rating text not null,
  status text not null check (status in ('checking','expired','needs_check','blocked','cleared')),
  claimed_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz,
  gate_hash text,
  report jsonb,
  cost_usd numeric
);
create unique index if not exists studio_original_one_active_review on studio_original_review.attempts(book_key)
  where status='checking';
alter table studio_original_review.attempts enable row level security;
alter table studio_original_review.legacy_rating_receipts enable row level security;
revoke all on studio_original_review.attempts,studio_original_review.legacy_rating_receipts from public,anon,authenticated,service_role;

-- Service-only maintenance calls use a private archive; ordinary member tables and policies are untouched.
create or replace function studio_original_review.decision(e public.studio_original_editions)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('bookKey',e.book_key,'slug',e.slug,'assetKey',e.asset_key,
    'sourceDigest',e.source_digest,'status',e.status,'moderationStatus',e.moderation_status,
    'rating',e.rating,'gate',e.gate_hash,'checkedAt',to_char(e.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'checkedDigest',e.checked_digest,
    'costUsd',e.moderation_usd,'report',e.review_report)
$$;

-- Validate the exact bounded operator report. Unknown, mixed and hard outcomes are distinct from
-- a pure rating mismatch. Neither caller labels nor an empty set of checks can certify an edition.
create or replace function studio_original_review.outcome(r jsonb, requested text, ceiling text)
returns text language plpgsql immutable set search_path='' as $$
declare
  target jsonb; state text; assessed text; grade integer; hard boolean := false;
  overage boolean := false; missing boolean := false;
  ages constant text[] := array['G','PG','PG-13'];
  categories constant text[] := array['sexual','minor_sexual','nudity','graphic_gore','self_harm','hate','harassment',
                                      'real_person','dangerous','violence','scary','language','romance','substances','weapons','ip_parody'];
  hard_categories constant text[] := array['sexual','minor_sexual','nudity','graphic_gore','self_harm','hate','harassment','real_person','dangerous'];
begin
  if jsonb_typeof(r) is distinct from 'object' or not (r ?& array['pages','cover','text'])
     or r - array['pages','cover','text'] <> '{}'::jsonb or jsonb_typeof(r->'pages') is distinct from 'array' then return 'invalid'; end if;
  if jsonb_array_length(r->'pages')<>15 or array_position(ages,requested) is null or array_position(ages,ceiling) is null then return 'invalid'; end if;
  for target in select value from jsonb_array_elements(jsonb_build_array(r->'text',r->'cover') || (r->'pages')) loop
    if jsonb_typeof(target) is distinct from 'object' or not (target ?& array['status','assessed','categories'])
       or target - array['status','assessed','categories'] <> '{}'::jsonb
       or jsonb_typeof(target->'categories') is distinct from 'array' then return 'invalid'; end if;
    if jsonb_array_length(target->'categories')>cardinality(categories)
       or exists (select 1 from jsonb_array_elements(target->'categories') c
                   where jsonb_typeof(c) <> 'string' or not ((c#>>'{}')=any(categories))) then return 'invalid'; end if;
    state:=target->>'status'; assessed:=target->>'assessed'; grade:=array_position(ages,assessed);
    if state is null or state not in ('pass','over_rating','unchecked','pending','blocked')
       or (assessed is not null and grade is null and assessed<>'X') then return 'invalid'; end if;
    if state='blocked' or assessed='X' or target->'categories' ?| hard_categories or grade>array_position(ages,ceiling) then hard:=true;
    elsif state in ('unchecked','pending') or assessed is null then missing:=true;
    elsif grade>array_position(ages,requested) then
      if state<>'over_rating' then return 'invalid'; end if;
      overage:=true;
    elsif state<>'pass' then return 'invalid';
    end if;
  end loop;
  return case when hard then 'blocked' when overage and missing then 'mixed'
              when overage then 'over_rating' when missing then 'needs_check' else 'cleared' end;
end $$;

-- The ordinary service-only publisher writes a diagnostic even for a refused first edition.
-- Apply the same field allow-list to that direct write and to archived revision reports.
create or replace function public.studio_original_report_valid(p_report jsonb,p_rating text)
returns boolean language sql immutable security definer set search_path='' as $$
  select studio_original_review.outcome(p_report,p_rating,'PG-13') <> 'invalid'
$$;
revoke all on function public.studio_original_report_valid(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.studio_original_report_valid(jsonb,text) to service_role;
do $$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.studio_original_editions'::regclass and conname='original_review_report_shape') then
    alter table public.studio_original_editions add constraint original_review_report_shape
      check(review_report is null or public.studio_original_report_valid(review_report,rating));
  end if;
end $$;

create or replace function public.studio_claim_original_revision(
  p_key text,p_prior_digest text,p_prior_gate text,p_prior_rating text,p_digest text,p_rating text,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  e public.studio_original_editions%rowtype;
  saved jsonb; legacy boolean; t timestamptz;
  ages constant text[]:=array['G','PG','PG-13'];
begin
  if p_token is null or p_digest is null or p_digest!~'^[a-f0-9]{64}$' or p_prior_digest is null or p_digest=p_prior_digest
    or array_position(ages,p_prior_rating) is null or array_position(ages,p_rating) is null
    or array_position(ages,p_rating)<=array_position(ages,p_prior_rating) then raise exception 'Invalid rating revision'; end if;
  select * into strict e from public.studio_original_editions where book_key=p_key for update;
  t:=clock_timestamp();
  if e.status<>'blocked' or e.moderation_status is distinct from 'blocked' or e.checked_at is null or e.checked_digest is not null
     or e.gate_hash is null or e.gate_hash!~'^[a-f0-9]{24}$' or e.gate_hash is distinct from p_prior_gate
     or e.source_digest is distinct from p_prior_digest or e.rating is distinct from p_prior_rating
     or e.published_at is not null or e.snapshot is not null or e.card is not null or e.cover_path is not null
     or e.lease_until>t or (e.lease_token is not null and e.lease_until is null)
  then raise exception 'Previous editorial decision or lease does not match'; end if;
  saved:=studio_original_review.decision(e);
  legacy:=e.review_report is null;
  if legacy then
    if not exists(select 1 from studio_original_review.legacy_rating_receipts l where
      (l.book_key,l.prior_digest,l.prior_gate,l.prior_rating,l.digest,l.rating)=
      (p_key,p_prior_digest,p_prior_gate,p_prior_rating,p_digest,p_rating)) then raise exception 'A verified earlier rating-only decision is required'; end if;
  elsif studio_original_review.outcome(e.review_report,p_prior_rating,p_rating)<>'over_rating' then
    raise exception 'The previous decision is not solely an age-rating mismatch';
  end if;
  if exists(select 1 from studio_original_review.attempts where book_key=p_key and prior_digest=p_prior_digest and status in ('blocked','cleared')) then
    raise exception 'This editorial revision is closed'; end if;
  if exists(select 1 from studio_original_review.attempts where token=p_token) then
    raise exception 'This editorial revision token is unavailable';
  end if;
  update studio_original_review.attempts set status='expired',finished_at=t
    where book_key=p_key and status='checking' and expires_at<=t;
  if exists(select 1 from studio_original_review.attempts where book_key=p_key and status='checking') then
    raise exception 'Editorial rating review is already running'; end if;
  insert into studio_original_review.attempts(token,book_key,prior_digest,previous_decision,legacy_receipt,digest,rating,status,claimed_at,expires_at)
    values(p_token,p_key,p_prior_digest,saved,legacy,p_digest,p_rating,'checking',t,t+interval '60 minutes');
  return jsonb_build_object('status','checking');
end $$;

create or replace function public.studio_finish_original_revision(
  p_key text,p_digest text,p_token uuid,p_gate_hash text,p_status text,p_report jsonb,p_cost numeric)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  e public.studio_original_editions%rowtype;
  a studio_original_review.attempts%rowtype;
  verdict text; t timestamptz;
begin
  if p_status is null or p_status not in ('blocked','needs_check','cleared') or p_gate_hash is null or p_gate_hash!~'^[a-f0-9]{24}$'
     or p_cost is null or p_cost<0 or p_cost>='Infinity'::numeric then raise exception 'Invalid editorial review result'; end if;
  select * into strict e from public.studio_original_editions where book_key=p_key for update;
  select * into strict a from studio_original_review.attempts where token=p_token and book_key=p_key and digest=p_digest for update;
  t:=clock_timestamp();
  -- A duplicate finish may acknowledge only the exact already-recorded result. It never mutates the edition again.
  if a.status=p_status and a.gate_hash=p_gate_hash and a.cost_usd=p_cost and a.report=p_report then
    return jsonb_build_object('status',a.status); end if;
  if a.status<>'checking' or a.expires_at<=t or studio_original_review.decision(e) is distinct from a.previous_decision
    or e.published_at is not null or e.snapshot is not null or e.card is not null or e.cover_path is not null
    or e.lease_until>t or (e.lease_token is not null and e.lease_until is null) then raise exception 'Editorial review claim is no longer current'; end if;
  verdict:=studio_original_review.outcome(p_report,a.rating,'PG-13');
  if p_status is distinct from (case verdict when 'cleared' then 'cleared' when 'needs_check' then 'needs_check'
           when 'blocked' then 'blocked' when 'over_rating' then 'blocked' when 'mixed' then 'blocked' end) then
    raise exception 'Review result does not match all seventeen assessed targets'; end if;
  update studio_original_review.attempts set status=p_status,gate_hash=p_gate_hash,report=p_report,cost_usd=p_cost,finished_at=t where token=p_token;
  if p_status='cleared' then
    update public.studio_original_editions set status='checked',rating=a.rating,source_digest=p_digest,checked_digest=p_digest,
      moderation_status='cleared',gate_hash=p_gate_hash,review_report=p_report,checked_at=t,
      moderation_usd=e.moderation_usd+(select sum(cost_usd) from studio_original_review.attempts where book_key=p_key and prior_digest=a.prior_digest),
      lease_token=p_token,lease_until=t+interval '60 minutes' where book_key=p_key;
  end if;
  return jsonb_build_object('status',p_status);
end $$;

revoke all on function studio_original_review.decision(public.studio_original_editions),
  studio_original_review.outcome(jsonb,text,text) from public,anon,authenticated,service_role;
revoke all on function public.studio_claim_original_revision(text,text,text,text,text,text,uuid),
  public.studio_finish_original_revision(text,text,uuid,text,text,jsonb,numeric) from public,anon,authenticated,service_role;
grant execute on function public.studio_claim_original_revision(text,text,text,text,text,text,uuid),
  public.studio_finish_original_revision(text,text,uuid,text,text,jsonb,numeric) to service_role;
commit;
