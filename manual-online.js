/* 공개 매뉴얼은 DB 게시본을 읽고, 연결 장애 시 내장 기본본을 표시한다. */
(() => {
  "use strict";
  const cfg = window.EORAPSHOW_CONFIG || {};
  const linkForEditor = () => {
    const tools = document.querySelector(".article-tools");
    if (!tools || tools.querySelector(".manual-editor-link")) return;
    const link = document.createElement("a");
    link.className = "btn manual-editor-link";
    link.href = "./admin.html#manual=" + encodeURIComponent(currentManual || "");
    link.textContent = "담당자 편집";
    tools.append(link);
  };
  const observer = new MutationObserver(linkForEditor);
  observer.observe(document.getElementById("main"), { childList: true });
  linkForEditor();

  async function refreshManual() {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.url || "") || !cfg.publishableKey) return;
    try {
      const response = await fetch(
        cfg.url + "/rest/v1/manual_chapters?select=id,title,group_name,body,version,updated_at&order=sort_order.asc",
        { headers: { apikey: cfg.publishableKey }, cache: "no-store", signal: AbortSignal.timeout(10000) }
      );
      if (!response.ok) throw Error("매뉴얼 연결 실패: " + response.status);
      const rows = await response.json();
      const byId = new Map(rows.map(row => [row.id, row]));
      if (rows.length !== sections.length || sections.some(x => !byId.has(x.id))) {
        throw Error("매뉴얼 장 수가 일치하지 않습니다");
      }
      window.EORAPSHOW_MANUAL = {
        sections: sections.map(x => {
          const row = byId.get(x.id);
          return { ...x, title: row.title, group: row.group_name, text: row.body };
        })
      };
      state.manualVersion = "서버 게시본";
      if (page === "manual") render();
    } catch (error) {
      console.warn("매뉴얼 서버 연결", error);
      state.manualVersion = "내장 기본본 · 서버 연결 확인 필요";
      if (page === "manual") render();
    }
  }
  refreshManual();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshManual();
  });
})();