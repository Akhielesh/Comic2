\set ON_ERROR_STOP on
-- The shared harness provisions the three Supabase roles before this isolated fixture.
create table public.comic_publications(slug text,asset_key text);
grant select on public.comic_publications to service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
\ir ../studio_original_editions.sql
\ir ../studio_original_editions.sql
set role service_role;
do $$
declare
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); k text:='StudioStorageFixture01'; d text:=repeat('a',64); c jsonb;
begin
  assert not has_table_privilege('service_role','public.studio_original_editions','truncate');
  assert not has_table_privilege('authenticated','public.studio_original_editions','select');
  assert not has_table_privilege('anon','public.studio_original_editions','insert');
  assert not has_function_privilege('anon','public.studio_claim_original(text,text,text,text,uuid)','execute');
  assert has_function_privilege('anon','public.comic_originals_catalog()','execute');
  assert has_function_privilege('authenticated','public.comic_originals_public_payload(text)','execute');
  c:=public.studio_claim_original('tide','DSOriginalTide001',d,k,a); assert c->>'status'='staging';
  assert public.comic_originals_public_payload('DSOriginalTide001') is null and public.comic_originals_catalog()='[]'::jsonb;
  begin perform public.studio_claim_original('tide','DSOriginalTide001',d,k,b);raise exception 'lost race guard' using errcode='XX000';exception when raise_exception then assert sqlerrm like '%running%';end;
  begin update public.studio_original_editions set status='live' where book_key='tide';raise exception 'lost review guard' using errcode='XX000';exception when check_violation then null;end;
  begin perform public.studio_claim_original('tide','DSOriginalTide001',repeat('b',64),k,a);raise exception 'lost digest guard' using errcode='XX000';exception when raise_exception then assert sqlerrm like '%source differs%';end;
  update public.studio_original_editions set checked_digest=d,gate_hash=repeat('a',24),checked_at=now(),rating='G',moderation_status='cleared',status='checked',lease_token=null,lease_until=null;
  assert public.comic_originals_share_card('DSOriginalTide001') is null;
  c:=public.studio_claim_original('tide','DSOriginalTide001',d,k,b);assert c->>'status'='checked';
  update public.studio_original_editions set published_at=now(),snapshot=jsonb_build_object('pages',(select jsonb_agg(i) from generate_series(1,15)i)),
    card='{"title":"Fixture","pageCount":15,"creator":"DreamStream Studio Originals"}',cover_path='pub/'||k||'/fixture.webp',status='live';
  assert jsonb_array_length(public.comic_originals_catalog())=1;
  assert jsonb_array_length(public.comic_originals_public_payload('DSOriginalTide001')#>'{doc,pages}')=15;
  assert public.comic_originals_share_card('DSOriginalTide001')->>'visibility'='public';
  assert not(public.comic_originals_catalog()->0 ? 'lease_token') and not(public.comic_originals_public_payload('DSOriginalTide001') ? 'gate_hash');
  update public.studio_original_editions set status='withdrawn';
  assert public.comic_originals_share_card('DSOriginalTide001') is null and public.comic_originals_catalog()='[]'::jsonb;
  begin perform public.studio_claim_original('tide','DSOriginalTide001',d,k,b);raise exception 'lost withdrawn protection' using errcode='XX000';exception when raise_exception then assert sqlerrm like '%unavailable%';end;
end $$;
reset role;
insert into public.comic_publications values('DSOriginalNine001','AnotherAssetFixture123');
set role service_role;
do $$begin
  begin perform public.studio_claim_original('table-nine','DSOriginalNine001',repeat('c',64),'DifferentFixtureKey001',gen_random_uuid());
    raise exception 'lost member collision guard' using errcode='XX000';exception when raise_exception then assert sqlerrm like '%member publication%';end;
end$$;
set role anon;
select public.comic_originals_catalog();
reset role;
\echo STUDIO_ORIGINAL_EDITIONS_OK
