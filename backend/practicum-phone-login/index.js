const origin = "https://sosayouth.github.io";
const cors = {
  "access-control-allow-origin": origin,
  "access-control-allow-headers": "authorization, apikey, x-client-info, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store",
  "vary": "Origin"
};
const invalid = { error: "휴대전화 번호 또는 비밀번호를 확인해 주세요." };
const unavailable = { error: "로그인 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." };

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors,
    "content-type": "application/json; charset=utf-8" } });
}

Deno.serve(async request => {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== origin) return reply(403, invalid);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply(405, invalid);

  let body;
  try { body = await request.json(); }
  catch { return reply(400, invalid); }
  const { phone, password } = body || {};
  if (typeof phone !== "string" || phone.length > 40 || !phone.trim() ||
    typeof password !== "string" || !password || password.length > 1024) return reply(400, invalid);

  const api = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!api || !anon || !service) return reply(503, unavailable);

  try {
    const resolved = await fetch(api + "/rest/v1/rpc/practicum_phone_login_target", {
      method: "POST",
      headers: { apikey: service, authorization: "Bearer " + service, "content-type": "application/json" },
      body: JSON.stringify({ p_phone: phone.trim() })
    });
    if (!resolved.ok) return reply(503, unavailable);
    const account = await resolved.json();

    // Always use the project's ordinary password grant, including when there is no usable alias.
    // The browser never receives the resolved email or the service credential.
    const result = await fetch(api + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: anon, authorization: "Bearer " + anon, "content-type": "application/json" },
      body: JSON.stringify({ email: account?.email || "practicum-phone-no-account@invalid.example",
        password: account ? password : "no-matching-account" })
    });
    if (result.status >= 500) return reply(503, unavailable);
    if (!result.ok || !account) return reply(401, invalid);
    const session = await result.json();
    if (session.user?.id !== account.user_id || typeof session.access_token !== "string" ||
      !session.access_token || typeof session.refresh_token !== "string" || !session.refresh_token) return reply(401, invalid);
    return reply(200, { access_token: session.access_token, refresh_token: session.refresh_token });
  } catch {
    return reply(503, unavailable);
  }
});