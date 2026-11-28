const traineePage = "https://sosayouth.github.io/eorapshow/trainee.html";
const origin = new URL(traineePage).origin;
const cors = {
  "access-control-allow-origin": origin,
  "access-control-allow-headers": "authorization, apikey, x-client-info, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store",
  "vary": "Origin"
};
function reply(status, value) {
  return new Response(JSON.stringify(value), {
    status, headers: { ...cors, "content-type": "application/json; charset=utf-8" }
  });
}
Deno.serve(async request => {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== origin) return reply(403, { error: "지원되지 않는 사이트입니다." });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply(405, { error: "요청 방식을 확인해 주세요." });
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return reply(401, { error: "직원 로그인이 필요합니다." });
  try {
    const { personId, email, reviewerId } = await request.json();
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if (typeof personId !== "string" || !uuid.test(personId) ||
      (reviewerId != null && (typeof reviewerId !== "string" || !uuid.test(reviewerId))) ||
      typeof email !== "string" || email.length > 254)
      return reply(400, { error: "실습생 이메일과 지도자를 확인해 주세요." });

    const api = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    // PostgREST authenticates the caller and the RPC checks their active role and cohort.
    const permission = await fetch(api + "/rest/v1/rpc/practicum_issue_invite", {
      method: "POST",
      headers: { apikey: anon, authorization, "content-type": "application/json" },
      body: JSON.stringify({ p_person: personId, p_email: email, p_reviewer: reviewerId ?? null })
    });
    if (!permission.ok) {
      const error = await permission.json().catch(() => ({}));
      return reply(permission.status === 401 || permission.status === 403 ? 403 : 400, {
        error: typeof error.message === "string" && /^[가-힣]/.test(error.message)
          ? error.message : "해당 실습생의 초대 링크를 발급할 권한 또는 입력값을 확인해 주세요."
      });
    }
    const invite = await permission.json();
    if (!invite.email || (!invite.existing && !invite.ticket)) return reply(409, { error: "초대 상태를 다시 확인해 주세요." });
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const type = invite.existing ? "magiclink" : "invite";
    const auth = await fetch(api + "/auth/v1/admin/generate_link", {
      method: "POST",
      headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ type, email: invite.email, ...(invite.existing ? {} : { data: { eorapshow_invitation: invite.ticket } }) })
    });
    const result = await auth.json();
    if (!auth.ok || typeof result.hashed_token !== "string" || !result.hashed_token) {
      return reply(502, { error: "인증 서버에서 링크를 만들지 못했습니다. 잠시 후 다시 발급해 주세요." });
    }
    const page = new URL(traineePage);
    page.hash = new URLSearchParams({ token_hash: result.hashed_token, type }).toString();
    return reply(200, { url: page.href });
  } catch {
    return reply(400, { error: "초대 링크를 준비하지 못했습니다. 입력값과 서버 연결을 확인해 주세요." });
  }
});
