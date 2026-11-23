\set ON_ERROR_STOP on
create table public.comic_publications(slug text,asset_key text);
grant select on public.comic_publications to service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
\ir ../studio_original_editions.sql
\ir ../studio_original_rating_review.sql
\ir ../studio_original_rating_review.sql

create function pg_temp.report(item jsonb) returns jsonb language sql as $$
 select jsonb_build_object('text',item,'cover',item,'pages',(select jsonb_agg(item) from generate_series(1,15)))
$$;
create function pg_temp.denied(q text) returns void language plpgsql as $$
begin
  begin execute q; exception when raise_exception or insufficient_privilege or no_data_found or check_violation then return; end;
  raise exception 'Expected review refusal: %',q using errcode='XX000';
end $$;

-- Fixtures are synthetic moderation records; no real artwork or account is needed.
insert into public.studio_original_editions(book_key,slug,source_digest,asset_key,status,rating,moderation_status,
    moderation_usd,checked_at,gate_hash)
values ('tide','DSOriginalTide001','81fac03b885770c225eb5f169f4243f55e5c9231312b66129ac2c3cfc1fcd9b0',
    'T000000000000000000001','blocked','G','blocked',0.01,now(), '395126b9733da1c781857d04'),
 ('fox','DSOriginalFox0001',repeat('b',64),'F000000000000000000001','blocked','G','blocked',0.03,now(),repeat('b',24));
do $$
declare
  good jsonb := '{"status":"pass","assessed":"G","categories":[]}';
  age jsonb := '{"status":"over_rating","assessed":"PG","categories":["scary"]}';
  bad jsonb := '{"status":"blocked","assessed":"X","categories":["dangerous"]}';
  pending jsonb := '{"status":"unchecked","assessed":null,"categories":[]}';
  r jsonb := pg_temp.report(good);
  old_d text := '81fac03b885770c225eb5f169f4243f55e5c9231312b66129ac2c3cfc1fcd9b0';
  new_d text := 'd24c7230093e0f37d66d7b3cb680c0c7ab8ec9ddddfd7a816f4d3016de739803';
  old_g text := '395126b9733da1c781857d04'; tok uuid:=gen_random_uuid(); other uuid:=gen_random_uuid();
  claimant text := 'select public.studio_claim_original_revision(%L,%L,%L,%L,%L,%L,%L)';
  finisher text := 'select public.studio_finish_original_revision(%L,%L,%L,%L,%L,%L,%L)';
