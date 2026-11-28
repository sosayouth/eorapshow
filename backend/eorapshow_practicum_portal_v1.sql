-- 어랍쇼 실습생 공간. 기존 차수와 명단을 재사용하고 실습 기록은 비공개로 저장한다.
create table private.practicum_templates (
  code text primary key,
  title text not null,
  fields jsonb not null check (jsonb_typeof(fields) = 'array')
);

insert into private.practicum_templates(code, title, fields) values
  ('diary', '실습일지 [서식 08]', $items$[{"key":"goal","label":"오늘의 학습목표","required":true},{"key":"activities","label":"시간대별 주요 활동과 내가 맡은 역할","required":true},{"key":"observation","label":"청소년·이용자 상호작용 또는 관찰","required":false},{"key":"learning","label":"배운 점과 새롭게 이해한 점","required":true},{"key":"questions","label":"어려웠던 점·질문","required":false},{"key":"ethics","label":"안전·윤리·개인정보 확인사항","required":false},{"key":"next","label":"다음 실습 실천계획","required":true}]$items$::jsonb),
  ('institution', '기관 운영분석 보고서', $items$[{"key":"overview","label":"기관의 설립목적·역할","required":true},{"key":"operations","label":"조직·주요 사업과 운영 분석","required":true},{"key":"proposal","label":"실습기관에 적용할 시사점·개선 제안","required":true},{"key":"sources","label":"자료 출처","required":false}]$items$::jsonb),
  ('community', '지역사회 조사·분석 보고서', $items$[{"key":"topic","label":"조사 주제·대상·방법","required":true},{"key":"findings","label":"지역 청소년 현황과 조사 결과","required":true},{"key":"resources","label":"지역 자원과 연계·개선 제안","required":true},{"key":"sources","label":"자료 출처","required":true}]$items$::jsonb),
  ('policy', '청소년정책 분석 보고서', $items$[{"key":"policy","label":"선정 정책의 목적·대상","required":true},{"key":"analysis","label":"정책 전달체계·내용 분석","required":true},{"key":"application","label":"청소년기관 현장 적용과 개선 제안","required":true},{"key":"sources","label":"자료 출처","required":true}]$items$::jsonb),
  ('plan', '자기평가계획서 [서식 09]', $items$[{"key":"goals","label":"개인 목표와 확인지표","required":true},{"key":"strengths","label":"현재 강점과 보완할 역량","required":true},{"key":"challenge","label":"도전할 과업과 필요한 지도·지원","required":true},{"key":"checkpoints","label":"점검 시점과 지도자 협의내용","required":false}]$items$::jsonb),
  ('midterm', '중간보고서 [서식 10]', $items$[{"key":"experience","label":"전반기 경험과 초기 목표 달성 정도","required":true},{"key":"growth","label":"성장한 역량과 근거","required":true},{"key":"challenges","label":"어려움·지원 필요사항","required":true},{"key":"adjustments","label":"후반기 목표·역할과 후속조치","required":true},{"key":"project","label":"프로그램·프로젝트 진행상태","required":false}]$items$::jsonb),
  ('final', '최종 실습보고서 [서식 11]', $items$[{"key":"overview","label":"실습개요와 교육·현장 경험","required":true},{"key":"projects","label":"프로그램·프로젝트 수행내용과 결과","required":true},{"key":"learning","label":"청소년 이해·관계와 행정·협업·안전·윤리에서 배운 점","required":true},{"key":"goals","label":"개인목표 달성결과와 근거","required":true},{"key":"growth","label":"의미 있었던 경험과 향후 역량개발 계획","required":true},{"key":"proposal","label":"기관·실습운영 개선 제안","required":false}]$items$::jsonb);

