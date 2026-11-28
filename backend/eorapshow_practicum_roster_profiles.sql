-- 차수별 명단의 기본정보는 실습생 등록 테이블에 두고 기존 기관별 관리 범위를 적용한다.
alter table private.practicum_members
  add column birth_date date,
  add column gender text check (gender in ('male','female','other')),
  add column mobile text check (mobile ~ '^\+?[0-9]{7,15}$');

create function private.practicum_normalize_roster_profile(p_profile jsonb)
returns table(trainee_name text, recipient text, birth_date date, gender text, mobile text)
language plpgsql stable set search_path = '' as $$
declare
  birthday text:=nullif(trim(p_profile->>'birth_date'),'');
begin
  if jsonb_typeof(p_profile) is distinct from 'object'
    then raise exception '실습생 기본정보를 확인해 주세요.'; end if;
  trainee_name:=trim(coalesce(p_profile->>'name',''));
  recipient:=lower(trim(coalesce(p_profile->>'email','')));
  if char_length(trainee_name) not between 1 and 80 or length(recipient)>254
    or recipient !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or split_part(recipient,'@',2)='bwyf.or.kr'
  then raise exception '성명과 실습생의 개인·학교 이메일을 확인해 주세요.'; end if;

  if birthday is not null then
    if birthday !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      then raise exception '생년월일은 연-월-일 형식으로 입력해 주세요.'; end if;
    begin
      birth_date:=birthday::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception '생년월일을 확인해 주세요.';
    end;
    if birth_date>timezone('Asia/Seoul',now())::date
      then raise exception '생년월일은 오늘 이후로 입력할 수 없습니다.'; end if;
  end if;

  gender:=nullif(trim(p_profile->>'gender'),'');
  if gender is not null and gender not in ('male','female','other')
    then raise exception '성별 입력값을 확인해 주세요.'; end if;
  mobile:=nullif(regexp_replace(coalesce(p_profile->>'mobile',''),'[[:space:]().-]','','g'),'');
  if mobile ~ '^1[016789][0-9]{7,8}$' then mobile:='0'||mobile; end if;
  if mobile is not null and mobile !~ '^\+?[0-9]{7,15}$'
    then raise exception '휴대전화 연락처를 확인해 주세요.'; end if;
  return next;
end;
$$;
revoke execute on function private.practicum_normalize_roster_profile(jsonb) from public,anon,authenticated;

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
  if not private.practicum_valid_reviewer(cohort.institution_id,p_reviewer)
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

create function private.practicum_roster_profile(p_cohort uuid,p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'person_id',p.id,'name',p.name,'email',m.email,'birth_date',m.birth_date,'gender',m.gender,'mobile',m.mobile,
    'has_member',m.person_id is not null,
    'email_locked',m.user_id is not null or m.ticket_hash is not null or m.revoked_at is not null
  ) into result
  from public.people p
  join public.cohorts c on c.id=p.cohort_id and c.institution_id=p.institution_id
  left join private.practicum_members m on m.person_id=p.id and m.cohort_id=c.id
  where c.id=p_cohort and p.id=p_person and p.role='trainee' and p.status<>'withdrawn'
    and private.practicum_manager(c.institution_id);
  if not found then raise exception '이 차수 실습생의 기본정보를 조회할 권한이 없습니다.' using errcode='42501'; end if;
  return result;
end;
$$;

create function private.practicum_update_roster_profile(p_cohort uuid,p_person uuid,p_reviewer uuid,p_profile jsonb)
returns void language plpgsql security definer set search_path = '' as $$
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
    if not private.practicum_valid_reviewer(org,p_reviewer)
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
$$;

create function public.practicum_roster_profile(p_cohort uuid,p_person uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.practicum_roster_profile(p_cohort,p_person);
$$;

create function public.practicum_update_roster_profile(p_cohort uuid,p_person uuid,p_reviewer uuid,p_profile jsonb)
returns void language sql security invoker set search_path = '' as $$
  select private.practicum_update_roster_profile(p_cohort,p_person,p_reviewer,p_profile);
$$;

revoke execute on function private.practicum_roster_profile(uuid,uuid),public.practicum_roster_profile(uuid,uuid),
  private.practicum_update_roster_profile(uuid,uuid,uuid,jsonb),public.practicum_update_roster_profile(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function private.practicum_roster_profile(uuid,uuid),public.practicum_roster_profile(uuid,uuid),
  private.practicum_update_roster_profile(uuid,uuid,uuid,jsonb),public.practicum_update_roster_profile(uuid,uuid,uuid,jsonb)
  to authenticated;

notify pgrst,'reload schema';

