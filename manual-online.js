/* 공개 매뉴얼은 DB 게시본을 읽고, 연결 장애 시 내장 기본본을 표시한다. */
(() => {
  "use strict";
  const cfg = window.EORAPSHOW_CONFIG || {};
  const allowedTags = [
    "p","br","strong","b","em","i","u","s","strike","h2","h3","h4","ul","ol","li",
    "blockquote","a","table","thead","tbody","tfoot","tr","th","td","span"
  ];
  const allowedAttrs = ["href","target","rel","class","colspan","rowspan","scope"];
  const allowedClasses = new Set([
    "text-small","text-large","text-xlarge",
    "align-center","align-right","align-justify","manual-table"
  ]);

  function normalizeSpan(value) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number >= 1 && number <= 10 ? String(number) : "";
  }

  function sanitizeManualHtml(value) {
    if (!window.DOMPurify) return "";
    const clean = window.DOMPurify.sanitize(String(value || ""), {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: allowedAttrs,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
      FORBID_TAGS: ["script","style","iframe","object","embed","form","input","button","textarea","select","option","svg","math","meta","link","base"],
      FORBID_ATTR: ["style","src","srcset","id","name","form","formaction","srcdoc"]
    });
    const box = document.createElement("div");
    box.innerHTML = clean;
    box.querySelectorAll("*").forEach(node => {
      if (node.hasAttribute("class")) {
        const classes = [...node.classList].filter(name => allowedClasses.has(name));
        if (classes.length) node.className = classes.join(" ");
        else node.removeAttribute("class");
      }
      if (node.matches("td,th")) {
        for (const attr of ["colspan","rowspan"]) {
          const normalized = normalizeSpan(node.getAttribute(attr));
          if (normalized) node.setAttribute(attr, normalized);
          else node.removeAttribute(attr);
        }
      }
      if (node.matches("th") && !["row","col"].includes(node.getAttribute("scope"))) {
        node.removeAttribute("scope");
      }
      if (node.matches("a")) {
        const href = (node.getAttribute("href") || "").trim();
        if (!/^(https?:\/\/|mailto:|#|\/|\.\.?\/)/i.test(href)) {
          node.removeAttribute("href");
          node.removeAttribute("target");
          node.removeAttribute("rel");
        } else if (/^https?:\/\//i.test(href)) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        } else {
          node.removeAttribute("target");
          node.removeAttribute("rel");
        }
      }
    });
    box.querySelectorAll("table").forEach(table => table.classList.add("manual-table"));
    return box.innerHTML;
  }

  function linkReferences(container) {
    const catalog = typeof DATA !== "undefined" && Array.isArray(DATA.catalog) ? DATA.catalog : [];
    const available = new Set(catalog.map(item => Number(item.number)));
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest("a,button") && /\[서식 \d{1,2}\]/.test(node.nodeValue || "")) nodes.push(node);
    }
    for (const node of nodes) {
      const text = node.nodeValue || "";
      const fragment = document.createDocumentFragment();
      let start = 0;
      text.replace(/\[서식 (\d{1,2})\]/g, (full, number, offset) => {
        fragment.append(document.createTextNode(text.slice(start, offset)));
        if (available.has(Number(number))) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "ref-link";
          button.dataset.reference = String(Number(number));
          button.textContent = full + " ↗";
          fragment.append(button);
        } else {
          fragment.append(document.createTextNode(full));
        }
        start = offset + full.length;
        return full;
      });
      fragment.append(document.createTextNode(text.slice(start)));
      node.replaceWith(fragment);
    }
  }

  window.EORAPSHOW_RENDER_MANUAL_HTML = value => {
    const safe = sanitizeManualHtml(value);
    if (!safe) return "";
    const box = document.createElement("div");
    box.innerHTML = safe;
    linkReferences(box);
    return box.innerHTML;
  };

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
        cfg.url + "/rest/v1/manual_chapters?select=id,title,group_name,body,body_html,version,updated_at&order=sort_order.asc",
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
          return {
            ...x,
            title: row.title,
            group: row.group_name,
            text: row.body,
            html: typeof row.body_html === "string" ? row.body_html : ""
          };
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