create table private.practicum_members (
  person_id uuid primary key references public.people(id),
  cohort_id uuid not null references public.cohorts(id),
  email text not null check (email = lower(trim(email)) and length(email) <= 254),
  user_id uuid references auth.users(id) on delete set null,
  reviewer_id uuid not null references public.staff_profiles(user_id),
  ticket_hash bytea,
  ticket_expires_at timestamptz,
  revoked_at timestamptz,
  unique (cohort_id, email)
);
create index practicum_members_user_idx on private.practicum_members(user_id);
create index practicum_members_reviewer_idx on private.practicum_members(reviewer_id, cohort_id);

create table private.practicum_days (
  cohort_id uuid not null references public.cohorts(id),
  practice_date date not null,
  due_at timestamptz not null,
  cancelled boolean not null default false,
  primary key (cohort_id, practice_date)
);

create table private.practicum_assignments (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references public.cohorts(id),
  template_code text not null references private.practicum_templates(code) check (template_code <> 'diary'),
  person_id uuid references public.people(id),
  due_at timestamptz not null,
  instructions text not null default '' check (length(instructions) <= 2000),
  unique nulls not distinct (cohort_id, template_code, person_id)
);
create index practicum_assignments_template_idx on private.practicum_assignments(template_code);
create index practicum_assignments_person_idx on private.practicum_assignments(person_id);

create table private.practicum_work (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references private.practicum_members(person_id),
  practice_date date,
  assignment_id uuid references private.practicum_assignments(id),
  status text not null default 'draft' check (status in ('draft','submitted','changes','reviewed')),
  draft jsonb not null default '{}' check (jsonb_typeof(draft) = 'object'),
  attachment_key text,
  attachment_name text,
  revision integer not null default 0,
  submitted_version integer not null default 0,
  updated_at timestamptz not null default now(),
  check (num_nonnulls(practice_date, assignment_id) = 1),
  unique (person_id, practice_date),
  unique (person_id, assignment_id)
);
create index practicum_work_assignment_idx on private.practicum_work(assignment_id);

create table private.practicum_versions (
  work_id uuid not null references private.practicum_work(id),
  version integer not null,
  body jsonb not null,
  attachment_key text,
  attachment_name text,
  submitted_at timestamptz not null default now(),
  due_at timestamptz not null,
  primary key (work_id, version)
);
create index practicum_versions_attachment_idx on private.practicum_versions(attachment_key);

create table private.practicum_reviews (
  work_id uuid not null,
  version integer not null,
  reviewer_id uuid not null references public.staff_profiles(user_id),
  outcome text not null check (outcome in ('changes','reviewed')),
  feedback text not null check (length(feedback) <= 4000),
  reviewed_at timestamptz not null default now(),
  primary key (work_id, version),
  foreign key (work_id, version) references private.practicum_versions(work_id, version)
);
create index practicum_reviews_reviewer_idx on private.practicum_reviews(reviewer_id);

alter table private.practicum_templates enable row level security;
alter table private.practicum_members enable row level security;
alter table private.practicum_days enable row level security;
alter table private.practicum_assignments enable row level security;
alter table private.practicum_work enable row level security;
alter table private.practicum_versions enable row level security;
alter table private.practicum_reviews enable row level security;

revoke all on table private.practicum_templates, private.practicum_members, private.practicum_days,
  private.practicum_assignments, private.practicum_work, private.practicum_versions, private.practicum_reviews
  from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('practicum-submissions', 'practicum-submissions', false, 10485760, array['application/pdf']);

create function private.practicum_manager(p_institution text)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and coalesce(
    private.current_role() in ('super_admin','foundation_admin') or
    (private.current_role() = 'institution_admin' and private.current_institution() = p_institution), false)
$$;

create function private.practicum_owner(p_person uuid, p_edit boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.practicum_members m
    join public.people p on p.id = m.person_id and p.cohort_id = m.cohort_id
    join public.cohorts c on c.id = m.cohort_id and c.institution_id = p.institution_id
    join auth.users u on u.id = m.user_id and lower(u.email) = m.email
    where m.person_id = p_person and m.user_id = (select auth.uid())
      and u.email_confirmed_at is not null and m.revoked_at is null
      and p.role = 'trainee' and p.status <> 'withdrawn' and (not p_edit or p.status <> 'completed')
  )
