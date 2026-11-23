-- Apply after telemetry_feedback.sql. Report text stays in the existing admin inbox.
begin;
create table if not exists public.feedback_report_receipts (
  report_id uuid primary key references public.user_feedback(id) on delete cascade,
  submission_id uuid not null unique,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  quota_key text not null check(quota_key ~ '^[0-9a-f]{64}$'),
  image_bytes integer not null check(image_bytes between 0 and 3932160),
  created_at timestamptz not null default now()
);
create index if not exists feedback_report_quota on public.feedback_report_receipts(quota_key,created_at) where image_bytes>0;
create table if not exists public.feedback_report_images (
  report_id uuid not null references public.feedback_report_receipts(report_id) on delete cascade,
  position smallint not null check(position between 1 and 10),
  webp bytea not null check(octet_length(webp) between 1 and 393216),
  primary key(report_id,position)
);
alter table public.feedback_report_receipts enable row level security;
alter table public.feedback_report_images enable row level security;
revoke all on public.feedback_report_receipts,public.feedback_report_images from public,anon,authenticated;
grant select,insert on public.feedback_report_receipts,public.feedback_report_images to service_role;
grant select,insert on public.user_feedback to service_role;

create or replace function public.submit_feedback_report(
  p_submission uuid,p_digest text,p_quota_key text,p_owner uuid,p_kind text,p_comment text,p_category text,
  p_sentiment text,p_surface text,p_images jsonb,p_storage_limit bigint default 1073741824
) returns uuid language plpgsql security invoker set search_path='' as $$
declare
  report uuid;
  existing record;
  img text;
  total integer:=0;
  img_bytes bytea;
  images bytea[]:='{}';
  daily_limit integer:=case when p_owner is null then 10485760 else 41943040 end;
begin
  if p_submission is null or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_quota_key is null or p_quota_key !~ '^[0-9a-f]{64}$'
    or p_kind is null or p_kind not in ('bug','feedback') or p_comment is null or length(p_comment)>4000
    or (p_kind='bug' and trim(p_comment)='') or coalesce(length(p_category),0)>80
    or (p_sentiment is not null and p_sentiment not in ('positive','neutral','negative','frustrated'))
    or coalesce(length(p_surface),0)>80 or p_images is null or jsonb_typeof(p_images)<>'array' then
    raise exception 'Invalid report' using errcode='22023';
  end if;
  if jsonb_array_length(p_images)>10 or (trim(p_comment)='' and p_sentiment is null and p_category is null and jsonb_array_length(p_images)=0) then
    raise exception 'Invalid report' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('feedback-request:'||p_submission::text,0));
  select r.report_id,r.payload_hash,f.user_id into existing from public.feedback_report_receipts r
    join public.user_feedback f on f.id=r.report_id where r.submission_id=p_submission;
  if found then
    if existing.payload_hash<>p_digest or existing.user_id is distinct from p_owner then
      raise exception 'Report changed during retry' using errcode='P0002';
    end if;
    return existing.report_id;
  end if;
  for img in select jsonb_array_elements_text(p_images) loop
    if length(img)>524288 then raise exception 'Attachment too large' using errcode='22023'; end if;
    img_bytes:=decode(img,'base64');
    if octet_length(img_bytes) not between 12 and 393216 or substring(img_bytes from 1 for 4)<>decode('52494646','hex')
      or substring(img_bytes from 9 for 4)<>decode('57454250','hex') then
      raise exception 'Invalid image' using errcode='22023';
    end if;
    total:=total+octet_length(img_bytes);
    images:=array_append(images,img_bytes);
  end loop;
  if total>0 then
    -- One lock makes the day and retained-capacity checks exact across concurrent API instances.
    perform pg_advisory_xact_lock(hashtextextended('feedback-image-capacity',0));
    if p_storage_limit is null or p_storage_limit<total or
      (select coalesce(sum(image_bytes),0) from public.feedback_report_receipts where image_bytes>0)+total>p_storage_limit
      or (select coalesce(sum(image_bytes),0) from public.feedback_report_receipts where quota_key=p_quota_key
        and image_bytes>0 and created_at>now()-interval '24 hours')+total>daily_limit then
      raise exception 'Attachment quota reached' using errcode='P0003';
    end if;
  end if;
  insert into public.user_feedback(user_id,target_type,source,surface,category,sentiment,comment,metadata)
    values(p_owner,p_kind,'client',p_surface,p_category,p_sentiment,nullif(trim(p_comment),''),
      jsonb_build_object('reportKind',p_kind,'attachmentCount',cardinality(images))) returning id into report;
  insert into public.feedback_report_receipts(report_id,submission_id,payload_hash,quota_key,image_bytes)
    values(report,p_submission,p_digest,p_quota_key,total);
  insert into public.feedback_report_images(report_id,position,webp)
    select report,n::smallint,b from unnest(images) with ordinality a(b,n);
  return report;
end $$;
revoke all on function public.submit_feedback_report(uuid,text,text,uuid,text,text,text,text,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.submit_feedback_report(uuid,text,text,uuid,text,text,text,text,text,jsonb,bigint) to service_role;
commit;
