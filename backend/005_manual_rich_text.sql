-- 어랍쇼 매뉴얼 서식 편집 v1.4
-- 일반 텍스트(body)는 검색·장애 시 대체 표시용으로 유지하고, 정제된 서식 본문은 body_html에 저장한다.

alter table public.manual_chapters
  add column body_html text;

alter table public.manual_revisions
  add column body_html text;

alter table public.manual_chapters
  add constraint manual_chapters_body_html_length
  check (body_html is null or char_length(body_html) <= 400000);

alter table public.manual_revisions
  add constraint manual_revisions_body_html_length
  check (body_html is null or char_length(body_html) <= 400000);

comment on column public.manual_chapters.body_html is
  'DOMPurify 허용 목록으로 정제된 매뉴얼 서식 HTML. body는 검색·대체 표시용 일반 텍스트.';
comment on column public.manual_revisions.body_html is
  '해당 게시 버전의 정제된 매뉴얼 서식 HTML.';

create or replace function private.save_manual_chapter_rich_impl(
  p_id text,
  p_title text,
  p_body text,
  p_body_html text,
  p_expected_version integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_current integer;
  v_new integer;
  v_email text;
  v_institution text;
  v_html text := btrim(coalesce(p_body_html, ''));
begin
  if v_actor is null or not private.can_edit_manual() then
    raise exception '매뉴얼 편집 권한이 없습니다';
  end if;

  if char_length(btrim(coalesce(p_title, ''))) not between 2 and 120
     or char_length(btrim(coalesce(p_body, ''))) < 1
     or char_length(p_body) > 200000
     or char_length(v_html) < 1
     or char_length(v_html) > 400000 then
    raise exception '제목 또는 본문 길이를 확인해 주세요';
  end if;

  -- 브라우저 저장 전·공개 출력 시 DOMPurify를 적용하고, 서버에서도 명백한 실행 코드와
  -- 인라인 스타일을 한 번 더 거부한다. 이 검사는 출력 시 정제를 대체하지 않는다.
  if v_html ~* '<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|option|svg|math|meta|link|base)\y'
     or v_html ~* '\son[a-z0-9_-]+\s*='
     or v_html ~* 'javascript\s*:'
     or v_html ~* 'data\s*:\s*text/html'
     or v_html ~* '\ssrcdoc\s*='
     or v_html ~* '\sstyle\s*=' then
    raise exception '허용되지 않은 HTML 요소 또는 속성이 포함되어 있습니다';
  end if;

  select version into v_current
  from public.manual_chapters
  where id = p_id
  for update;

  if not found then
    raise exception '매뉴얼 장을 찾을 수 없습니다';
  end if;

  if v_current <> p_expected_version then
    raise exception '다른 담당자가 먼저 수정했습니다. 새로고침 후 내용을 비교해 주세요';
  end if;

  update public.manual_chapters
  set title = btrim(p_title),
      body = p_body,
      body_html = v_html,
      version = version + 1,
      updated_by = v_actor,
      updated_at = now()
  where id = p_id
  returning version into v_new;

  select email, institution_id
  into v_email, v_institution
  from public.staff_profiles
  where user_id = v_actor;

  insert into public.manual_revisions(
    chapter_id, version, title, body, body_html, editor_user_id, editor_email
  )
  values(
    p_id, v_new, btrim(p_title), p_body, v_html, v_actor, coalesce(v_email, '담당자')
  );

  insert into public.audit_logs(
    actor_user_id, action, entity_type, entity_id, institution_id
  )
  values(
    v_actor, 'publish', 'manual_chapter', p_id, v_institution
  );

  return v_new;
end;
$function$;

create or replace function public.save_manual_chapter_rich(
  p_id text,
  p_title text,
  p_body text,
  p_body_html text,
  p_expected_version integer
)
returns integer
language sql
set search_path = ''
as $function$
  select private.save_manual_chapter_rich_impl(
    p_id, p_title, p_body, p_body_html, p_expected_version
  )
$function$;

revoke all on function private.save_manual_chapter_rich_impl(text,text,text,text,integer)
  from public, anon;
grant execute on function private.save_manual_chapter_rich_impl(text,text,text,text,integer)
  to authenticated;

revoke all on function public.save_manual_chapter_rich(text,text,text,text,integer)
  from public, anon;
grant execute on function public.save_manual_chapter_rich(text,text,text,text,integer)
  to authenticated;

notify pgrst, 'reload schema';