$$;

create function private.practicum_reviewer(p_person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.practicum_members m
    join public.cohorts c on c.id = m.cohort_id
    join public.people p on p.id=m.person_id and p.cohort_id=c.id and p.institution_id=c.institution_id
      and p.role='trainee' and p.status<>'withdrawn'
    join public.staff_profiles s on s.user_id = m.reviewer_id and s.institution_id = c.institution_id
    where m.person_id = p_person and m.reviewer_id = (select auth.uid())
      and m.revoked_at is null and s.status = 'active' and s.role in ('instructor','institution_admin')
  )
$$;

create function private.practicum_log(p_action text, p_entity text, p_id text, p_institution text)
returns void language sql security invoker set search_path = '' as $$
  insert into public.audit_logs(actor_user_id, action, entity_type, entity_id, institution_id)
  values ((select auth.uid()), p_action, p_entity, p_id, p_institution);
$$;

create unique index practicum_members_ticket_idx on private.practicum_members(ticket_hash)
where ticket_hash is not null;

create function private.practicum_issue_invite(p_person uuid, p_email text, p_reviewer uuid)
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
    and institution_id=learner.institution_id and role in ('institution_admin','instructor'))
  then raise exception '해당 기관에 배정된 활성 지도자를 선택해 주세요.'; end if;

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

create or replace function public.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ticket text := new.raw_user_meta_data->>'eorapshow_invitation';
begin
  if new.email is not null and lower(split_part(new.email,'@',2)) = 'bwyf.or.kr' then
    insert into public.staff_profiles(user_id,email,display_name)
    values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'full_name',''))
    on conflict (user_id) do nothing;
    return new;
  end if;
  if ticket is null or ticket !~ '^[a-f0-9]{64}$' then
    raise exception '실습생 등록은 기관 담당자가 발급한 초대 링크에서 가능합니다.';
  end if;
  update private.practicum_members m
  set user_id=new.id, ticket_hash=null, ticket_expires_at=null
  from public.people p, public.cohorts c
  where p.id=m.person_id and p.cohort_id=m.cohort_id and p.role='trainee'
    and p.status in ('planned','in_progress') and c.id=m.cohort_id and c.institution_id=p.institution_id
    and m.email=lower(new.email) and m.ticket_hash=extensions.digest(ticket,'sha256')
    and m.ticket_expires_at>now() and m.revoked_at is null and m.user_id is null;
  if not found then raise exception '유효한 실습생 초대가 없습니다.'; end if;
  return new;
end;
$$;

