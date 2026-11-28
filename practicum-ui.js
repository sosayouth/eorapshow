(() => {
  "use strict";
  const labels = {
    missing: "미작성", draft: "임시저장", submitted: "검토 대기",
    changes: "보완 요청", reviewed: "검토 완료", unlinked: "미연결",
    invited: "초대 발급", scheduled: "예정", active: "연결 완료", revoked: "접근 중지"
  };
  const clock = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const dateLabel = value => value ? clock.format(new Date(value)) : "—";
  const el = (tag, label, cls) => {
    const node = document.createElement(tag);
    if (label !== undefined && label !== null) node.textContent = label;
    if (cls) node.className = cls;
    return node;
  };
  function layout(cls, ...children) {
    const node = el("div", null, cls);
    node.append(...children);
    return node;
  }
  function button(label, onClick, primary = false) {
    const node = el("button", label, "pr-btn" + (primary ? " pr-primary" : ""));
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }
  function field(label, control) {
    const node = el("label", null, "pr-field");
    node.append(el("span", label), control);
    return node;
  }
  function input(type, value = "") {
    const node = el("input");
    node.type = type;
    node.value = value;
    return node;
  }
  function select(options, value) {
    const node = el("select");
    options.forEach(([id, label]) => {
      const option = el("option", label);
      option.value = id;
      node.append(option);
    });
    if (value != null && options.some(([id]) => id === value)) node.value = value;
    return node;
  }
  function badge(status) {
    const node = el("span", labels[status] || status, "pr-badge");
    node.dataset.state = status;
    return node;
  }
  function panel(...children) {
    const node = el("section", null, "pr-panel");
    node.append(...children);
    return node;
  }
  function message(target, value, error = false) {
    target.textContent = value;
    target.hidden = !value;
    target.className = error ? "pr-alert" : "pr-note";
    target.setAttribute("role", error ? "alert" : "status");
  }
  async function rpc(db, name, args) {
    const { data, error } = await db.rpc("practicum_" + name, args);
    if (error) {
      const publicError = error.message && /^[가-힣]/.test(error.message) ? error.message :
        "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
      throw new Error(publicError, { cause: error });
    }
    return data;
  }
  async function download(db, key, name) {
    const { data, error } = await db.storage.from("practicum-submissions").download(key);
    if (error) throw new Error("첨부파일을 열지 못했습니다.");
    const url = URL.createObjectURL(data);
    const link = el("a");
    link.href = url;
    link.download = name || "실습보고서.pdf";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function textFields(fields, body) {
    return fields.map(def => {
      const section = el("section", null, "pr-body-field");
      section.append(el("h3", def.label), el("p", body[def.key] || "—", "pr-safe-text"));
      return section;
    });
  }
  function printVersion(item, version) {
    const block = el("article", null, "pr-print-only");
    block.append(el("h1", item.title + (item.day ? " · " + item.day : "")),
      el("p", [item.institution, item.cohort, item.person_name, "제출 " + version.number + "차", dateLabel(version.submitted_at)].join(" · ")),
      ...textFields(item.fields, version.body));
    if (version.attachment_name) block.append(el("p", "첨부 " + version.attachment_name));
    if (version.feedback) block.append(el("h2", labels[version.outcome]), el("p", version.feedback, "pr-safe-text"));
    document.body.append(block);
    document.body.classList.add("pr-printing");
    try { window.print(); }
    finally {
      block.remove();
      document.body.classList.remove("pr-printing");
    }
  }
  function versionList(db, item, notice) {
    const section = el("section");
    if (item.versions.length === 0) return section;
    section.append(el("h3", "제출 및 검토 이력"));
    item.versions.forEach((version, index) => {
      const detail = el("details", null, "pr-detail pr-card");
      detail.open = index === 0;
      const state = version.outcome ? " · " + labels[version.outcome] : "";
      detail.append(el("summary", "제출 " + version.number + "차 · " + dateLabel(version.submitted_at) + state +
        (version.late ? " · 기한 후 제출" : "")));
      if (version.feedback) {
        detail.append(el("p", labels[version.outcome] + " · " + dateLabel(version.reviewed_at), "pr-muted"),
          el("p", version.feedback, "pr-safe-text pr-note"));
      }
      detail.append(...textFields(item.fields, version.body));
      if (version.attachment_key) detail.append(button("PDF 내려받기 · " + version.attachment_name, async event => {
        event.currentTarget.disabled = true;
        try { await download(db, version.attachment_key, version.attachment_name); }
        catch (error) { message(notice, error.message, true); }
        finally { detail.querySelector("button").disabled = false; }
      }));
      if (version.outcome === "reviewed") detail.append(button("인쇄 / PDF 저장", () => printVersion(item, version)));
      section.append(detail);
    });
    return section;
  }
  window.EorapPracticum = { labels, el, layout, button, field, input, select, badge, panel, message, rpc, dateLabel, download, versionList };
})();
