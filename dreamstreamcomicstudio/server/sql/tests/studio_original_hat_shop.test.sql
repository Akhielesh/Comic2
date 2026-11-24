\set ON_ERROR_STOP on
\ir studio_original_collection.test.sql

-- Model a refused, never-published Bubble whose report is solely over the requested rating.
-- This reaches the historical revision RPC's actual first-time-edition restriction.
update public.studio_original_editions set status='blocked', moderation_status='blocked', checked_digest=null,
  lease_token=null, lease_until=null, card=null, snapshot=null, published_at=null, cover_path=null,
  review_report=jsonb_set(review_report,'{pages,14}','{"status":"over_rating","assessed":"PG-13","categories":[]}')
  where book_key='bubble';
create temporary table old_editions as table public.studio_original_editions;
create temporary table old_pins as table studio_original_review.legacy_rating_receipts;
create temporary table old_attempts as table studio_original_review.attempts;

-- A nonpublic member route prevents registration. The transaction must fail before extending the page registry.
select pg_temp.mk('DSOriginalHats001','00000000-0000-4000-8000-00000000000a','Member collision',p_visibility=>'unlisted');
\set ON_ERROR_STOP off
\ir ../studio_original_hat_shop.sql
\set ON_ERROR_STOP on
do $$ begin
  assert public.studio_original_story_pages('hat-shop') is null;
  assert exists(select from public.comic_publications where slug='DSOriginalHats001' and visibility='unlisted');
end $$;
update public.comic_publications set slug='MemberHatsTest001' where slug='DSOriginalHats001';
create temporary table old_members as table public.comic_publications;
\ir ../studio_original_hat_shop.sql
\ir ../studio_original_hat_shop.sql

do $$ begin
  assert public.studio_original_story_pages('hat-shop')=15;
  assert public.studio_original_story_pages('unregistered') is null;
  assert not exists(table public.studio_original_editions except table old_editions);
  assert not exists(table old_editions except table public.studio_original_editions);
  assert not has_function_privilege('authenticated','public.studio_original_story_pages(text)','execute');
  assert not has_table_privilege('anon','public.studio_original_editions','select');
  assert not has_schema_privilege('service_role','studio_original_review','usage');
end $$;

-- A member can have acquired the slug since the migration. The real claim must check again.
begin;
update public.comic_publications set slug='DSOriginalHats001' where slug='MemberHatsTest001';
set local role service_role;
do $$ begin
  perform public.studio_claim_original('hat-shop','DSOriginalHats001',repeat('a',64),repeat('H',22),gen_random_uuid());
  raise exception 'Accepted a member route' using errcode='XX000';
exception when raise_exception then assert sqlerrm like '%member publication%'; end $$;
rollback;

create function pg_temp.mark_checked(r jsonb, requested text default 'PG', digest text default repeat('a',64))
returns void language sql as $$
  update public.studio_original_editions set status='checked', moderation_status='cleared', rating=requested,
    checked_at=now(), gate_hash=repeat('b',24), checked_digest=digest, review_report=r where book_key='hat-shop'
$$;
create function pg_temp.publish(doc jsonb, c jsonb) returns void language sql as $$
  update public.studio_original_editions set status='live', published_at=now(), card=c, snapshot=doc,
    cover_path='pub/'||asset_key||'/cover.webp', lease_token=null, lease_until=null where book_key='hat-shop'
$$;
set role service_role;
do $$
declare
  member_asset text; token uuid:=gen_random_uuid();
  pass jsonb:='{"status":"pass","assessed":"PG","categories":[]}';
  pending jsonb:='{"status":"unchecked","assessed":null,"categories":[]}';
  age jsonb:='{"status":"over_rating","assessed":"PG-13","categories":[]}';
  report jsonb:=jsonb_build_object('text',pass,'cover',pass,'pages',(select jsonb_agg(pass) from generate_series(1,15)));
  doc jsonb:=jsonb_build_object('id','DSOriginalHats001','brief',jsonb_build_object('title','Four Letters and a Hat Shop'),
    'format',jsonb_build_object('pageCount',15,'kind','comic','readingDirection','ltr','pageAspect','2:3'),
    'pages',(select jsonb_agg(i) from generate_series(1,15) i));
  card jsonb:='{"title":"Four Letters and a Hat Shop","creator":"DreamStream Studio Originals","kindLabel":"Comic","pageCount":15,"aspect":"2:3"}';
  target text[]; broken jsonb;
