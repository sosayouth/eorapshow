-- 차수 준비, 실습시간 기록 및 제출본 모아 인쇄

alter table public.cohorts add column target_hours integer not null default 130 check (target_hours>0);

create function private.practicum_diary_minutes(p_body jsonb)
returns integer language plpgsql immutable set search_path = '' as $$
declare
  starts text:=coalesce(p_body->>'start_time','');
  ends text:=coalesce(p_body->>'end_time','');
  pauses text:=coalesce(nullif(p_body->>'break_minutes',''),'0');
  duration integer;
begin
  if starts !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or ends !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or pauses !~ '^[0-9]{1,4}$' then return null; end if;
  duration:=extract(epoch from (ends::time-starts::time))::integer/60;
  if duration<=0 or pauses::integer>duration then return null; end if;
  return duration-pauses::integer;
end;
$$;
revoke execute on function private.practicum_diary_minutes(jsonb) from public,anon,authenticated;

create function private.practicum_valid_reviewer(p_institution text,p_reviewer uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists(select 1 from public.staff_profiles
    where user_id=p_reviewer and status='active'
      and ((institution_id=p_institution and role in ('institution_admin','instructor'))
        or (user_id=(select auth.uid()) and role in ('super_admin','foundation_admin'))));
$$;
revoke execute on function private.practicum_valid_reviewer(text,uuid) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION private.practicum_save(p_work uuid, p_revision integer, p_body jsonb, p_file_key text, p_file_name text, p_submit boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare w private.practicum_work%rowtype; details record;
begin
  select * into w from private.practicum_work
    where id=p_work and private.practicum_owner(person_id,true) for update;
  if not found then raise exception '본인 실습 기록만 저장할 수 있습니다.' using errcode='42501'; end if;
  if w.status not in ('draft','changes') or p_revision is distinct from w.revision then
    raise exception '다른 화면에서 이 기록이 변경됐습니다. 입력 내용을 복사한 뒤 새로고침해 주세요.' using errcode='40001';
  end if;
  select * into details from private.practicum_context(p_work);
  if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>240000 then
    raise exception '본문 입력량을 줄여 주세요.'; end if;
  if exists (select 1 from jsonb_each(p_body) f
    where jsonb_typeof(f.value)<>'string' or length(f.value #>> '{}')>24000
    or (not exists (select 1 from jsonb_array_elements(details.fields) t where t->>'key'=f.key)
       and not (details.day is not null and f.key in ('start_time','end_time','break_minutes'))))
  then raise exception '양식의 입력 항목과 길이를 확인해 주세요.'; end if;
  if details.day is not null then
    -- An older open editor omits time keys. Retain them unless the caller sends new values.
    p_body:=(select coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb)
      from jsonb_each(w.draft) f where f.key in ('start_time','end_time','break_minutes')) || p_body;
    if p_submit and (coalesce(p_body->>'start_time','')<>'' or coalesce(p_body->>'end_time','')<>''
      or coalesce(p_body->>'break_minutes','') not in ('','0'))
      and private.practicum_diary_minutes(p_body) is null
    then raise exception '시작·종료 시각과 휴게시간을 확인해 주세요.'; end if;
  end if;
  if p_file_key is not null then
    if details.day is not null or not private.practicum_file_path(w.person_id,w.id,p_file_key)
      or p_file_name is null or length(trim(p_file_name)) not between 1 and 180
      or not exists(select 1 from storage.objects o where o.bucket_id='practicum-submissions' and o.name=p_file_key)
    then raise exception '보고서 PDF 첨부를 확인해 주세요.'; end if;
  else p_file_name:=null;
  end if;
  if p_submit and p_file_key is null and exists(select 1 from jsonb_array_elements(details.fields) t
    where (t->>'required')::boolean and coalesce(p_body->>(t->>'key'),'') !~ '[^[:space:]]')
  then raise exception '필수 항목을 작성한 뒤 제출해 주세요.'; end if;

  if p_submit then
    w.submitted_version:=w.submitted_version+1;
    insert into private.practicum_versions(work_id,version,body,attachment_key,attachment_name,due_at)
      values(p_work,w.submitted_version,p_body,p_file_key,p_file_name,details.due_at);
    perform private.practicum_log('submit','practicum_work',p_work::text,details.institution_id);
  end if;
  update private.practicum_work set draft=p_body,attachment_key=p_file_key,attachment_name=p_file_name,
    revision=w.revision+1,updated_at=now(),submitted_version=w.submitted_version,
    status=case when p_submit then 'submitted' else w.status end where id=p_work;
  return jsonb_build_object('revision',w.revision+1,'version',w.submitted_version,
    'status',case when p_submit then 'submitted' else w.status end,'saved_at',now());
end;
$function$;

CREATE OR REPLACE FUNCTION private.practicum_item(p_work uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare w private.practicum_work%rowtype; owner boolean; details jsonb; versions jsonb;
begin
  select * into w from private.practicum_work where id=p_work;
  owner:=private.practicum_owner(w.person_id,false);
  if w.id is null or (not owner and (w.submitted_version=0 or not private.practicum_reviewer(w.person_id)))
  then raise exception '열람할 수 있는 제출물이 없습니다.' using errcode='42501'; end if;
  select to_jsonb(c) into details from private.practicum_context(p_work) c;
  select coalesce(jsonb_agg(jsonb_build_object('number',v.version,'body',v.body,
    'attachment_key',v.attachment_key,'attachment_name',v.attachment_name,
    'submitted_at',v.submitted_at,'due_at',v.due_at,'late',v.submitted_at>v.due_at,

    'minutes',case when w.practice_date is not null then private.practicum_diary_minutes(v.body) end,
    'feedback',r.feedback,'outcome',r.outcome,'reviewed_at',r.reviewed_at) order by v.version desc),'[]'::jsonb)
  into versions from private.practicum_versions v left join private.practicum_reviews r
    on r.work_id=v.work_id and r.version=v.version where v.work_id=p_work;

  return details || jsonb_build_object('id',w.id,'status',w.status,'version',w.submitted_version,
    'can_write',owner and w.status in ('draft','changes') and private.practicum_owner(w.person_id,true),
    'can_review',not owner and w.status='submitted', 'versions',versions)
    || case when owner then jsonb_build_object('draft',w.draft,'revision',w.revision,
      'attachment_key',w.attachment_key,'attachment_name',w.attachment_name) else '{}'::jsonb end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.practicum_items(p_cohort uuid, p_learner uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with learners as (
    select p.id, p.name from public.people p join public.cohorts c
      on c.id=p.cohort_id and c.institution_id=p.institution_id
    where c.id=p_cohort and p.role='trainee' and p.status<>'withdrawn'
      and ((p_learner is not null and p.id=p_learner and private.practicum_owner(p.id,false))
        or (p_learner is null and
          (private.practicum_manager(c.institution_id) or private.practicum_reviewer(p.id))))
  ), tasks as (
    select l.id as person_id, l.name as person_name, d.practice_date as day, null::uuid as assignment_id,
      'diary' as template, d.due_at, '' as instructions, false as individual
    from learners l join private.practicum_days d on d.cohort_id=p_cohort and not d.cancelled
    union all
    select l.id, l.name, null::date, a.id, a.template_code, a.due_at, a.instructions, a.person_id is not null
    from learners l join private.practicum_assignments a
      on a.cohort_id=p_cohort and (a.person_id is null or a.person_id=l.id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'person_id',t.person_id, 'person_name',t.person_name, 'day',t.day, 'assignment_id',t.assignment_id,
    'template',t.template, 'title',f.title, 'due_at',t.due_at, 'instructions',t.instructions, 'individual',t.individual,
    'work_id',w.id, 'status',coalesce(w.status,'missing'), 'version',coalesce(w.submitted_version,0),

    'submitted_at',v.submitted_at, 'late',v.submitted_at>v.due_at,
    'minutes',case when t.day is not null and v.version is not null then private.practicum_diary_minutes(v.body) end,
    'can_review',case when p_learner is null and w.submitted_version>0 then private.practicum_reviewer(t.person_id) else false end
  ) order by t.due_at,t.person_name,t.template,t.individual),'[]'::jsonb)
  from tasks t join private.practicum_templates f on f.code=t.template
  left join private.practicum_work w on w.person_id=t.person_id and
    (w.practice_date=t.day or w.assignment_id=t.assignment_id)
  left join private.practicum_versions v on v.work_id=w.id and v.version=w.submitted_version
$function$;

CREATE OR REPLACE FUNCTION private.practicum_student(p_person uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare cohort_id uuid; target_hours bigint;
begin
  select m.cohort_id,c.target_hours into cohort_id,target_hours from private.practicum_members m
    join public.cohorts c on c.id=m.cohort_id
    where m.person_id=p_person and private.practicum_owner(p_person,false);
  if not found then raise exception '본인 실습 차수에만 접근할 수 있습니다.' using errcode='42501'; end if;
  return jsonb_build_object('items',private.practicum_items(cohort_id,p_person),
    'can_write',private.practicum_owner(p_person,true), 'target_minutes',target_hours*60,
    'today',timezone('Asia/Seoul',now())::date);
end;
$function$;

CREATE OR REPLACE FUNCTION private.practicum_issue_invite(p_person uuid, p_email text, p_reviewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  learner public.people%rowtype;
  linked private.practicum_members%rowtype;
  recipient text := lower(trim(coalesce(p_email, '')));
  linked_user uuid;
  ticket text;
begin
  select p.* into learner from public.people p join public.cohorts c
    on c.id=p.cohort_id and c.institution_id=p.institution_id
    where p.id=p_person and p.role='trainee' and p.status in ('planned','in_progress')
      and private.practicum_manager(c.institution_id)
    for update of c,p;
  if not found then raise exception '초대할 수 있는 실습생이 없습니다.' using errcode='42501'; end if;
  if length(recipient)>254 or recipient !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or split_part(recipient,'@',2)='bwyf.or.kr'
  then raise exception '실습생의 개인 또는 학교 이메일을 확인해 주세요.'; end if;
  if not private.practicum_valid_reviewer(learner.institution_id,p_reviewer)
  then raise exception '해당 기관의 활성 지도자 또는 본인 관리자 계정을 선택해 주세요.'; end if;

  select * into linked from private.practicum_members where person_id=p_person for update;
  if found and (linked.cohort_id <> learner.cohort_id or (linked.user_id is not null and linked.email <> recipient)) then
    raise exception '이미 연결된 계정 또는 차수가 다릅니다. 기존 이력을 확인해 주세요.';
  end if;

  select u.id into linked_user from auth.users u where lower(u.email)=recipient and u.deleted_at is null;
  if linked_user is not null and (
    exists(select 1 from public.staff_profiles where user_id=linked_user)
    or not exists(select 1 from private.practicum_members where user_id=linked_user and email=recipient)
  ) then raise exception '이 주소의 기존 계정을 확인해야 합니다.'; end if;

  if linked_user is null then ticket := encode(extensions.gen_random_bytes(32),'hex'); end if;
  insert into private.practicum_members(person_id,cohort_id,email,reviewer_id,user_id,ticket_hash,ticket_expires_at,revoked_at)
  values(p_person,learner.cohort_id,recipient,p_reviewer,linked_user,
    case when ticket is not null then extensions.digest(ticket,'sha256') end,
    case when ticket is not null then now()+interval '10 minutes' end,null)
  on conflict(person_id) do update set
    email=excluded.email, reviewer_id=excluded.reviewer_id, user_id=excluded.user_id,
    ticket_hash=excluded.ticket_hash, ticket_expires_at=excluded.ticket_expires_at, revoked_at=null;
  perform private.practicum_log('issue_invite','practicum_member',p_person::text,learner.institution_id);
  return jsonb_build_object('email',recipient,'existing',linked_user is not null,'ticket',ticket);
end;
$function$;

CREATE OR REPLACE FUNCTION private.practicum_board(p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare org text; manager boolean;
begin
  select institution_id into org from public.cohorts where id=p_cohort;
  manager:=private.practicum_manager(org);
  if org is null or (not manager and not exists(
    select 1 from private.practicum_members m where m.cohort_id=p_cohort and private.practicum_reviewer(m.person_id)
  )) then raise exception '이 차수에서 조회할 수 있는 배정 내역이 없습니다.' using errcode='42501'; end if;

  return jsonb_build_object(
    'can_manage',manager,
    'today',timezone('Asia/Seoul',now())::date,
    'roster',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'practice_status',p.status,
      'email',case when manager then m.email end,'reviewer_id',m.reviewer_id,
      'reviewer_name',nullif(s.display_name,''),
      'account',case when m.revoked_at is not null then 'revoked' when u.email_confirmed_at is not null and lower(u.email)=m.email
        then 'active' when m.ticket_hash is not null or m.user_id is not null then 'invited'
        when m.email is not null then 'registered' else 'unlinked' end)
      order by p.name),'[]'::jsonb)
      from public.people p left join private.practicum_members m on m.person_id=p.id and m.cohort_id=p_cohort
      left join public.staff_profiles s on s.user_id=m.reviewer_id left join auth.users u on u.id=m.user_id
      where p.cohort_id=p_cohort and p.institution_id=org and p.role='trainee' and p.status<>'withdrawn'
        and (manager or private.practicum_reviewer(p.id))),
    'reviewers',case when manager then (select coalesce(jsonb_agg(jsonb_build_object(
      'id',s.user_id,'label',coalesce(nullif(s.display_name,''),s.email)) order by coalesce(nullif(s.display_name,''),s.email)),'[]'::jsonb)
      from public.staff_profiles s where s.status='active' and
        ((s.institution_id=org and s.role in ('institution_admin','instructor'))
          or (s.user_id=(select auth.uid()) and s.role in ('super_admin','foundation_admin'))))
      else '[]'::jsonb end,
    'templates',case when manager then (select jsonb_agg(jsonb_build_object('code',f.code,'title',f.title) order by
      array_position(array['institution','community','policy','plan','midterm','final'],f.code))
      from private.practicum_templates f where f.code<>'diary') else '[]'::jsonb end,
    'days',case when manager then (select coalesce(jsonb_agg(jsonb_build_object(
      'day',d.practice_date,'due_at',d.due_at,'cancelled',d.cancelled) order by d.practice_date),'[]'::jsonb)
      from private.practicum_days d where d.cohort_id=p_cohort) else '[]'::jsonb end,
    'diary_deadline',case when manager then coalesce(
      (select jsonb_build_object('delay_days',d.delay_days,'cutoff',d.cutoff)
       from private.practicum_diary_deadlines d where d.cohort_id=p_cohort),
      jsonb_build_object('delay_days',7,'cutoff',time '18:00')) end,
    'assignments',case when manager then (
      select coalesce(jsonb_agg(jsonb_build_object('assignment_id',a.id,'title',f.title,
        'due_at',a.due_at,'person_name',p.name,'individual',a.person_id is not null)
        order by a.due_at,f.title,p.name),'[]'::jsonb)
      from private.practicum_assignments a
      join private.practicum_templates f on f.code=a.template_code
      left join public.people p on p.id=a.person_id
      where a.cohort_id=p_cohort) else '[]'::jsonb end,
    'items',private.practicum_items(p_cohort,null));
end;
$function$;

create function private.practicum_register_roster(p_cohort uuid,p_reviewer uuid,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cohort public.cohorts%rowtype;
  entry jsonb;
  person uuid;
  trainee_name text;
  recipient text;
  added integer:=0;
  existing integer:=0;
begin
  select * into cohort from public.cohorts
    where id=p_cohort and private.practicum_manager(institution_id) for update;
  if not found then raise exception '명단을 등록할 권한이 없습니다.' using errcode='42501'; end if;
  if not private.practicum_valid_reviewer(cohort.institution_id,p_reviewer)
    then raise exception '이 차수의 실습지도자를 선택해 주세요.'; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or octet_length(p_rows::text)>240000
    then raise exception '이름과 이메일이 있는 명단을 입력해 주세요.'; end if;
  if jsonb_array_length(p_rows)=0 then raise exception '등록할 실습생을 입력해 주세요.'; end if;

  for entry in select value from jsonb_array_elements(p_rows) loop
    trainee_name:=trim(coalesce(entry->>'name',''));
    recipient:=lower(trim(coalesce(entry->>'email','')));
    if char_length(trainee_name) not between 1 and 80 or length(recipient)>254
      or recipient !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      or split_part(recipient,'@',2)='bwyf.or.kr'
    then raise exception '이름과 실습생 개인·학교 이메일을 확인해 주세요.'; end if;
    if exists(select 1 from private.practicum_members where cohort_id=p_cohort and email=recipient) then
      existing:=existing+1;
      continue;
    end if;
    insert into public.people(institution_id,cohort_id,name,role,status,created_by)
    values(cohort.institution_id,p_cohort,trainee_name,'trainee','planned',(select auth.uid()))
    returning id into person;
    insert into private.practicum_members(person_id,cohort_id,email,reviewer_id)
    values(person,p_cohort,recipient,p_reviewer);
    added:=added+1;
  end loop;
  if added>0 then
    perform private.practicum_log('create','practicum_roster',p_cohort::text,cohort.institution_id);
  end if;
  return jsonb_build_object('added',added,'existing',existing);
end;
$$;

create function public.practicum_register_roster(p_cohort uuid,p_reviewer uuid,p_rows jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.practicum_register_roster(p_cohort,p_reviewer,p_rows);
$$;
revoke execute on function private.practicum_register_roster(uuid,uuid,jsonb),
  public.practicum_register_roster(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.practicum_register_roster(uuid,uuid,jsonb),
  public.practicum_register_roster(uuid,uuid,jsonb) to authenticated;

create function private.practicum_print_bundle(p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare documents jsonb;
begin
  if not private.practicum_reviewer(p_person) then
    raise exception '배정된 실습생의 제출물만 모아 인쇄할 수 있습니다.' using errcode='42501';
  end if;
  with selected as materialized (
    select w.id,w.practice_date,private.practicum_item(w.id) as content
    from private.practicum_work w
    where w.person_id=p_person and w.submitted_version>0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'item',s.content-'versions'-'draft',
    'version',s.content#>'{versions,0}'
  ) order by s.practice_date nulls last, (s.content->>'due_at')::timestamptz, s.id),'[]'::jsonb)
  into documents from selected s;
  return documents;
end;
$$;

create function public.practicum_print_bundle(p_person uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.practicum_print_bundle(p_person);
$$;
revoke execute on function private.practicum_print_bundle(uuid),public.practicum_print_bundle(uuid)
  from public,anon,authenticated;
grant execute on function private.practicum_print_bundle(uuid),public.practicum_print_bundle(uuid) to authenticated;

notify pgrst,'reload schema';

