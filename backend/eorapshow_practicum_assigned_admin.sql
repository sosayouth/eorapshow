-- 상위 관리자는 자신을 특정 실습생의 지도자로 직접 배정한 경우에만 제출본을 검토할 수 있다.

create or replace function private.practicum_reviewer(p_person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.practicum_members m
    join public.cohorts c on c.id = m.cohort_id
    join public.people p on p.id=m.person_id and p.cohort_id=c.id and p.institution_id=c.institution_id
      and p.role='trainee' and p.status<>'withdrawn'
    join public.staff_profiles s on s.user_id = m.reviewer_id
    where m.person_id = p_person and m.reviewer_id = (select auth.uid())
      and m.revoked_at is null and s.status = 'active'
      and (s.role in ('super_admin','foundation_admin')
        or (s.institution_id=c.institution_id and s.role in ('instructor','institution_admin')))
  )
$$;

create or replace function private.practicum_issue_invite(p_person uuid, p_email text, p_reviewer uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
    for update of p;
  if not found then raise exception '초대할 수 있는 실습생이 없습니다.' using errcode='42501'; end if;
  if length(recipient)>254 or recipient !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or split_part(recipient,'@',2)='bwyf.or.kr'
  then raise exception '실습생의 개인 또는 학교 이메일을 확인해 주세요.'; end if;
  if not exists(select 1 from public.staff_profiles where user_id=p_reviewer and status='active'
    and ((institution_id=learner.institution_id and role in ('institution_admin','instructor'))
      or (user_id=(select auth.uid()) and role in ('super_admin','foundation_admin'))))
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
$$;

create or replace function private.practicum_board(p_cohort uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
        then 'active' when m.email is not null then 'invited' else 'unlinked' end)
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
    'items',private.practicum_items(p_cohort,null));
end;
$$;

notify pgrst,'reload schema';

