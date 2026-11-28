-- 실습일 기준 일지 제출기한을 차수별로 관리한다.
create table private.practicum_diary_deadlines (
  cohort_id uuid primary key references public.cohorts(id) on delete cascade,
  delay_days integer not null default 7 check (delay_days >= 0),
  cutoff time not null default '18:00' check (cutoff < time '24:00')
);
alter table private.practicum_diary_deadlines enable row level security;
revoke all on table private.practicum_diary_deadlines from public, anon, authenticated;

-- 기존 실습일의 마감 시각을 기준으로 차수 기본값을 구성한다.
insert into private.practicum_diary_deadlines(cohort_id,cutoff)
select distinct on (cohort_id) cohort_id, (due_at at time zone 'Asia/Seoul')::time
from private.practicum_days
where not cancelled
order by cohort_id, practice_date desc;

-- 기존 당일 마감 날짜에 7일 기본값을 적용한다.
update private.practicum_days
set due_at=((practice_date+7)+(due_at at time zone 'Asia/Seoul')::time) at time zone 'Asia/Seoul'
where not cancelled and (due_at at time zone 'Asia/Seoul')::date=practice_date;


CREATE OR REPLACE FUNCTION private.practicum_set_days(p_cohort uuid, p_dates date[], p_time time without time zone, p_cancel boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cohort public.cohorts%rowtype;
  deadline private.practicum_diary_deadlines%rowtype;
begin
  select * into cohort from public.cohorts where id=p_cohort and private.practicum_manager(institution_id) for update;
  if not found then raise exception '실습일 변경 권한이 없습니다.' using errcode='42501'; end if;
  if cardinality(p_dates) is null or cardinality(p_dates) not between 1 and 150
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
    select * into deadline from private.practicum_diary_deadlines where cohort_id=p_cohort;
    insert into private.practicum_days(cohort_id,practice_date,due_at)
    select p_cohort,d,((d+coalesce(deadline.delay_days,7))+coalesce(deadline.cutoff,p_time,time '18:00')) at time zone 'Asia/Seoul' from (select distinct unnest(p_dates) as d) days
    on conflict(cohort_id,practice_date) do update set due_at=excluded.due_at,cancelled=false;
  end if;
  perform private.practicum_log('update','practicum_days',p_cohort::text,cohort.institution_id);
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
    'diary_deadline',case when manager then coalesce(
      (select jsonb_build_object('delay_days',d.delay_days,'cutoff',d.cutoff)
       from private.practicum_diary_deadlines d where d.cohort_id=p_cohort),
      jsonb_build_object('delay_days',7,'cutoff',time '18:00')) end,
    'items',private.practicum_items(p_cohort,null));
end;
$function$;

create function private.practicum_set_diary_deadline(p_cohort uuid,p_delay_days integer,p_cutoff time)
returns void language plpgsql security definer set search_path = '' as $$
declare org text;
begin
  select institution_id into org from public.cohorts
    where id=p_cohort and private.practicum_manager(institution_id) for update;
  if not found then raise exception '일지 마감 변경 권한이 없습니다.' using errcode='42501'; end if;
  if p_delay_days is null or p_delay_days<0 or p_cutoff is null or p_cutoff>=time '24:00'
    then raise exception '마감 일수와 시각을 확인해 주세요. 당일 마감은 0일입니다.'; end if;

  insert into private.practicum_diary_deadlines(cohort_id,delay_days,cutoff)
  values(p_cohort,p_delay_days,p_cutoff)
  on conflict(cohort_id) do update set delay_days=excluded.delay_days,cutoff=excluded.cutoff;

  update private.practicum_days
  set due_at=((practice_date+p_delay_days)+p_cutoff) at time zone 'Asia/Seoul'
  where cohort_id=p_cohort and not cancelled;

  perform private.practicum_log('update','practicum_diary_deadline',p_cohort::text,org);
end;
$$;

create function public.practicum_set_diary_deadline(p_cohort uuid,p_delay_days integer,p_cutoff time)
returns void language sql security invoker set search_path = '' as $$
  select private.practicum_set_diary_deadline(p_cohort,p_delay_days,p_cutoff);
$$;
revoke execute on function private.practicum_set_diary_deadline(uuid,integer,time),
  public.practicum_set_diary_deadline(uuid,integer,time) from public,anon,authenticated;
grant execute on function private.practicum_set_diary_deadline(uuid,integer,time),
  public.practicum_set_diary_deadline(uuid,integer,time) to authenticated;

notify pgrst,'reload schema';