create function private.practicum_revoke(p_person uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare org text;
begin
  select c.institution_id into org from private.practicum_members m join public.cohorts c on c.id=m.cohort_id
    where m.person_id=p_person and private.practicum_manager(c.institution_id);
  if not found then raise exception '실습생 접근 중지 권한이 없습니다.' using errcode='42501'; end if;
  update private.practicum_members set revoked_at=now(),ticket_hash=null,ticket_expires_at=null where person_id=p_person;
  perform private.practicum_log('revoke_access','practicum_member',p_person::text,org);
end;
$$;

create function private.practicum_set_days(p_cohort uuid, p_dates date[], p_time time, p_cancel boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare cohort public.cohorts%rowtype;
begin
  select * into cohort from public.cohorts where id=p_cohort and private.practicum_manager(institution_id);
  if not found then raise exception '실습일 변경 권한이 없습니다.' using errcode='42501'; end if;
  if cardinality(p_dates) is null or cardinality(p_dates) not between 1 and 150 or p_time is null
     or exists(select 1 from unnest(p_dates) as day(d) where d is null or
       (cohort.start_date is not null and d < cohort.start_date) or
       (cohort.end_date is not null and d > cohort.end_date))
  then raise exception '차수 기간에 해당하는 실습일을 입력해 주세요.'; end if;
  perform 1 from private.practicum_days where cohort_id=p_cohort and practice_date=any(p_dates) for update;
  if p_cancel then
    if exists(select 1 from private.practicum_work w join private.practicum_members m on m.person_id=w.person_id
      where m.cohort_id=p_cohort and w.practice_date=any(p_dates))
    then raise exception '작성 이력이 있는 날짜는 취소할 수 없습니다.'; end if;
    update private.practicum_days set cancelled=true where cohort_id=p_cohort and practice_date=any(p_dates);
  else
    insert into private.practicum_days(cohort_id,practice_date,due_at)
    select p_cohort,d,(d+p_time) at time zone 'Asia/Seoul' from (select distinct unnest(p_dates) as d) days
    on conflict(cohort_id,practice_date) do update set due_at=excluded.due_at,cancelled=false;
  end if;
  perform private.practicum_log('update','practicum_days',p_cohort::text,cohort.institution_id);
end;
$$;

create function private.practicum_assign(p_cohort uuid,p_template text,p_person uuid,p_due timestamptz,p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare org text; result uuid;
begin
  select institution_id into org from public.cohorts where id=p_cohort and private.practicum_manager(institution_id);
  if not found then raise exception '보고서 배정 권한이 없습니다.' using errcode='42501'; end if;
  if p_template='diary' or not exists(select 1 from private.practicum_templates where code=p_template)
     or p_due is null or length(coalesce(p_note,''))>2000
     or (p_person is not null and not exists(select 1 from public.people where id=p_person and
           cohort_id=p_cohort and institution_id=org and role='trainee' and status<>'withdrawn'))
  then raise exception '보고서 양식, 실습생, 제출기한을 확인해 주세요.'; end if;
  insert into private.practicum_assignments(cohort_id,template_code,person_id,due_at,instructions)
  values(p_cohort,p_template,p_person,p_due,trim(coalesce(p_note,'')))
  on conflict(cohort_id,template_code,person_id) do update
    set due_at=excluded.due_at,instructions=excluded.instructions
  returning id into result;
  perform private.practicum_log('assign','practicum_report',result::text,org);
  return result;
end;
$$;

create function private.practicum_items(p_cohort uuid,p_learner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
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
    'can_review',case when p_learner is null and w.submitted_version>0 then private.practicum_reviewer(t.person_id) else false end
  ) order by t.due_at,t.person_name,t.template,t.individual),'[]'::jsonb)
  from tasks t join private.practicum_templates f on f.code=t.template
  left join private.practicum_work w on w.person_id=t.person_id and
    (w.practice_date=t.day or w.assignment_id=t.assignment_id)
  left join private.practicum_versions v on v.work_id=w.id and v.version=w.submitted_version
$$;

create function private.practicum_home()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'cohort',c.name,
    'institution',i.name,'start_date',c.start_date,'end_date',c.end_date)
    order by c.start_date desc nulls last,c.name),'[]'::jsonb)
  from private.practicum_members m join public.people p on p.id=m.person_id
  join public.cohorts c on c.id=m.cohort_id
  join public.institutions i on i.id=c.institution_id
  where m.user_id=(select auth.uid()) and private.practicum_owner(p.id,false)
$$;

create function private.practicum_student(p_person uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cohort_id uuid;
begin
  select m.cohort_id into cohort_id from private.practicum_members m
    where m.person_id=p_person and private.practicum_owner(p_person,false);
  if not found then raise exception '본인 실습 차수에만 접근할 수 있습니다.' using errcode='42501'; end if;
  return jsonb_build_object('items',private.practicum_items(cohort_id,p_person),
    'can_write',private.practicum_owner(p_person,true),
    'today',timezone('Asia/Seoul',now())::date);
end;
$$;

create function private.practicum_board(p_cohort uuid)
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
      from public.staff_profiles s where s.institution_id=org and s.status='active' and s.role in ('institution_admin','instructor'))
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

