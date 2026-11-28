-- 실습지도자는 등록 뒤 지정할 수 있고, 휴대전화 로그인은 같은 이메일 계정에 연결한다.

alter table private.practicum_members alter column reviewer_id drop not null;

CREATE OR REPLACE FUNCTION private.practicum_register_roster(p_cohort uuid, p_reviewer uuid, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cohort public.cohorts%rowtype;
  entry jsonb;
  person uuid;
  contact record;
  added integer:=0;
  existing integer:=0;
begin
  select * into cohort from public.cohorts
    where id=p_cohort and private.practicum_manager(institution_id) for update;
  if not found then raise exception '명단을 등록할 권한이 없습니다.' using errcode='42501'; end if;
  if p_reviewer is not null and not private.practicum_valid_reviewer(cohort.institution_id,p_reviewer)
    then raise exception '이 차수의 실습지도자를 선택해 주세요.'; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array'
    then raise exception '이름과 이메일이 있는 명단을 입력해 주세요.'; end if;
  if octet_length(p_rows::text)>240000 then raise exception '등록할 명단이 많습니다. 엑셀 파일을 나누어 등록해 주세요.'; end if;
  if jsonb_array_length(p_rows)=0 then raise exception '등록할 실습생을 입력해 주세요.'; end if;

  for entry in select value from jsonb_array_elements(p_rows) loop
    select * into contact from private.practicum_normalize_roster_profile(entry);
    if exists(select 1 from private.practicum_members where cohort_id=p_cohort and email=contact.recipient) then
      existing:=existing+1;
      continue;
    end if;
    insert into public.people(institution_id,cohort_id,name,role,status,created_by)
    values(cohort.institution_id,p_cohort,contact.trainee_name,'trainee','planned',(select auth.uid()))
    returning id into person;
    insert into private.practicum_members(person_id,cohort_id,email,reviewer_id,birth_date,gender,mobile)
    values(person,p_cohort,contact.recipient,p_reviewer,contact.birth_date,contact.gender,contact.mobile);
    added:=added+1;
  end loop;
  if added>0 then
    perform private.practicum_log('create','practicum_roster',p_cohort::text,cohort.institution_id);
  end if;
  return jsonb_build_object('added',added,'existing',existing);
end;
$function$;

CREATE OR REPLACE FUNCTION private.practicum_update_roster_profile(p_cohort uuid, p_person uuid, p_reviewer uuid, p_profile jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org text;
  linked private.practicum_members%rowtype;
  contact record;
begin
  select institution_id into org from public.cohorts
    where id=p_cohort and private.practicum_manager(institution_id) for update;
  if not found then raise exception '이 차수 실습생의 기본정보를 변경할 권한이 없습니다.' using errcode='42501'; end if;
  perform 1 from public.people where id=p_person and cohort_id=p_cohort
    and institution_id=org and role='trainee' and status<>'withdrawn' for update;
  if not found then raise exception '이 차수의 실습생을 선택해 주세요.' using errcode='42501'; end if;

  select * into contact from private.practicum_normalize_roster_profile(p_profile);
  select * into linked from private.practicum_members where person_id=p_person for update;
  if linked.person_id is not null and (linked.cohort_id<>p_cohort or
    (linked.email<>contact.recipient and
      (linked.user_id is not null or linked.ticket_hash is not null or linked.revoked_at is not null))
  ) then raise exception '초대되었거나 연결된 실습생의 이메일을 확인해 주세요.'; end if;
  if exists(select 1 from private.practicum_members where cohort_id=p_cohort and email=contact.recipient and person_id<>p_person)
    then raise exception '이 차수에 이미 등록된 이메일입니다.'; end if;

  if linked.person_id is null then
    if p_reviewer is not null and not private.practicum_valid_reviewer(org,p_reviewer)
      then raise exception '이 차수의 실습지도자를 선택해 주세요.'; end if;
    insert into private.practicum_members(person_id,cohort_id,email,reviewer_id,birth_date,gender,mobile)
    values(p_person,p_cohort,contact.recipient,p_reviewer,contact.birth_date,contact.gender,contact.mobile);
  else
    update private.practicum_members set
      email=contact.recipient,birth_date=contact.birth_date,gender=contact.gender,mobile=contact.mobile
    where person_id=p_person;
  end if;
  update public.people set name=contact.trainee_name,updated_at=now() where id=p_person;
  perform private.practicum_log('update','practicum_roster_profile',p_person::text,org);
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
  if p_reviewer is not null and not private.practicum_valid_reviewer(learner.institution_id,p_reviewer)
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
  values(p_person,learner.cohort_id,recipient,coalesce(p_reviewer,linked.reviewer_id),linked_user,
    case when ticket is not null then extensions.digest(ticket,'sha256') end,
    case when ticket is not null then now()+interval '10 minutes' end,null)
  on conflict(person_id) do update set
    email=excluded.email, reviewer_id=excluded.reviewer_id, user_id=excluded.user_id,
    ticket_hash=excluded.ticket_hash, ticket_expires_at=excluded.ticket_expires_at, revoked_at=null;
  perform private.practicum_log('issue_invite','practicum_member',p_person::text,learner.institution_id);
  return jsonb_build_object('email',recipient,'existing',linked_user is not null,'ticket',ticket);
end;
$function$;

create function private.practicum_assign_reviewer(p_cohort uuid,p_person uuid,p_reviewer uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare org text;
begin
  select institution_id into org from public.cohorts
  where id=p_cohort and private.practicum_manager(institution_id) for update;
  if not found then raise exception '이 차수의 실습지도자를 지정할 권한이 없습니다.' using errcode='42501'; end if;
  if p_reviewer is not null and not private.practicum_valid_reviewer(org,p_reviewer)
    then raise exception '이 차수의 활성 실습지도자를 선택해 주세요.'; end if;

  update private.practicum_members m set reviewer_id=p_reviewer from public.people p
    where m.person_id=p_person and m.cohort_id=p_cohort
      and p.id=m.person_id and p.cohort_id=p_cohort and p.institution_id=org
      and p.role='trainee' and p.status<>'withdrawn';
  if not found then raise exception '이 차수의 등록된 실습생을 선택해 주세요.' using errcode='42501'; end if;
  perform private.practicum_log('update','practicum_reviewer',p_person::text,org);
end;
$$;

create function public.practicum_assign_reviewer(p_cohort uuid,p_person uuid,p_reviewer uuid)
returns void language sql security invoker set search_path = '' as $$
  select private.practicum_assign_reviewer(p_cohort,p_person,p_reviewer);
$$;
revoke execute on function private.practicum_assign_reviewer(uuid,uuid,uuid),public.practicum_assign_reviewer(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function private.practicum_assign_reviewer(uuid,uuid,uuid),public.practicum_assign_reviewer(uuid,uuid,uuid)
  to authenticated;

create function private.practicum_phone_key(p_mobile text)
returns text language plpgsql immutable strict set search_path = '' as $$
declare phone text:=regexp_replace(p_mobile,'[[:space:]().-]','','g');
begin
  if phone ~ '^01[016789][0-9]{7,8}$' then return '+82'||substr(phone,2); end if;
  if phone ~ '^1[016789][0-9]{7,8}$' then return '+82'||phone; end if;
  if phone ~ '^(\+82|0082|82)0?1[016789][0-9]{7,8}$'
    then return '+82'||regexp_replace(phone,'^(\+82|0082|82)0?',''); end if;
  if phone ~ '^\+?[0-9]{7,15}$' then return phone; end if;
  return null;
end;
$$;
revoke execute on function private.practicum_phone_key(text) from public,anon,authenticated;

create index practicum_members_phone_key_idx
  on private.practicum_members (private.practicum_phone_key(mobile))
  where mobile is not null and user_id is not null and revoked_at is null;

create table private.practicum_phone_login_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  attempts integer not null check (attempts between 1 and 10)
);
alter table private.practicum_phone_login_attempts enable row level security;
revoke all on table private.practicum_phone_login_attempts from public,anon,authenticated;

-- The Edge Function uses this service-only RPC. Browser roles cannot resolve a phone to an email.
create function public.practicum_phone_login_target(p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  phone_key text;
  account record;
  current_time_point timestamptz:=now();
  window_cutoff timestamptz:=current_time_point-interval '5 minutes';
begin
  if p_phone is null or length(p_phone)>40 then return null; end if;
  phone_key:=private.practicum_phone_key(p_phone);
  if phone_key is null then return null; end if;

  with matching as (
    select distinct u.id,u.email
    from private.practicum_members m
    join public.people p on p.id=m.person_id and p.cohort_id=m.cohort_id
    join public.cohorts c on c.id=m.cohort_id and c.institution_id=p.institution_id
    join auth.users u on u.id=m.user_id and lower(u.email)=m.email
    where m.mobile is not null and m.user_id is not null and m.revoked_at is null
      and private.practicum_phone_key(m.mobile)=phone_key
      and u.email_confirmed_at is not null and u.deleted_at is null
      and p.role='trainee' and p.status<>'withdrawn'
      and not exists(select 1 from public.staff_profiles s where s.user_id=u.id)
  ) select id,email,count(*) over () as matches into account from matching limit 1;
  if not found or account.matches<>1 then return null; end if;

  insert into private.practicum_phone_login_attempts as a(user_id,window_start,attempts)
  values(account.id,current_time_point,1)
  on conflict(user_id) do update set
    window_start=case when a.window_start<=window_cutoff then current_time_point else a.window_start end,
    attempts=case when a.window_start<=window_cutoff then 1 else a.attempts+1 end
  where a.window_start<=window_cutoff or a.attempts<10;
  if not found then return null; end if;
  return jsonb_build_object('user_id',account.id,'email',account.email);
end;
$$;
revoke execute on function public.practicum_phone_login_target(text) from public,anon,authenticated;
grant execute on function public.practicum_phone_login_target(text) to service_role;

notify pgrst,'reload schema';

