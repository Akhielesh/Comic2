\set ON_ERROR_STOP 1
\ir ../waitlist_signups.sql
\ir ../email_system.sql

-- Emulate an email sent before receipt versions existed and reapply without backfilling it.
insert into public.email_log(id,to_email,template,status,receipt_version,opened_at)
values ('00000000-0000-0000-0000-00000000a200','legacy@example.test','welcome','sent',null,'2026-01-01');
\ir ../email_system.sql
do $$
declare
  receipt_id uuid;
  first_ack timestamptz;
begin
  assert (select receipt_version is null and acknowledged_at is null and opened_at is not null
    from public.email_log where id='00000000-0000-0000-0000-00000000a200'), 'an older open never becomes an acknowledgement';
  assert not has_table_privilege('anon','public.email_log','select');
  assert not has_table_privilege('authenticated','public.email_log','update');
  insert into public.email_log(to_email,template,status,open_receipt_hash,ack_receipt_hash)
    values('reader@example.test','announcement','sent',repeat('a',64),repeat('b',64)) returning id into receipt_id;
  assert (select receipt_version=2 from public.email_log where id=receipt_id);
  update public.email_log set acknowledged_at=clock_timestamp() where ack_receipt_hash=repeat('b',64)
    and acknowledged_at is null returning acknowledged_at into first_ack;
  update public.email_log set acknowledged_at=clock_timestamp() where ack_receipt_hash=repeat('b',64) and acknowledged_at is null;
  assert not found, 'second acknowledgement cannot replace the first';
  assert (select acknowledged_at=first_ack and opened_at is null from public.email_log where id=receipt_id);
end $$;
\echo EMAIL_RECEIPTS_OK