create function private.practicum_context(p_work uuid)
returns table(person_id uuid,person_name text,institution_id text,institution text,cohort text,
  day date,title text,fields jsonb,due_at timestamptz,instructions text)
language sql stable security invoker set search_path = '' as $$
  select p.id,p.name,c.institution_id,i.name,c.name,w.practice_date,f.title,f.fields,
    coalesce(d.due_at,a.due_at),coalesce(a.instructions,'')
  from private.practicum_work w join private.practicum_members m on m.person_id=w.person_id
  join public.people p on p.id=m.person_id
  join public.cohorts c on c.id=m.cohort_id
  join public.institutions i on i.id=c.institution_id
  left join private.practicum_days d on d.cohort_id=c.id and d.practice_date=w.practice_date
  left join private.practicum_assignments a on a.id=w.assignment_id
  join private.practicum_templates f on f.code=case when w.practice_date is not null then 'diary' else a.template_code end
  where w.id=p_work
$$;

create function private.practicum_item(p_work uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
    'feedback',r.feedback,'outcome',r.outcome,'reviewed_at',r.reviewed_at) order by v.version desc),'[]'::jsonb)
  into versions from private.practicum_versions v left join private.practicum_reviews r
    on r.work_id=v.work_id and r.version=v.version where v.work_id=p_work;

  return details || jsonb_build_object('id',w.id,'status',w.status,'version',w.submitted_version,
    'can_write',owner and w.status in ('draft','changes') and private.practicum_owner(w.person_id,true),
    'can_review',not owner and w.status='submitted', 'versions',versions)
    || case when owner then jsonb_build_object('draft',w.draft,'revision',w.revision,
      'attachment_key',w.attachment_key,'attachment_name',w.attachment_name) else '{}'::jsonb end;
end;
$$;