begin
  assert not has_schema_privilege('service_role','studio_original_review','usage');
  assert not has_table_privilege('anon','studio_original_review.attempts','select');
  assert not has_table_privilege('service_role','studio_original_review.attempts','update');
  assert not has_function_privilege('authenticated','public.studio_claim_original_revision(text,text,text,text,text,text,uuid)','execute');
  assert not has_function_privilege('anon','public.studio_finish_original_revision(text,text,uuid,text,text,jsonb,numeric)','execute');
  assert has_function_privilege('service_role','public.studio_finish_original_revision(text,text,uuid,text,text,jsonb,numeric)','execute');

  perform pg_temp.denied(format('update public.studio_original_editions set review_report=%L where book_key=%L',
    r||'{"rawClassifierReply":"free form"}','tide'));
  -- Even for the legacy reviewed source, a recorded contrary decision overrides the pin.
  update public.studio_original_editions set review_report=jsonb_set(pg_temp.report(age),'{pages,14}',bad) where book_key='tide';
  perform pg_temp.denied(format(claimant,'tide',old_d,old_g,'G',new_d,'PG',tok));
  update public.studio_original_editions set review_report=null,lease_token=other,lease_until=now()+interval '10 minutes' where book_key='tide';
  perform pg_temp.denied(format(claimant,'tide',old_d,old_g,'G',new_d,'PG',tok));
  update public.studio_original_editions set lease_token=null,lease_until=null where book_key='tide';
  perform pg_temp.denied(format(claimant,'tide',old_d,repeat('0',24),'G',new_d,'PG',tok));
  perform pg_temp.denied(format(claimant,'tide',old_d,old_g,'G',repeat('f',64),'PG',tok));
  perform pg_temp.denied(format(claimant,'tide',old_d,old_g,'G',new_d,'PG-13',tok));

  set local role service_role;
  set local timezone='UTC';
  perform public.studio_claim_original_revision('tide',old_d,old_g,'G',new_d,'PG',tok);
  perform pg_temp.denied(format(claimant,'tide',old_d,old_g,'G',new_d,'PG',tok));
  perform pg_temp.denied(format(claimant,'tide',old_d,old_g,'G',new_d,'PG',other));
  assert public.comic_originals_catalog()='[]'; assert public.comic_originals_public_payload('DSOriginalTide001') is null;
  assert (select status='blocked' and source_digest=old_d and lease_token is null from public.studio_original_editions where book_key='tide');
  perform pg_temp.denied(format(finisher,'tide',new_d,other,repeat('c',24),'cleared',r,0.01));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',r-'cover',0));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',jsonb_set(r,'{pages}',(r->'pages')-14),0));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',jsonb_set(r,'{text}',bad),0));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',jsonb_set(r,'{pages,9}',pending),0));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',jsonb_set(r,'{pages,8,categories}','["graphic_gore"]'),0));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',jsonb_set(r,'{pages,8,assessed}','"PG-13"'),0));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',jsonb_set(r,'{cover}',good||'{"text":"forbidden raw note"}'),0));
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',r,'NaN'));
  reset role;
  -- An in-flight verdict cannot overwrite an intervening correction, withdrawal or different edition identity.
  update public.studio_original_editions set status='withdrawn' where book_key='tide';
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',r,0));
  update public.studio_original_editions set status='blocked',gate_hash=repeat('a',24) where book_key='tide';
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',r,0));
  update public.studio_original_editions set gate_hash=old_g where book_key='tide';

  set local role service_role;
  perform public.studio_finish_original_revision('tide',new_d,tok,repeat('c',24),'needs_check',jsonb_set(r,'{cover}',pending),0.02);
  perform pg_temp.denied(format(finisher,'tide',new_d,tok,repeat('c',24),'cleared',r,0));
  perform public.studio_claim_original_revision('tide',old_d,old_g,'G',new_d,'PG',other);
  reset role;
  -- A dead lease cannot promote; its replacement is explicit.
  update studio_original_review.attempts set expires_at=now()-interval '1 second' where token=other;
  set local role service_role;
  perform pg_temp.denied(format(finisher,'tide',new_d,other,repeat('c',24),'cleared',r,0));
  tok:=gen_random_uuid();
  perform public.studio_claim_original_revision('tide',old_d,old_g,'G',new_d,'PG',tok);
  set local timezone='America/New_York';
  perform public.studio_finish_original_revision('tide',new_d,tok,repeat('d',24),'cleared',r,0.04);
  perform public.studio_finish_original_revision('tide',new_d,tok,repeat('d',24),'cleared',r,0.04);
  assert (select status='checked' and checked_digest=new_d and source_digest=new_d and rating='PG' and gate_hash=repeat('d',24)
    and moderation_usd=0.07 and lease_token=tok and review_report=r from public.studio_original_editions where book_key='tide');
  assert public.comic_originals_catalog()='[]'; -- Ordinary verified upload/activation remains necessary.
  assert public.studio_claim_original('tide','DSOriginalTide001',new_d,'T000000000000000000001',tok)->>'status'='checked';
  reset role;
  assert (select previous_decision->>'sourceDigest'=old_d and previous_decision->>'gate'=old_g and previous_decision->>'rating'='G'
    and previous_decision->>'status'='blocked' and (previous_decision->>'costUsd')::numeric=.01 and previous_decision->>'checkedAt' is not null
    and legacy_receipt and report=r from studio_original_review.attempts where token=tok);

  -- An edition without a persisted mixed-age report or a reviewed legacy pin cannot be revised.
  old_d:=repeat('b',64); old_g:=repeat('b',24); new_d:=repeat('d',64); tok:=gen_random_uuid();
  perform pg_temp.denied(format(claimant,'fox',old_d,old_g,'G',new_d,'PG',tok));
  update public.studio_original_editions set review_report=jsonb_set(pg_temp.report(age),'{pages,6}',pending) where book_key='fox';
  perform pg_temp.denied(format(claimant,'fox',old_d,old_g,'G',new_d,'PG',tok));
  update public.studio_original_editions set review_report=jsonb_set(pg_temp.report(good),'{cover}',age) where book_key='fox';
  set local role service_role;
  perform public.studio_claim_original_revision('fox',old_d,old_g,'G',new_d,'PG',tok);
  perform public.studio_finish_original_revision('fox',new_d,tok,repeat('d',24),'blocked',jsonb_set(r,'{cover}',bad),0.02);
  assert (select status='blocked' and source_digest=old_d and gate_hash=old_g from public.studio_original_editions where book_key='fox');
  perform pg_temp.denied(format(claimant,'fox',old_d,old_g,'G',repeat('e',64),'PG-13',gen_random_uuid()));
end $$;
\echo STUDIO_ORIGINAL_RATING_REVIEW_OK
