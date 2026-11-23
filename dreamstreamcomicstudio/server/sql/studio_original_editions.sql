-- Independent editorial publications. No grants, triggers, owner identities or membership rows change.
begin;
create table if not exists public.studio_original_editions (
  book_key text primary key check(book_key in ('tide','orchard','fox','table-nine')),
  slug text not null unique check(slug=case book_key when 'tide' then 'DSOriginalTide001' when 'orchard' then 'DSOriginalTree001' when 'fox' then 'DSOriginalFox0001' when 'table-nine' then 'DSOriginalNine001' end),
  source_digest text not null check(source_digest ~ '^[0-9a-f]{64}$'),
  asset_key text not null unique check(asset_key ~ '^[A-Za-z0-9]{22}$'),
  status text not null check(status in ('staging','checked','blocked','live','withdrawn')),
  lease_token uuid, lease_until timestamptz,
  checked_digest text, gate_hash text, checked_at timestamptz, moderation_status text, moderation_usd numeric not null default 0 check(moderation_usd >= 0),
  rating text check(rating in ('G','PG','PG-13')), snapshot jsonb, card jsonb, cover_path text, published_at timestamptz,
  constraint original_gate_required check(status not in ('checked','live') or (
    checked_digest is not null and checked_digest=source_digest and checked_at is not null and gate_hash is not null and
    gate_hash ~ '^[0-9a-f]{24}$' and moderation_status is not distinct from 'cleared' and rating is not null)),
  constraint original_live_complete check(status <> 'live' or (
    published_at is not null and card is not null and jsonb_typeof(card)='object' and (card->>'pageCount') is not distinct from '15'
    and snapshot is not null and jsonb_typeof(snapshot->'pages') is not distinct from 'array'
    and jsonb_array_length(snapshot->'pages')=15 and cover_path is not null and starts_with(cover_path,'pub/'||asset_key||'/')))
);
alter table public.studio_original_editions enable row level security;
revoke all on public.studio_original_editions from public,anon,authenticated,service_role;
grant select,insert,update on public.studio_original_editions to service_role;

create or replace function public.studio_claim_original(p_key text,p_slug text,p_digest text,p_asset_key text,p_token uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.studio_original_editions%rowtype;
begin
  if p_token is null or p_digest is null or p_key is null then raise exception 'Invalid edition claim'; end if;
  if exists (select 1 from public.comic_publications where slug=p_slug or asset_key=p_asset_key) then
    raise exception 'Editorial identifier is already used by a member publication'; end if;
  insert into public.studio_original_editions(book_key,slug,source_digest,asset_key,status)
    values(p_key,p_slug,p_digest,p_asset_key,'staging') on conflict(book_key) do nothing;
  select * into strict r from public.studio_original_editions where book_key=p_key for update;
  if r.source_digest<>p_digest or r.slug<>p_slug then raise exception 'This source differs from the registered edition'; end if;
  if r.status in ('withdrawn','blocked') then raise exception 'This edition is unavailable'; end if;
  if r.status<>'live' then
    if r.lease_until>clock_timestamp() and r.lease_token is distinct from p_token then raise exception 'Editorial publication is already running'; end if;
    update public.studio_original_editions set lease_token=p_token,lease_until=clock_timestamp()+interval '60 minutes' where book_key=p_key;
  end if;
  return jsonb_build_object('status',r.status,'assetKey',r.asset_key,'publishedAt',r.published_at,'moderationUsd',r.moderation_usd);
end $$;
revoke all on function public.studio_claim_original(text,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.studio_claim_original(text,text,text,text,uuid) to service_role;

-- The same DTO consumed by the public reader and link preview, produced only for checked, live editions.
create or replace function public.comic_originals_share_card(p_slug text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('slug',e.slug,'visibility','public','languages',jsonb_build_array('en'),'defaultLang','en',
   'allowDownload',false,'allowEmbed',true,'startPage',null,'publishedAt',(extract(epoch from e.published_at)*1000)::bigint,
   'updatedAt',(extract(epoch from e.published_at)*1000)::bigint,'assetKey',e.asset_key,'card',e.card,'rating',e.rating)
 from public.studio_original_editions e where e.slug=p_slug and e.status='live' and e.checked_digest=e.source_digest
$$;
create or replace function public.comic_originals_public_payload(p_slug text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('publication',public.comic_originals_share_card(e.slug),'doc',e.snapshot)
 from public.studio_original_editions e where e.slug=p_slug and e.status='live' and e.checked_digest=e.source_digest
$$;
create or replace function public.comic_originals_catalog()
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('slug',e.slug,'title',e.card->>'title','description',e.card->>'description','coverPath',e.cover_path,
 'creator',e.card->>'creator','language','en','style',e.snapshot#>>'{style,name}','rating',e.rating,'pageCount',15,'aspectRatio',e.snapshot#>>'{format,pageAspect}',
 'publishedAt',(extract(epoch from e.published_at)*1000)::bigint,'updatedAt',(extract(epoch from e.published_at)*1000)::bigint) order by e.book_key),'[]'::jsonb)
 from public.studio_original_editions e where e.status='live' and e.checked_digest=e.source_digest
$$;
revoke all on function public.comic_originals_share_card(text),public.comic_originals_public_payload(text),public.comic_originals_catalog() from public,anon,authenticated,service_role;
grant execute on function public.comic_originals_share_card(text),public.comic_originals_public_payload(text),public.comic_originals_catalog() to anon,authenticated,service_role;
commit;
