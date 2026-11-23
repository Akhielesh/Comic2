-- Adds three independently reconstructed, rating-only editorial receipts to the private allow-list.
-- Each tuple fixes the old source and gate, both ratings, and the candidate source.
-- The ordinary full review must still clear before an edition can move out of blocked.
begin;
do $$
declare
  receipt studio_original_review.legacy_rating_receipts%rowtype;
begin
  for receipt in values
    ('orchard','dbcb04155d5e7db8b818dc1ed20fadd979a249c0d89023d59804ab01bdafd0a3','b293c8b66d1b68d397ddbf04','G',
     'c06dbbbf3e51a2b9b8e8252fb2e01687afcc089f2ac1a73a9e8022732039fe61','PG'),
    ('fox','b3d967ad9be467d6514cf905e06e9902088b4715b5fc02ecc648c52203c8424a','de6ee2218e6d1062d8316b27','G',
     'a5cd67423ce6075a4461919c8a8e5da7dffe9a55926a644515c0fcd036ea6756','PG'),
    ('table-nine','3604e39f18cec4934f2d14266d03e3f2d5fddabc141843f0ee47e0409d4e57ea','25764e0472c44bc160b8defe','G',
     'c32e872c678b7ceec950c232f6067830c76ab7366d99b0cb503539440b171a0a','PG')
  loop
    insert into studio_original_review.legacy_rating_receipts
        (book_key,prior_digest,prior_gate,prior_rating,digest,rating)
      values(receipt.book_key,receipt.prior_digest,receipt.prior_gate,receipt.prior_rating,receipt.digest,receipt.rating)
      on conflict (book_key,prior_digest,prior_gate,digest) do nothing;
    if not exists(select 1 from studio_original_review.legacy_rating_receipts r where r=receipt) then
      raise exception 'An existing editorial receipt conflicts with the reviewed rating tuple';
    end if;
  end loop;
end $$;
commit;
