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
  const paperDate = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric"
  });
  const formatPaperDate = value => value ? paperDate.format(new Date(value)) : "—";

  function approvalTable() {
    const table = el("table", null, "pr-approval");
    table.setAttribute("aria-label", "결재란");
    const header = el("tr");
    const caption = el("th", "결재");
    caption.rowSpan = 2;
    caption.scope = "rowgroup";
    header.append(caption);
    ["담당", "부장", "센터장"].forEach(title => {
      const cell = el("th", title);
      cell.scope = "col";
      header.append(cell);
    });
    const signatures = el("tr", null, "pr-approval-signatures");
    for (let column = 0; column < 3; column += 1) signatures.append(el("td"));
    const body = el("tbody");
    body.append(header, signatures);
    table.append(body);
    return table;
  }

  function printTable(rows, className = "") {
    const table = el("table", null, "pr-print-table " + className);
    const body = el("tbody");
    rows.forEach(([label, ...values]) => {
      const row = el("tr");
      const title = el("th", label);
      title.scope = "row";
      const content = el("td");
      content.append(...values);
      row.append(title, content);
      body.append(row);
    });
    table.append(body);
    return table;
  }

  function printDiary(item, version, cohort) {
    const { start_date: start, end_date: end } = cohort || {};
    const period = start && end ? formatPaperDate(start) + " ~ " + formatPaperDate(end) : "____________________";
    const offset = start ? Date.parse(item.day) - Date.parse(start) : -1;
    const week = offset >= 0 ? " (" + (Math.floor(offset / 604800000) + 1) + "주차)" : "";
    const metadata = printTable([
      ["실습기관 / 차수", [item.institution, item.cohort].filter(Boolean).join(" / ")],
      ["실습생", item.person_name],
      ["실습일", formatPaperDate(item.day)],
      ["실습기간", period + week],
      ["실습시간", "________ 시간"],
      ["제출일", formatPaperDate(version.submitted_at) + " · " + version.number + "차 제출"]
    ], "pr-print-meta");
    const activityKeys = new Set(["goal", "activities", "observation"]);
    const activity = item.fields.filter(def => activityKeys.has(def.key));
    const reflection = item.fields.filter(def => !activityKeys.has(def.key));
    const rows = [
      ["실습내용", ...textFields(activity, version.body)],
      ["소감 및 자기평가", ...textFields(reflection, version.body)]
    ];
    if (version.feedback) rows.push(["지도자 피드백", el("p", version.feedback, "pr-safe-text")]);
    rows.push(["확인", layout("pr-print-signatures",
      el("span", "실습생 " + item.person_name + " __________ (서명)"),
      el("span", "실습지도자 __________ (서명)"))]);
    return [metadata, printTable(rows, "pr-print-diary")];
  }

  function printReport(item, version) {
    const metadata = printTable([
      ["실습기관 / 차수", [item.institution, item.cohort].filter(Boolean).join(" / ")],
      ["작성자", item.person_name],
      ["제출일", formatPaperDate(version.submitted_at) + " · " + version.number + "차 제출"]
    ], "pr-print-meta");
    const rows = item.fields
      .filter(def => !version.attachment_key || version.body[def.key]?.trim())
      .map(def => [def.label, el("p", version.body[def.key] || "—", "pr-safe-text")]);
    if (version.attachment_name) rows.push(["첨부 파일", el("p", version.attachment_name, "pr-safe-text")]);
    if (version.feedback) rows.push(["지도자 피드백", el("p", version.feedback, "pr-safe-text")]);
    return [metadata, printTable(rows, "pr-print-report")];
  }

  let clearPrint;
  function printVersion(item, version, cohort) {
    clearPrint?.();
    const block = el("article", null, "pr-print-only");
    const formNumber = item.title.match(/\[서식 \d+\]$/)?.[0];
    const headline = formNumber ? item.title.slice(0, -formNumber.length).trim() : item.title;
    const header = el("header", null, "pr-print-header");
    const top = layout("pr-print-top");
    if (formNumber) top.append(el("span", formNumber, "pr-form-number"));
    top.append(approvalTable());
    header.append(top, el("h1", headline));
    block.append(header, ...(item.day ? printDiary(item, version, cohort) : printReport(item, version)));

    document.body.append(block);
    document.body.classList.add("pr-printing");
    clearPrint = () => {
      window.removeEventListener("afterprint", clearPrint);
      block.remove();
      document.body.classList.remove("pr-printing");
      clearPrint = undefined;
    };
    window.addEventListener("afterprint", clearPrint, { once: true });
    try { window.print(); }
    catch (error) {
      clearPrint?.();
      throw error;
    }
  }
  function versionList(db, item, notice, cohort) {
    const section = el("section");
    if (item.versions.length === 0) return section;
    section.append(el("h3", "제출 및 검토 이력"));
    item.versions.forEach((version, index) => {
      const detail = el("details", null, "pr-detail pr-card");
      detail.open = index === 0;
      const state = version.outcome ? " · " + labels[version.outcome] : "";
      detail.append(el("summary", "제출 " + version.number + "차 · " + dateLabel(version.submitted_at) + state +
        (version.late ? " · 제출 당시 기한 후" : "")));
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
      detail.append(button("인쇄 / PDF 저장", () => printVersion(item, version, cohort)));
      section.append(detail);
    });
    return section;
  }
  window.EorapPracticum = { labels, el, layout, button, field, input, select, badge, panel, message, rpc, dateLabel, download, versionList };
})();
