\set ON_ERROR_STOP on
\ir studio_original_harbor.test.sql

-- Reproduce the two editorial expressions already deployed, then exercise the upgrade path as well as reapplication.
do $$
declare
  f regprocedure := 'public.comic_discover_list(text,text,text,text,text,text,boolean,integer,text,text[])'::regprocedure;
  d text := pg_get_functiondef(f);
begin
  execute replace(replace(d,$q$'kind', coalesce(e->>'kind','comic'), 'pageCount', e->'pageCount'$q$,
    $q$'kind', 'comic', 'pageCount', e->'pageCount'$q$),$q$(p_kind is null or p_kind=coalesce(e->>'kind','comic'))$q$,
    $q$(p_kind is null or p_kind='comic')$q$);
end $$;
create temporary table before_collection as table public.studio_original_editions;
create temporary table before_attempts as table studio_original_review.attempts;
create temporary table before_pins as table studio_original_review.legacy_rating_receipts;
select pg_temp.mk('DSOriginalMarg001','00000000-0000-4000-8000-00000000000a','Collision fixture',p_visibility=>'unlisted');
\set ON_ERROR_STOP off
\ir ../studio_original_collection.sql
\set ON_ERROR_STOP on
do $$ begin
  assert to_regprocedure('public.studio_original_story_pages(text)') is null;
  assert exists(select from public.comic_publications where slug='DSOriginalMarg001');
end $$;
update public.comic_publications set slug='MemberMangaTest01' where slug='DSOriginalMarg001';

\ir ../studio_original_collection.sql
\ir ../studio_original_collection.sql

do $$ begin
  assert not exists(table before_collection except table public.studio_original_editions);
  assert not exists(table public.studio_original_editions except table before_collection);
  assert not exists(table before_attempts except table studio_original_review.attempts);
  assert not exists(table before_pins except table studio_original_review.legacy_rating_receipts);
  assert not has_table_privilege('anon','public.studio_original_editions','select');
  assert not has_function_privilege('authenticated','public.studio_original_report_state(text,jsonb,text)','execute');
  assert not has_schema_privilege('service_role','studio_original_review','usage');
  assert has_function_privilege('anon','public.comic_originals_catalog()','execute');
end $$;

set role service_role;
do $$
declare
  item record; d text:=repeat('a',64); token uuid:=gen_random_uuid();
  passed jsonb:='{"status":"pass","assessed":"PG","categories":[]}'; report jsonb; copy_doc jsonb;
  bad jsonb; c jsonb; asset text;
begin
  for item in select * from (values
       ('margin','DSOriginalMarg001',30,'manga','rtl','2:3','Manga'),
       ('parrots','DSOriginalBird001',20,'comic','ltr','2:3','Comic'),
       ('bubble','DSOriginalBubl001',15,'comic','ltr','2:3','Comic'),
       ('glass-hills','DSOriginalWest001',20,'comic','ltr','3:2','Comic'),
       ('night-atlas','DSOriginalNite001',15,'comic','ltr','3:2','Comic')
     ) as titles(key,slug,n,kind,dir,aspect,kind_label) loop
    asset:=substr(md5(item.key),1,22);
    assert public.studio_claim_original(item.key,item.slug,d,asset,token)->>'status'='staging';
    assert public.comic_originals_public_payload(item.slug) is null;
    report:=jsonb_build_object('text',passed,'cover',passed,'pages',(select jsonb_agg(passed) from generate_series(1,item.n)));
    assert public.studio_original_report_state(item.key,report,'PG')='cleared';
    assert public.studio_original_report_state(item.key,report #- array['pages',(item.n-1)::text],'PG')='invalid';
    bad:=jsonb_set(report,array['pages',(item.n-1)::text], '{"status":"pass","assessed":"PG","categories":["dangerous"]}');
    assert public.studio_original_report_state(item.key,bad,'PG')='blocked';
    begin
      update public.studio_original_editions set checked_digest=d,checked_at=now(),gate_hash=repeat('b',24),
        rating='PG',moderation_status='cleared',status='checked',review_report=null where book_key=item.key;
      raise exception 'Missing first-time review admitted' using errcode='XX000';
    exception when check_violation then null; end;
    begin
      update public.studio_original_editions set checked_digest=d,checked_at=now(),gate_hash=repeat('b',24),
        rating='PG',moderation_status='cleared',status='checked',review_report=bad where book_key=item.key;
      raise exception 'Incomplete approval admitted' using errcode='XX000';
    exception when check_violation then null; end;
    update public.studio_original_editions set checked_digest=d,checked_at=now(),gate_hash=repeat('b',24),
      rating='PG',moderation_status='cleared',status='checked',review_report=report where book_key=item.key;
    assert public.comic_originals_public_payload(item.slug) is null;
    copy_doc:=jsonb_build_object('pages',(select jsonb_agg(i) from generate_series(1,item.n) i),
      'format',jsonb_build_object('pageCount',item.n,'kind',item.kind,'readingDirection',item.dir,'pageAspect',item.aspect));
    c:=jsonb_build_object('title','Collection '||item.key,'description','A synthetic book','pageCount',item.n,
      'creator','DreamStream Studio Originals','kindLabel',item.kind_label,'aspect',item.aspect);
    begin
      update public.studio_original_editions set published_at=now(),status='live',card=c,snapshot=copy_doc #- array['pages',(item.n-1)::text],
        cover_path='pub/'||asset||'/cover.webp' where book_key=item.key;
      raise exception 'Truncated snapshot admitted' using errcode='XX000';
    exception when check_violation then null; end;
    begin
      update public.studio_original_editions set published_at=now(),status='live',card=c,snapshot=jsonb_set(copy_doc,'{format,readingDirection}','"oops"'),
        cover_path='pub/'||asset||'/cover.webp' where book_key=item.key;
      raise exception 'Wrong native reading direction admitted' using errcode='XX000';
    exception when check_violation then null; end;
    update public.studio_original_editions set published_at=now(),status='live',card=c,snapshot=copy_doc,
      cover_path='pub/'||asset||'/cover.webp' where book_key=item.key;
  end loop;
end $$;
set role anon;
do $$ begin
  assert jsonb_array_length(public.comic_originals_public_payload('DSOriginalMarg001')#>'{doc,pages}')=30;
  assert public.comic_originals_public_payload('DSOriginalMarg001')#>>'{doc,format,readingDirection}'='rtl';
  assert public.comic_originals_public_payload('DSOriginalWest001')#>>'{doc,format,pageAspect}'='3:2';
  assert public.comic_originals_public_payload('DSOriginalTide001') is null;
  assert public.t_slugs(public.comic_discover_list(p_kind=>'manga',p_q=>'Collection'))=array['DSOriginalMarg001'];
  assert cardinality(public.t_slugs(public.comic_discover_list(p_kind=>'comic',p_q=>'Collection')))=4;
  assert (select value->>'pageCount'='30' and value->>'kind'='manga' from jsonb_array_elements(public.comic_originals_catalog())
    where value->>'slug'='DSOriginalMarg001');
end $$;
reset role;
\echo STUDIO_ORIGINAL_COLLECTION_OK
