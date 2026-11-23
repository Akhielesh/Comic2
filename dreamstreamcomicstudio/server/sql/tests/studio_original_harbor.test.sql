\set ON_ERROR_STOP on
-- Use the actual discovery and publication schema with their synthetic fixtures, including
-- live, private and withdrawn records, so the lookup assertions exercise the real reader.
\ir comic_discovery.test.sql
\ir ../studio_original_rating_review.sql
\ir ../studio_original_verified_pg_receipts.sql

-- A previously refused edition has a different key from Harbor and must stay unavailable.
update public.studio_original_editions
  set status='blocked',moderation_status='blocked',checked_digest=null
  where book_key='tide';
create temp table existing_editions as select * from public.studio_original_editions;
create temp table existing_receipts as select * from studio_original_review.legacy_rating_receipts;

-- Both old checks must survive a refused migration. The member even owns an unlisted
-- slug: it need not appear in Discover to exclude this identifier from editorial use.
select pg_temp.mk('DSOriginalPort001','00000000-0000-4000-8000-00000000000a',
                  'Reserved by member fixture',p_visibility=>'unlisted');
\set ON_ERROR_STOP off
\ir ../studio_original_harbor.sql
\set ON_ERROR_STOP on
do $$
begin
  assert exists(select 1 from public.comic_publications where slug='DSOriginalPort001' and visibility='unlisted');
  assert (select pg_get_constraintdef(oid) not like '%harbor%' from pg_constraint
          where conrelid='public.studio_original_editions'::regclass and conname='studio_original_editions_book_key_check');
  assert (select pg_get_constraintdef(oid) not like '%DSOriginalPort001%' from pg_constraint
          where conrelid='public.studio_original_editions'::regclass and conname='studio_original_editions_check');
end $$;
-- Free only the synthetic conflict, preserving the member row and its storage key.
update public.comic_publications set slug='MemberPortTest001' where slug='DSOriginalPort001';

\ir ../studio_original_harbor.sql
\ir ../studio_original_harbor.sql

do $$
begin
  assert (select count(*)=4 from existing_editions);
  assert not exists(table existing_editions except table public.studio_original_editions);
  assert not exists(table public.studio_original_editions except table existing_editions);
  assert not exists(table existing_receipts except table studio_original_review.legacy_rating_receipts);
  assert not exists(table studio_original_review.legacy_rating_receipts except table existing_receipts);
  assert not has_table_privilege('anon','public.studio_original_editions','select');
  assert not has_table_privilege('authenticated','public.studio_original_editions','update');
  assert not has_function_privilege('authenticated','public.studio_claim_original(text,text,text,text,uuid)','execute');
end $$;

set role service_role;
do $$
declare
  d text:=repeat('a',64); asset text:='HarborFixture000000001'; tok uuid:=gen_random_uuid();
  member_key text;
begin
  select asset_key into strict member_key from public.comic_publications where slug='MemberPortTest001';
  begin
    perform public.studio_claim_original('harbor','DSOriginalPort001',d,member_key,tok);
    raise exception 'expected member asset collision' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%member publication%'; end;
  begin
    perform public.studio_claim_original('harbor','DSOriginalPort002',d,asset,tok);
    raise exception 'accepted alternate Harbor slug' using errcode='XX000';
  exception when check_violation then null; end;
  begin
    perform public.studio_claim_original('unregistered','DSOriginalPort001',d,asset,tok);
    raise exception 'accepted unregistered editorial key' using errcode='XX000';
  exception when check_violation then null; end;

  assert public.studio_claim_original('harbor','DSOriginalPort001',d,asset,tok)->>'status'='staging';
  assert public.comic_originals_public_payload('DSOriginalPort001') is null;
  begin
    update public.studio_original_editions set status='live' where book_key='harbor';
    raise exception 'accepted unreviewed edition' using errcode='XX000';
  exception when check_violation then null; end;
  update public.studio_original_editions
    set checked_digest=d,checked_at=now(),gate_hash=repeat('c',24),rating='PG',moderation_status='cleared',status='checked'
    where book_key='harbor';
  assert public.comic_originals_share_card('DSOriginalPort001') is null;
  update public.studio_original_editions set published_at=now(),
    card='{"title":"Harbor Fixture","creator":"DreamStream Studio Originals","pageCount":15}',
    snapshot=jsonb_build_object('pages',(select jsonb_agg(i) from generate_series(1,15) i)),
    cover_path='pub/'||asset||'/fixture.webp',status='live' where book_key='harbor';
end $$;

set role anon;
do $$
begin
  assert public.comic_originals_public_payload('DSOriginalPort001')#>>'{publication,rating}'='PG';
  assert jsonb_array_length(public.comic_originals_public_payload('DSOriginalPort001')#>'{doc,pages}')=15;
  assert public.t_slugs(public.comic_discover_list(p_q=>'Harbor Fixture',p_rating=>'PG'))=array['DSOriginalPort001'];
  assert public.t_slugs(public.comic_discover_list(p_q=>'Harbor Fixture',p_rating=>'G'))='{}';
  assert public.t_slugs(public.comic_discover_list(p_slugs=>array['MemberPortTest001','DSOriginalTide001','DSOriginalPort001']))=array['DSOriginalPort001'];
  assert public.comic_originals_public_payload('DSOriginalTide001') is null;
end $$;
reset role;
\echo STUDIO_ORIGINAL_HARBOR_OK
