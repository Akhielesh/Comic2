\set ON_ERROR_STOP on
-- Only synthetic edition records and the exact independently reviewed public edition digests are used.
create table public.comic_publications(slug text,asset_key text);
grant select on public.comic_publications to service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
\ir ../studio_original_editions.sql
\ir ../studio_original_rating_review.sql
\ir ../studio_original_verified_pg_receipts.sql
\ir ../studio_original_verified_pg_receipts.sql

create function pg_temp.refuses(command text) returns void language plpgsql as $$
begin
  begin execute command; exception when raise_exception or insufficient_privilege then return; end;
  raise exception 'An incomplete or mismatched receipt was admitted' using errcode='XX000';
end $$;
do $$
declare
  r record; tok uuid;
  claim constant text := 'select public.studio_claim_original_revision(%L,%L,%L,%L,%L,%L,%L)';
begin
  assert (select count(*) from studio_original_review.legacy_rating_receipts)=4;
  assert not has_schema_privilege('service_role','studio_original_review','usage');
  assert not has_table_privilege('anon','studio_original_review.legacy_rating_receipts','select');
  assert not has_function_privilege('authenticated','public.studio_claim_original_revision(text,text,text,text,text,text,uuid)','execute');
  for r in select * from (values
    ('orchard','dbcb04155d5e7db8b818dc1ed20fadd979a249c0d89023d59804ab01bdafd0a3','b293c8b66d1b68d397ddbf04','G',
     'c06dbbbf3e51a2b9b8e8252fb2e01687afcc089f2ac1a73a9e8022732039fe61','PG'),
    ('fox','b3d967ad9be467d6514cf905e06e9902088b4715b5fc02ecc648c52203c8424a','de6ee2218e6d1062d8316b27','G',
     'a5cd67423ce6075a4461919c8a8e5da7dffe9a55926a644515c0fcd036ea6756','PG'),
    ('table-nine','3604e39f18cec4934f2d14266d03e3f2d5fddabc141843f0ee47e0409d4e57ea','25764e0472c44bc160b8defe','G',
     'c32e872c678b7ceec950c232f6067830c76ab7366d99b0cb503539440b171a0a','PG')
  ) expected(book_key,prior_digest,prior_gate,prior_rating,digest,rating) loop
    assert exists(select 1 from studio_original_review.legacy_rating_receipts v
      where (v.book_key,v.prior_digest,v.prior_gate,v.prior_rating,v.digest,v.rating)=
            (r.book_key,r.prior_digest,r.prior_gate,r.prior_rating,r.digest,r.rating));
    insert into public.studio_original_editions(book_key,slug,source_digest,asset_key,status,rating,moderation_status,checked_at,gate_hash)
      values(r.book_key,case r.book_key when 'fox' then 'DSOriginalFox0001' when 'orchard' then 'DSOriginalTree001'
        when 'table-nine' then 'DSOriginalNine001' end,r.prior_digest,left(md5(r.book_key),22),'blocked',r.prior_rating,'blocked',now(),r.prior_gate);
    tok:=gen_random_uuid();
    set local role service_role;
    perform pg_temp.refuses(format(claim,r.book_key,r.prior_digest,r.prior_gate,r.prior_rating,repeat('1',64),r.rating,tok));
    perform pg_temp.refuses(format(claim,r.book_key,r.prior_digest,repeat('2',24),r.prior_rating,r.digest,r.rating,tok));
    perform pg_temp.refuses(format(claim,r.book_key,r.prior_digest,r.prior_gate,r.prior_rating,r.digest,'PG-13',tok));
    perform public.studio_claim_original_revision(r.book_key,r.prior_digest,r.prior_gate,r.prior_rating,r.digest,r.rating,tok);
    perform pg_temp.refuses(format(claim,r.book_key,r.prior_digest,r.prior_gate,r.prior_rating,r.digest,r.rating,gen_random_uuid()));
    assert (select status='blocked' and source_digest=r.prior_digest and checked_digest is null from public.studio_original_editions where book_key=r.book_key);
    reset role;
  end loop;
  assert (select count(*) from studio_original_review.attempts where status='checking' and legacy_receipt)=3;
  assert public.comic_originals_catalog()='[]'::jsonb;
end $$;
\echo STUDIO_ORIGINAL_VERIFIED_PG_RECEIPTS_OK
