\set ON_ERROR_STOP 1
\ir ../telemetry_feedback.sql
\ir ../member_feedback_reports.sql
\ir ../member_feedback_reports.sql
do $$
declare member uuid:=gen_random_uuid(); other_user uuid:=gen_random_uuid(); nonce uuid:=gen_random_uuid();
saved_id uuid; retry uuid; img text:=encode(decode('524946460000000057454250','hex'),'base64'); fp text:=repeat('a',64); quota text:=repeat('b',64);
begin
  insert into auth.users(id) values(member),(other_user);
  saved_id:=public.submit_feedback_report(nonce,fp,quota,member,'bug','The page froze','Bug or error',null,'comicstudio',jsonb_build_array(img,img));
  retry:=public.submit_feedback_report(nonce,fp,quota,member,'bug','The page froze','Bug or error',null,'comicstudio',jsonb_build_array(img,img));
  assert saved_id=retry and (select count(*)=2 from public.feedback_report_images i where i.report_id=saved_id);
  assert (select metadata->>'attachmentCount'='2' and surface='comicstudio' from public.user_feedback f where f.id=saved_id);
  begin perform public.submit_feedback_report(nonce,fp,quota,other_user,'bug','The page froze',null,null,null,'[]');assert false;exception when sqlstate 'P0002' then null;end;
  begin perform public.submit_feedback_report(nonce,repeat('c',64),quota,member,'feedback','changed',null,null,null,'[]');assert false;exception when sqlstate 'P0002' then null;end;
  begin perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'feedback','test',null,null,null,jsonb_build_array(img),23);assert false;exception when sqlstate 'P0003' then null;end;
  assert (select count(*)=1 from public.feedback_report_receipts);
  begin perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'feedback','test',null,null,null,(select jsonb_agg(img) from generate_series(1,11)));assert false;exception when invalid_parameter_value then null;end;
  perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'feedback','Anonymous text',null,null,null,'[]',0);
  assert (select count(*)=2 from public.feedback_report_receipts);
  retry:=public.submit_feedback_report(gen_random_uuid(),fp,quota,member,'feedback','Ten attachments',null,null,null,
    (select jsonb_agg(img) from generate_series(1,10)));
  assert (select count(*)=10 and max(position)=10 from public.feedback_report_images where report_id=retry);
  delete from public.user_feedback where id=retry;
  delete from public.user_feedback f where f.id=saved_id;
  assert (select count(*)=0 from public.feedback_report_images) and (select count(*)=1 from public.feedback_report_receipts);
  assert not has_table_privilege('authenticated','public.feedback_report_images','select');
  assert not has_table_privilege('anon','public.feedback_report_images','insert');
  assert not has_table_privilege('authenticated','public.feedback_report_receipts','select');
  assert not has_function_privilege('authenticated','public.submit_feedback_report(uuid,text,text,uuid,text,text,text,text,text,jsonb,bigint)','execute');
  assert not has_function_privilege('anon','public.submit_feedback_report(uuid,text,text,uuid,text,text,text,text,text,jsonb,bigint)','execute');
  assert has_function_privilege('service_role','public.submit_feedback_report(uuid,text,text,uuid,text,text,text,text,text,jsonb,bigint)','execute');
end $$;
-- Two ten-image reports consume 7.5 MiB of a guest network's 24-hour allowance.
do $$
declare
  fp text:=repeat('1',64);
  quota text:=repeat('2',64);
  image text:=replace(encode(decode('524946460000000057454250' || repeat('00',393204),'hex'),'base64'),E'\n','');
  images jsonb;
begin
  select jsonb_agg(image) into images from generate_series(1,10);
  perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'bug','First',null,null,null,images);
  perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'bug','Second',null,null,null,images);
  begin
    perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'bug','Third',null,null,null,images);
    assert false;
  exception when sqlstate 'P0003' then null; end;
  assert (select count(*)=2 from public.feedback_report_receipts where quota_key=quota);
  perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'bug','Text only',null,null,null,'[]');
  update public.feedback_report_receipts set created_at=now()-interval '25 hours' where quota_key=quota;
  perform public.submit_feedback_report(gen_random_uuid(),fp,quota,null,'bug','Next day',null,null,null,images);
  assert (select count(*)=4 from public.feedback_report_receipts where quota_key=quota);
end $$;
\echo MEMBER_FEEDBACK_REPORTS_OK
