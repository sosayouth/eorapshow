(() => {
  "use strict";
  const { el, layout, button, field, input, select, badge, panel, message, rpc, dateLabel, versionList } = window.EorapPracticum;
  const names = {
    missing: "미작성", draft: "임시저장", submitted: "검토 대기",
    changes: "보완 요청", reviewed: "검토 완료", scheduled: "예정"
  };
  const rowStatus = (row, today) => row.day && row.day > today && !row.work_id ? "scheduled" : row.status;
  function formSubmit(label, callback) {
    const submit = el("button", label, "pr-btn pr-primary");
    submit.type = "submit";
    const form = el("form");
    form.addEventListener("submit", event => {
      event.preventDefault();
      callback(submit);
    });
    return { form, submit };
  }
  function table(headers, rows, toCells) {
    const node = el("table", null, "pr-table");
    const head = el("thead");
    const header = el("tr");
    headers.forEach(title => {
      const th = el("th", title);
      th.scope = "col";
      header.append(th);
    });
    head.append(header);
    const body = el("tbody");
    rows.forEach(row => {
      const line = el("tr");
      toCells(row).forEach(value => {
        const td = el("td");
        td.append(value ?? "—");
        line.append(td);
      });
      body.append(line);
    });
    node.append(head, body);
    return layout("pr-scroll", node);
  }

  function mount({ db, box, cohort, onBack }) {
    const notice = el("p");
    notice.hidden = true;
    const body = el("div");
    const root = layout("pr-app", layout("pr-row pr-between", el("h2", cohort.name + " · 제출 검토"),
      button("차수 목록", onBack)), notice, body);
    box.replaceChildren(root);
    const state = { board: null, tab: "progress", learner: "", kind: "", filter: "", page: 0, link: null };
    const say = (text, error) => message(notice, text, error);
    async function run(task, control) {
      if (control) control.disabled = true;
      say("");
      try { return await task(); }
      catch (error) { say(error.message || "작업을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.", true); }
      finally { if (control) control.disabled = false; }
    }
    async function fetchBoard() {
      state.board = await rpc(db, "board", { p_cohort: cohort.id });
      render();
    }
    function render() {
      const tabs = [["progress", "제출 현황"]];
      if (state.board.can_manage) tabs.push(["access", "실습생 계정"], ["calendar", "실습일 설정"], ["reports", "보고서 배정"]);
      const nav = el("nav", null, "pr-row pr-nav");
      nav.setAttribute("aria-label", "실습 차수 제출 관리");
      tabs.forEach(([key, title]) => {
        const item = button(title, () => {
          state.tab = key;
          state.link = null;
          say("");
          render();
        }, state.tab === key);
        if (state.tab === key) item.setAttribute("aria-current", "page");
        nav.append(item);
      });
      const view = { progress, access, calendar, reports }[state.tab];
      body.replaceChildren(nav, view());
    }

    function progress() {
      const { roster, items, today, can_manage: canManage } = state.board;
      const student = select([["", "전체 실습생"], ...roster.map(person => [person.id, person.name])], state.learner);
      const kind = select([["", "일지·보고서"], ["diary", "일지"], ["report", "보고서"]], state.kind);
      const status = select([["", "전체 상태"], ...Object.entries(names)], state.filter);
      [[student, "learner"], [kind, "kind"], [status, "filter"]].forEach(([control, key]) =>
        control.addEventListener("change", () => {
          state[key] = control.value;
          state.page = 0;
          render();
        }));
      const relevant = items.filter(item => (!state.learner || item.person_id === state.learner) &&
        (!state.kind || state.kind === (item.day ? "diary" : "report")));
      const due = relevant.filter(i => !i.day || i.day <= today);
      const stats = [
        ["제출 이력", due.filter(i => i.version > 0).length + " / " + due.length + "건"],
        ["검토 대기", due.filter(i => i.status === "submitted").length + "건"],
        ["보완 요청", due.filter(i => i.status === "changes").length + "건"],
        ["검토 완료", due.filter(i => i.status === "reviewed").length + "건"]
      ];
      const matching = relevant.filter(i => !state.filter || rowStatus(i, today) === state.filter);
      const size = 30;
      const count = Math.ceil(matching.length / size);
      state.page = Math.min(state.page, Math.max(0, count - 1));
      const shown = matching.slice(state.page * size, (state.page + 1) * size);
      const content = panel(el("h3", "실습생별 진행 상황"),
        el("p", "본문과 검토 의견은 배정된 지도자가 제출 후 확인할 수 있습니다.", "pr-muted"),
        layout("pr-grid", field("실습생", student), field("종류", kind), field("상태", status)),
        layout("pr-grid", ...stats.map(([title, value]) =>
          layout("pr-stat", el("span", title), el("strong", value)))));
      if (!matching.length) {
        content.append(el("p", roster.length
          ? "조회 조건에 해당하는 항목이 없습니다." : canManage
            ? "이 차수에 실습생이 없습니다. ‘기관별 인원’에서 실습생을 등록하고 차수를 지정해 주세요."
            : "이 차수에 배정된 실습생이 없습니다.", "pr-muted"));
        return content;
      }
      content.append(table(["실습생", "일지·보고서", "기한", "상태", "제출본"], shown, item => [
        item.person_name,
        item.day ? item.day + " 일지" : item.title + (item.individual ? " · 개별" : ""),
        dateLabel(item.due_at),
        layout("pr-row", badge(rowStatus(item, today)), ...(item.late ? [el("small", "기한 후 제출")] : [])),
        item.can_review ? button(item.status === "submitted" ? "검토하기" : "이력 보기", event =>
          run(() => open(item.work_id), event.currentTarget), item.status === "submitted") : "—"
      ]));
      if (count > 1) {
        const move = delta => {
          state.page += delta;
          render();
        };
        const prev = button("이전", () => move(-1));
        const next = button("다음", () => move(1));
        prev.disabled = state.page === 0;
        next.disabled = state.page >= count - 1;
        content.append(layout("pr-row", prev, el("span", state.page + 1 + " / " + count + "쪽 · " + matching.length + "건"), next));
      }
      return content;
    }

    async function open(workId) {
      const item = await rpc(db, "item", { p_work: workId });
      const overview = panel(layout("pr-row pr-between",
        el("h3", item.person_name + " · " + item.title + (item.day ? " · " + item.day : "")),
        button("현황으로", () => { say(""); render(); })),
        layout("pr-row", badge(item.status), el("span", "제출기한 " + dateLabel(item.due_at), "pr-muted")));
      body.replaceChildren(overview, panel(versionList(db, item, notice)));
      overview.querySelector("button").focus();
      if (!item.can_review) return;
      const outcome = select([["reviewed", "검토 완료"], ["changes", "보완 요청"]]);
      const note = el("textarea");
      note.maxLength = 4000;
      const { form, submit } = formSubmit("검토 결과 저장", control => run(async () => {
        if (outcome.value === "changes" && !note.value.trim()) throw new Error("실습생이 보완할 내용을 입력해 주세요.");
        await rpc(db, "review", {
          p_work: item.id, p_version: item.version, p_outcome: outcome.value, p_feedback: note.value
        });
        await fetchBoard();
        say("검토 결과를 저장했습니다. 실습생 화면에 반영됩니다.");
      }, control));
      form.append(field("검토 결과", outcome), field("실습생에게 남길 의견", note), submit);
      body.append(panel(el("h3", "피드백 작성"), form));
    }

    function access() {
      const { roster, reviewers } = state.board;
      const content = panel(el("h3", "실습생 계정과 지도자"),
        el("p", "개인 또는 학교 이메일로 링크를 발급해 해당 실습생에게 직접 전달합니다. 재발급 링크에서도 비밀번호를 설정할 수 있습니다.", "pr-muted"));
      if (!roster.length) {
        content.append(el("p", "‘기관별 인원’에서 이 차수에 실습생을 먼저 등록해 주세요."));
        return content;
      }
      content.append(table(["실습생", "연결 이메일", "지도자", "접속 상태"], roster, person => [
        person.name, person.email, person.reviewer_name || reviewers.find(r => r.id === person.reviewer_id)?.label, badge(person.account)
      ]));
      const available = roster.filter(p => p.practice_status !== "completed");
      if (!available.length || !reviewers.length) {
        content.append(el("p", reviewers.length ? "초대할 수 있는 진행 중·예정 실습생이 없습니다." :
          "사용자·권한에서 같은 기관의 실습지도자 또는 기관관리자를 활성화해 주세요.", "pr-note"));
        return content;
      }
      const person = select(available.map(p => [p.id, p.name]), state.link?.person);
      const email = input("email");
      email.required = true;
      email.maxLength = 254;
      const reviewer = select([["", "선택"], ...reviewers.map(p => [p.id, p.label])]);
      reviewer.required = true;
      const disable = button("접근 중지", event => run(async () => {
        if (!window.confirm("이 실습생의 접속을 중지하시겠습니까? 작성 기록은 보관됩니다.")) return;
        await rpc(db, "revoke", { p_person: person.value });
        state.link = null;
        await fetchBoard();
        say("실습생의 접속을 중지했습니다.");
      }, event.currentTarget));
      const linkResult = layout("pr-note");
      const current = () => available.find(p => p.id === person.value);
      function sync() {
        const selected = current();
        email.value = selected.email || "";
        email.readOnly = ["active", "revoked"].includes(selected.account) && !!selected.email;
        reviewer.value = selected.reviewer_id || "";
        disable.hidden = !["active", "invited"].includes(selected.account);
        linkResult.hidden = state.link?.person !== selected.id;
        if (linkResult.hidden) linkResult.replaceChildren();
      }
      person.addEventListener("change", () => {
        state.link = null;
        sync();
        say("");
      });
      const { form, submit } = formSubmit("초대·재설정 링크 발급", control => run(async () => {
        const personId = person.value;
        const { data, error } = await db.functions.invoke("practicum-invite", {
          body: { personId, email: email.value.trim(), reviewerId: reviewer.value }
        });
        if (error) {
          const details = await error.context?.json?.().catch(() => null);
          throw new Error(details?.error || "초대 링크를 발급하지 못했습니다. 다시 시도해 주세요.");
        }
        const url = new URL(data.url);
        if (url.origin !== location.origin || url.pathname !== new URL("./trainee.html", location.href).pathname)
          throw new Error("실습생 링크 주소를 확인해 주세요.");
        state.link = { person: personId, url: url.href };
        await fetchBoard();
        say("링크를 발급했습니다. 실습생 본인에게만 전달해 주세요.");
      }, control));
      sync();
      if (!linkResult.hidden) {
        const link = input("text", state.link.url);
        link.readOnly = true;
        linkResult.append(field("발급 링크", link), button("링크 복사", event => run(async () => {
          try {
            await navigator.clipboard.writeText(link.value);
            say("링크를 복사했습니다.");
          } catch {
            link.select();
            say("선택된 링크를 복사해 주세요.");
          }
        }, event.currentTarget)));
      }
      form.append(layout("pr-grid", field("실습생 선택", person), field("실습생 이메일", email), field("실습지도자", reviewer)),
        layout("pr-row", submit, disable), linkResult);
      content.append(form);
      return content;
    }

    function calendar() {
      const { days } = state.board;
      const dates = el("textarea");
      dates.required = true;
      dates.placeholder = "YYYY-MM-DD";
      const time = input("time", "18:00");
      time.required = true;
      const toDates = () => [...new Set(dates.value.trim().split(/[\s,]+/).filter(Boolean))];
      const save = (cancel, control) => run(async () => {
        const listed = toDates();
        if (!listed.length || listed.length > 150 || listed.some(value => !/^\d{4}-\d{2}-\d{2}$/.test(value)))
          throw new Error("날짜를 YYYY-MM-DD 형식으로 한 줄에 하나씩 입력해 주세요.");
        await rpc(db, "set_days", { p_cohort: cohort.id, p_dates: listed, p_time: time.value, p_cancel: cancel });
        await fetchBoard();
        say(cancel ? "선택한 실습일을 취소했습니다." : "실습일과 일지 마감 시각을 저장했습니다.");
      }, control);
      const { form, submit } = formSubmit("실습일 저장", control => save(false, control));
      const fill = button("차수 평일 채우기", () => {
        const first = new Date(cohort.start_date + "T00:00:00Z");
        const last = new Date(cohort.end_date + "T00:00:00Z");
        if (!Number.isFinite(first.valueOf()) || !Number.isFinite(last.valueOf()) || (last - first) / 86400000 > 210) {
          say("차수 시작일·종료일을 확인하거나 실제 실습일을 직접 입력해 주세요.", true);
          return;
        }
        const values = [];
        for (const day = first; day <= last; day.setUTCDate(day.getUTCDate() + 1))
          if (day.getUTCDay() >= 1 && day.getUTCDay() <= 5) values.push(day.toISOString().slice(0, 10));
        dates.value = values.join("\n");
        say("휴무일과 공휴일은 목록에서 지운 뒤 저장해 주세요.");
      });
      fill.hidden = !cohort.start_date || !cohort.end_date;
      form.append(layout("pr-grid", field("실습 날짜 (한 줄에 하나)", dates), field("일지 마감 시각 (한국시간)", time)),
        layout("pr-row", submit, fill, button("입력한 실습일 취소", event => save(true, event.currentTarget))));
      const content = panel(el("h3", "일지를 작성할 날짜"),
        el("p", "저장한 실습일이 각 실습생의 일지 목록에 표시됩니다. 제때 제출하지 못해도 제출할 수 있으며 기한 후 제출로 표시됩니다.", "pr-muted"), form);
      if (days.length) {
        const detail = el("details", null, "pr-detail");
        detail.append(el("summary", "등록한 실습일 " + days.length + "개"),
          table(["실습일", "일지 마감", "상태"], days, day => [day.day, dateLabel(day.due_at), day.cancelled ? "취소" : "등록"]));
        content.append(detail);
      }
      return content;
    }

    function reports() {
      const { roster, templates, today, items } = state.board;
      const person = select([["", "차수 전체"], ...roster.map(p => [p.id, p.name])]);
      const type = select(templates.map(t => [t.code, t.title]));
      const due = input("datetime-local", today + "T18:00");
      due.required = true;
      const instructions = el("textarea");
      instructions.maxLength = 2000;
      const { form, submit } = formSubmit("보고서 배정 저장", control => run(async () => {
        await rpc(db, "assign", {
          p_cohort: cohort.id, p_template: type.value, p_person: person.value || null,
          p_due: due.value + "+09:00", p_note: instructions.value
        });
        await fetchBoard();
        say("보고서 배정을 저장했습니다.");
      }, control));
      form.append(layout("pr-grid", field("제출 대상", person), field("보고서 양식", type), field("제출기한 (한국시간)", due)),
        field("작성 안내", instructions), submit);
      const existing = [...new Map(items.filter(i => i.assignment_id).map(i => [i.assignment_id, i])).values()];
      const content = panel(el("h3", "보고서 양식과 제출기한"),
        el("p", "차수 공통 또는 실습생 개인에게 배정합니다. 같은 양식과 대상을 다시 저장하면 제출기한과 작성 안내가 갱신됩니다.", "pr-muted"), form);
      if (existing.length) content.append(table(["배정 대상", "보고서", "제출기한"], existing, report =>
        [report.individual ? report.person_name : "차수 전체", report.title, dateLabel(report.due_at)]));
      return content;
    }

    body.append(el("p", "제출 현황을 불러오고 있습니다.", "pr-muted"));
    run(async () => {
      try { await fetchBoard(); }
      catch (error) {
        body.replaceChildren(button("다시 불러오기", event => run(fetchBoard, event.currentTarget)));
        throw error;
      }
    });
  }
  window.EorapPracticumReview = { mount };
})();