create function private.practicum_open(p_person uuid,p_day date,p_assignment uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cohort uuid; work_id uuid;
begin
  select m.cohort_id into cohort from private.practicum_members m
    where m.person_id=p_person and private.practicum_owner(p_person,true)
    for share of m;
  if not found then raise exception '본인 실습 기록만 작성할 수 있습니다.' using errcode='42501'; end if;
  if num_nonnulls(p_day,p_assignment)<>1 then raise exception '작성할 실습일 또는 보고서를 선택해 주세요.'; end if;
  if p_day is not null then
    perform 1 from private.practicum_days d where d.cohort_id=cohort and d.practice_date=p_day
      and not d.cancelled and d.practice_date<=timezone('Asia/Seoul',now())::date for share of d;
    if not found then raise exception '아직 작성할 수 있는 실습일이 아닙니다.'; end if;
  else
    perform 1 from private.practicum_assignments a where a.id=p_assignment and a.cohort_id=cohort
      and (a.person_id is null or a.person_id=p_person);
    if not found then raise exception '본인에게 배정된 보고서를 선택해 주세요.' using errcode='42501'; end if;
  end if;
  insert into private.practicum_work(person_id,practice_date,assignment_id) values(p_person,p_day,p_assignment)
    on conflict do nothing;
  select id into work_id from private.practicum_work w where w.person_id=p_person and
    (w.practice_date=p_day or w.assignment_id=p_assignment);
  return private.practicum_item(work_id);
end;
$$;

create function private.practicum_file_path(p_person uuid,p_work uuid,p_name text)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select coalesce(p_name ~ ('^'||p_person::text||'/'||p_work::text||
    '/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[.]pdf$'),false)
$$;

create function private.practicum_save(p_work uuid,p_revision integer,p_body jsonb,
  p_file_key text,p_file_name text,p_submit boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
    or not exists (select 1 from jsonb_array_elements(details.fields) t where t->>'key'=f.key))
  then raise exception '양식의 입력 항목과 길이를 확인해 주세요.'; end if;
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
$$;

create function private.practicum_review(p_work uuid,p_version integer,p_outcome text,p_feedback text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w private.practicum_work%rowtype; org text; feedback text:=trim(coalesce(p_feedback,''));
begin
  select * into w from private.practicum_work where id=p_work and private.practicum_reviewer(person_id) for update;
  if not found then raise exception '배정된 실습생의 제출물만 검토할 수 있습니다.' using errcode='42501'; end if;
  if w.status<>'submitted' or p_version is distinct from w.submitted_version
  then raise exception '제출 상태가 변경됐습니다. 다시 열어 확인해 주세요.' using errcode='40001'; end if;
  if p_outcome is null or p_outcome not in ('changes','reviewed') or length(feedback)>4000
    or (p_outcome='changes' and feedback !~ '[^[:space:]]')
  then raise exception '검토 결과와 보완 안내를 확인해 주세요.'; end if;
  insert into private.practicum_reviews(work_id,version,reviewer_id,outcome,feedback)
    values(p_work,p_version,(select auth.uid()),p_outcome,feedback);
  update private.practicum_work set status=p_outcome,revision=revision+1,updated_at=now() where id=p_work;
  select c.institution_id into org from private.practicum_context(p_work) c;
  perform private.practicum_log(p_outcome,'practicum_work',p_work::text,org);
  return private.practicum_item(p_work);
end;
$$;

create function private.practicum_storage_access(p_name text,p_action text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.practicum_work w where w.id::text=split_part(p_name,'/',2)
      and private.practicum_file_path(w.person_id,w.id,p_name) and w.assignment_id is not null
      and case p_action
        when 'upload' then w.status in ('draft','changes') and private.practicum_owner(w.person_id,true)
        when 'read' then
          (w.attachment_key=p_name and private.practicum_owner(w.person_id,false))
          or exists(select 1 from private.practicum_versions v where v.work_id=w.id and v.attachment_key=p_name
            and (private.practicum_owner(w.person_id,false) or private.practicum_reviewer(w.person_id)))
        else false end
  )
$$;

create policy practicum_upload on storage.objects for insert to authenticated
with check (bucket_id='practicum-submissions' and private.practicum_storage_access(name,'upload'));
create policy practicum_download on storage.objects for select to authenticated
using (bucket_id='practicum-submissions' and private.practicum_storage_access(name,'read'));

grant usage on schema private to authenticated;
revoke execute on function public.on_auth_user_created() from public, anon, authenticated;
revoke execute on function private.practicum_issue_invite(uuid,text,uuid) from public, anon, authenticated;
revoke execute on function private.practicum_revoke(uuid) from public, anon, authenticated;
revoke execute on function private.practicum_set_days(uuid,date[],time,boolean) from public, anon, authenticated;
revoke execute on function private.practicum_assign(uuid,text,uuid,timestamptz,text) from public, anon, authenticated;
revoke execute on function private.practicum_home() from public, anon, authenticated;
revoke execute on function private.practicum_student(uuid) from public, anon, authenticated;
revoke execute on function private.practicum_board(uuid) from public, anon, authenticated;
revoke execute on function private.practicum_item(uuid) from public, anon, authenticated;
revoke execute on function private.practicum_open(uuid,date,uuid) from public, anon, authenticated;
revoke execute on function private.practicum_save(uuid,integer,jsonb,text,text,boolean) from public, anon, authenticated;
revoke execute on function private.practicum_review(uuid,integer,text,text) from public, anon, authenticated;
revoke execute on function private.practicum_manager(text) from public, anon, authenticated;
revoke execute on function private.practicum_owner(uuid,boolean) from public, anon, authenticated;
revoke execute on function private.practicum_reviewer(uuid) from public, anon, authenticated;
revoke execute on function private.practicum_log(text,text,text,text) from public, anon, authenticated;
revoke execute on function private.practicum_items(uuid,uuid) from public, anon, authenticated;
revoke execute on function private.practicum_context(uuid) from public, anon, authenticated;
revoke execute on function private.practicum_file_path(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function private.practicum_storage_access(text,text) from public, anon, authenticated;
grant execute on function private.practicum_storage_access(text,text) to authenticated;
create function public.practicum_issue_invite(p_person uuid,p_email text,p_reviewer uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.practicum_issue_invite(p_person,p_email,p_reviewer)
$$;
revoke execute on function public.practicum_issue_invite(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.practicum_issue_invite(uuid,text,uuid), private.practicum_issue_invite(uuid,text,uuid) to authenticated;

create function public.practicum_revoke(p_person uuid) returns void
language sql security invoker set search_path = '' as $$
  select private.practicum_revoke(p_person)
$$;
revoke execute on function public.practicum_revoke(uuid) from public, anon, authenticated;
grant execute on function public.practicum_revoke(uuid), private.practicum_revoke(uuid) to authenticated;

create function public.practicum_set_days(p_cohort uuid,p_dates date[],p_time time,p_cancel boolean) returns void
language sql security invoker set search_path = '' as $$
  select private.practicum_set_days(p_cohort,p_dates,p_time,p_cancel)
$$;
revoke execute on function public.practicum_set_days(uuid,date[],time,boolean) from public, anon, authenticated;
grant execute on function public.practicum_set_days(uuid,date[],time,boolean), private.practicum_set_days(uuid,date[],time,boolean) to authenticated;

create function public.practicum_assign(p_cohort uuid,p_template text,p_person uuid,p_due timestamptz,p_note text) returns uuid
language sql security invoker set search_path = '' as $$
  select private.practicum_assign(p_cohort,p_template,p_person,p_due,p_note)
$$;
revoke execute on function public.practicum_assign(uuid,text,uuid,timestamptz,text) from public, anon, authenticated;
grant execute on function public.practicum_assign(uuid,text,uuid,timestamptz,text), private.practicum_assign(uuid,text,uuid,timestamptz,text) to authenticated;

create function public.practicum_home() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.practicum_home()
$$;
revoke execute on function public.practicum_home() from public, anon, authenticated;
grant execute on function public.practicum_home(), private.practicum_home() to authenticated;

create function public.practicum_student(p_person uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.practicum_student(p_person)
$$;
revoke execute on function public.practicum_student(uuid) from public, anon, authenticated;
grant execute on function public.practicum_student(uuid), private.practicum_student(uuid) to authenticated;

create function public.practicum_board(p_cohort uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.practicum_board(p_cohort)
$$;
revoke execute on function public.practicum_board(uuid) from public, anon, authenticated;
grant execute on function public.practicum_board(uuid), private.practicum_board(uuid) to authenticated;

create function public.practicum_item(p_work uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.practicum_item(p_work)
$$;
revoke execute on function public.practicum_item(uuid) from public, anon, authenticated;
grant execute on function public.practicum_item(uuid), private.practicum_item(uuid) to authenticated;

create function public.practicum_open(p_person uuid,p_day date,p_assignment uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.practicum_open(p_person,p_day,p_assignment)
$$;
revoke execute on function public.practicum_open(uuid,date,uuid) from public, anon, authenticated;
grant execute on function public.practicum_open(uuid,date,uuid), private.practicum_open(uuid,date,uuid) to authenticated;

create function public.practicum_save(p_work uuid,p_revision integer,p_body jsonb,p_file_key text,p_file_name text,p_submit boolean) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.practicum_save(p_work,p_revision,p_body,p_file_key,p_file_name,p_submit)
$$;
revoke execute on function public.practicum_save(uuid,integer,jsonb,text,text,boolean) from public, anon, authenticated;
grant execute on function public.practicum_save(uuid,integer,jsonb,text,text,boolean), private.practicum_save(uuid,integer,jsonb,text,text,boolean) to authenticated;

create function public.practicum_review(p_work uuid,p_version integer,p_outcome text,p_feedback text) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.practicum_review(p_work,p_version,p_outcome,p_feedback)
$$;
revoke execute on function public.practicum_review(uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.practicum_review(uuid,integer,text,text), private.practicum_review(uuid,integer,text,text) to authenticated;
notify pgrst,'reload schema';