begin
  select asset_key into strict member_asset from public.comic_publications where slug='MemberHatsTest001';
  begin
    perform public.studio_claim_original('hat-shop','DSOriginalHats001',repeat('a',64),member_asset,token);
    raise exception 'Accepted an existing member asset' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%member publication%'; end;
  begin
    perform public.studio_claim_original('hat-shop','DSOriginalHats002',repeat('a',64),repeat('H',22),token);
    raise exception 'Accepted an alternate Hat Shop route' using errcode='XX000';
  exception when check_violation then null; end;
  assert public.studio_claim_original('hat-shop','DSOriginalHats001',repeat('a',64),repeat('H',22),token)->>'status'='staging';
  assert public.comic_originals_public_payload('DSOriginalHats001') is null;
  begin
    perform public.studio_claim_original('hat-shop','DSOriginalHats001',repeat('c',64),repeat('I',22),token);
    raise exception 'Accepted a changed first-time source' using errcode='XX000';
  exception when raise_exception then assert sqlerrm like '%source differs%'; end;

  -- Each of the seventeen independently assessed positions is required, including the last story page.
  for target in select array['text'] union all select array['cover'] union all select array['pages',i::text] from generate_series(0,14) i loop
    begin
      perform pg_temp.mark_checked(jsonb_set(report,target,pending));
      raise exception 'Accepted unchecked target %',target using errcode='XX000';
    exception when check_violation then null; end;
  end loop;
  for broken in select * from (values (null::jsonb),(report-'text'),(report-'cover'),(report #- '{pages,14}'),
    (jsonb_set(report,'{pages}',(report->'pages')||jsonb_build_array(pass))),
    (jsonb_set(report,'{cover}',age)),(jsonb_set(report,'{pages,14,categories}','["dangerous"]'))) bad(r) loop
    begin
      perform pg_temp.mark_checked(broken);
      raise exception 'Accepted an absent, partial, over-rating or hard-category report' using errcode='XX000';
    exception when check_violation then null; end;
  end loop;
  begin
    perform pg_temp.mark_checked(report,'PG-13');
    raise exception 'Accepted PG-13 metadata for the PG edition' using errcode='XX000';
  exception when check_violation then null; end;
  begin
    perform pg_temp.mark_checked(report,'PG',repeat('c',64));
    raise exception 'Accepted a different checked source digest' using errcode='XX000';
  exception when check_violation then null; end;

  -- Even an exclusively over-rating report cannot reserve a metadata-only revision of either new source.
  begin
    update public.studio_original_editions set status='blocked', moderation_status='blocked', rating='PG',
      checked_at=now(), gate_hash=repeat('b',24), review_report=jsonb_set(report,'{cover}',age), lease_token=null, lease_until=null
      where book_key='hat-shop';
    perform public.studio_claim_original_revision('hat-shop',repeat('a',64),repeat('b',24),'PG',repeat('d',64),'PG-13',token);
    raise exception 'Accepted a Hat Shop historical rating review' using errcode='XX000';
  exception when check_violation then assert sqlerrm like '%original_hat_shop_first_review%'; end;
  begin
    perform public.studio_claim_original_revision('bubble',repeat('a',64),repeat('b',24),'PG',repeat('d',64),'PG-13',token);
    raise exception 'Reopened the closed Bubble decision' using errcode='XX000';
  exception when check_violation then assert sqlerrm like '%original_first_time_collection%'; end;

  perform pg_temp.mark_checked(report);
  assert public.comic_originals_share_card('DSOriginalHats001') is null;
  for broken in select * from (values (doc #- '{pages,14}'),(doc - 'id'),(doc || '{"id":"DSOriginalBubl001"}'),
    (jsonb_set(doc,'{format,pageCount}','16')),(jsonb_set(doc,'{format,kind}','"manga"')),
    (jsonb_set(doc,'{format,readingDirection}','"rtl"')),(jsonb_set(doc,'{format,pageAspect}','"3:2"')),
    (jsonb_set(doc,'{brief,title}','"Different book"'))) bad(d) loop
    begin
      perform pg_temp.publish(broken,card || jsonb_build_object('aspect',broken#>>'{format,pageAspect}'));
      raise exception 'Accepted the wrong live reading copy' using errcode='XX000';
    exception when check_violation then null; end;
  end loop;
  perform pg_temp.publish(doc,card);
end $$;
set role anon;
do $$ begin
  assert public.comic_originals_public_payload('DSOriginalHats001')#>>'{doc,id}'='DSOriginalHats001';
  assert public.comic_originals_share_card('DSOriginalHats001')->>'rating'='PG';
  assert public.t_slugs(public.comic_discover_list(p_q=>'Four Letters and a Hat Shop',p_kind=>'comic',p_rating=>'PG'))=array['DSOriginalHats001'];
  assert public.comic_originals_public_payload('DSOriginalBubl001') is null;
  assert public.comic_originals_public_payload('DSOriginalTide001') is null;
end $$;
reset role;

-- Reapplication after a publication is also safe. Compare the entire held decisions and private receipts.
create temporary table published_editions as table public.studio_original_editions;
\ir ../studio_original_hat_shop.sql
do $$ begin
  assert not exists(table published_editions except table public.studio_original_editions);
  assert not exists(table public.studio_original_editions except table published_editions);
  assert not exists(table old_editions except table public.studio_original_editions);
  assert not exists(table old_pins except table studio_original_review.legacy_rating_receipts);
  assert not exists(table studio_original_review.legacy_rating_receipts except table old_pins);
  assert not exists(table old_attempts except table studio_original_review.attempts);
  assert not exists(table studio_original_review.attempts except table old_attempts);
  assert not exists(table old_members except table public.comic_publications);
  assert not exists(table public.comic_publications except table old_members);
end $$;
\echo STUDIO_ORIGINAL_HAT_SHOP_OK
