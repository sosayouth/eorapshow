-- 어랍쇼 매뉴얼 서식 편집 v1.4.1
-- 이전 관리자 화면에서 일반 텍스트 저장 RPC를 호출해도 오래된 서식 HTML이 남지 않도록 한다.

create or replace function private.save_manual_chapter_impl(
  p_id text,
  p_title text,
  p_body text,
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
begin
  if v_actor is null or not private.can_edit_manual() then
    raise exception '매뉴얼 편집 권한이 없습니다';
  end if;

  if char_length(btrim(coalesce(p_title, ''))) not between 2 and 120
     or char_length(btrim(coalesce(p_body, ''))) < 1
     or char_length(p_body) > 200000 then
    raise exception '제목 또는 본문 길이를 확인해 주세요';
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
      body_html = null,
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
    p_id, v_new, btrim(p_title), p_body, null, v_actor, coalesce(v_email, '담당자')
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

revoke all on function private.save_manual_chapter_impl(text,text,text,integer)
  from public, anon;
grant execute on function private.save_manual_chapter_impl(text,text,text,integer)
  to authenticated;

notify pgrst, 'reload schema';