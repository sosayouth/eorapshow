(() => {
  "use strict";
  const { el, layout, button, field, input, select, badge, panel, message, rpc, dateLabel, versionList, printBundle } = window.EorapPracticum;
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

  const cohortFields = "id,institution_id,year,name,start_date,end_date,target_hours";

  function cohortForm({ centers, institution, record, label, onSave }) {
    const center = select(centers, institution);
    center.disabled = !!record;
    const name = input("text", record?.name || "");
    name.required = true;
    name.maxLength = 80;
    const start = input("date", record?.start_date || "");
    const end = input("date", record?.end_date || "");
    start.required = end.required = !record;
    const hours = input("number", String(record?.target_hours ?? 130));
    hours.min = "1";
    hours.step = "1";
    hours.required = true;
    const { form, submit } = formSubmit(label, control => onSave({
      institution_id: record?.institution_id || center.value,
      year: record?.year ?? Number(start.value.slice(0, 4)), name: name.value.trim(),
      start_date: start.value || null, end_date: end.value || null, target_hours: hours.valueAsNumber
    }, control));
    form.append(layout("pr-grid", field("기관", center), field("차수명", name),
      field("시작일", start), field("종료일", end), field("목표 실습시간 (시간)", hours)), submit);
    return form;
  }

  async function saveCohort(db, values, record) {
    if (!values.institution_id || !values.name || (!record && (!values.start_date || !values.end_date)) ||
      (values.start_date && values.end_date && values.start_date > values.end_date) ||
      !Number.isInteger(values.target_hours) || values.target_hours < 1) {
      throw new Error("기관, 차수명, 실습기간과 목표시간을 확인해 주세요.");
    }
    const records = db.from("cohorts");
    const action = record ? records.update(values).eq("id", record.id) : records.insert(values);
    const { data, error } = await action.select(cohortFields).single();
    if (error?.code === "23505") throw new Error("같은 기관과 연도에 같은 이름의 차수가 있습니다. 차수 목록에서 해당 차수를 선택해 주세요.");
    if (error || !data) throw new Error("차수를 저장하지 못했습니다. 기관과 기간을 확인해 주세요.");
    return data;
  }

  function create({ db, box, centers, institution, onBack }) {
    const notice = el("p");
    notice.hidden = true;
    const form = cohortForm({
      centers, institution, label: "차수 만들기", onSave: async (values, control) => {
        control.disabled = true;
        message(notice, "");
        try {
          const data = await saveCohort(db, values);
          mount({ db, box, cohort: data, onBack, centers, initialTab: "prepare" });
        } catch (error) { message(notice, error.message, true); }
        finally { control.disabled = false; }
      }
    });
    box.replaceChildren(layout("pr-app",
      layout("pr-row pr-between", el("h2", "차수 개설·초대"), button("차수 목록", onBack)), notice,
      panel(el("h3", "차수와 실습기간"), form)));
  }

  function parseRoster(value) {
    return value.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      const columns = line.includes("\t") ? line.split("\t") :
        line.includes(",") ? line.split(",") : line.trim().match(/^(.+?)\s+(\S+)$/)?.slice(1);
      const [name, email] = (columns || []).map(cell => cell.trim());
      if (/^(이름|성명)$/.test(name) && /^이메일(?:\s*주소)?$/.test(email)) return [];
      if (columns?.length !== 2 || !name || name.length > 80 ||
        !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error((index + 1) + "번째 줄에 이름과 이메일을 입력해 주세요.");
      return [{ name, email: email.toLowerCase() }];
    });
  }

  function mount({ db, box, cohort, onBack, centers = [], initialTab = "progress" }) {
    const notice = el("p");
    notice.hidden = true;
    const body = el("div");
    const heading = el("h2");
    const root = layout("pr-app", layout("pr-row pr-between", heading,
      button("차수 목록", onBack)), notice, body);
    box.replaceChildren(root);
    const state = {
      board: null, tab: initialTab, learner: "", kind: "", filter: "", page: 0,
      link: null, calendarDates: "", rosterText: "", invitee: "",
      rosterMode: "direct", rosterProfile: null, profileRequest: null
    };
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
      if (state.board.can_manage) tabs.push(["prepare", "차수 준비"], ["access", "실습생 계정"],
        ["calendar", "실습일 설정"], ["reports", "보고서 배정"]);
      if (!tabs.some(([key]) => key === state.tab)) state.tab = "progress";
      heading.textContent = cohort.name + (state.tab === "prepare" ? " · 차수 준비" : " · 제출 검토");
      const nav = el("nav", null, "pr-row pr-nav");
      nav.setAttribute("aria-label", "실습 차수 제출 관리");
      tabs.forEach(([key, title]) => {
        const item = button(title, () => {
          state.tab = key;
          state.link = null;
          state.rosterProfile = null;
          state.profileRequest = null;
          say("");
          render();
        }, state.tab === key);
        if (state.tab === key) item.setAttribute("aria-current", "page");
        nav.append(item);
      });
      const view = { progress, prepare, access, calendar, reports }[state.tab];
      body.replaceChildren(nav, view());
    }

    function prepare() {
      const centerName = centers.find(([id]) => id === cohort.institution_id)?.[1] || cohort.institution_id;
      const available = [[cohort.institution_id, centerName]];
      const period = cohortForm({
        centers: available, institution: cohort.institution_id, record: cohort, label: "차수 저장",
        onSave: (values, control) => run(async () => {
          if (state.board.days.some(date => !date.cancelled &&
            ((values.start_date && date.day < values.start_date) || (values.end_date && date.day > values.end_date))))
            throw new Error("기간을 변경하려면 차수 밖에 남는 실습일을 먼저 조정해 주세요.");
          cohort = await saveCohort(db, values, cohort);
          await fetchBoard();
          say("차수와 목표 실습시간을 저장했습니다.");
        }, control)
      });
      return layout("", panel(el("h3", "차수와 실습기간"), period), calendar(), reports(), access());
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
      if (state.learner && items.some(item => item.person_id === state.learner && item.can_review)) {
        content.append(layout("pr-row pr-print-actions", button("일지·보고서 모아 인쇄", event => run(async () => {
          say("선택한 실습생의 제출본과 첨부 PDF를 준비하고 있습니다.");
          const entries = await rpc(db, "print_bundle", { p_person: state.learner });
          const omitted = await printBundle(db, entries, cohort);
          say(omitted.length ? "첨부 PDF " + omitted.length + "건을 불러오지 못했습니다. 제출 이력에서 원본을 내려받아 주세요."
            : "제출본을 날짜순으로 묶었습니다. 인쇄 또는 PDF로 저장해 주세요.", omitted.length > 0);
        }, event.currentTarget))));
      }
      if (!matching.length) {
        content.append(el("p", roster.length
          ? "조회 조건에 해당하는 항목이 없습니다." : canManage
            ? "이 차수에 실습생이 없습니다. ‘차수 준비’에서 명단을 등록해 주세요."
            : "이 차수에 배정된 실습생이 없습니다.", "pr-muted"));
        return content;
      }
      content.append(table(["실습생", "일지·보고서", "기한", "상태", "제출본"], shown, item => [
        item.person_name,
        item.day ? item.day + " 일지" : item.title + (item.individual ? " · 개별" : ""),
        dateLabel(item.due_at),
        layout("pr-row", badge(rowStatus(item, today)), ...(item.late ? [el("small", "제출 당시 기한 후")] : [])),
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
      body.replaceChildren(overview, panel(versionList(db, item, notice, cohort)));
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

    async function registerStudents(rows, reviewer) {
      const result = await rpc(db, "register_roster", { p_cohort: cohort.id, p_reviewer: reviewer, p_rows: rows });
      state.rosterText = "";
      await fetchBoard();
      say(result.added + "명을 등록했습니다. 기존 등록 " + result.existing + "명은 건너뛰었습니다. 명단에서 초대할 실습생을 선택해 주세요.");
    }

    function registrationPanel(roster, reviewers) {
      const modes = [["direct", "직접 입력"], ["excel", "엑셀 업로드"], ["paste", "명단 붙여넣기"]];
      const modeBar = layout("pr-row");
      modes.forEach(([key, title]) => {
        const tab = button(title, () => {
          state.rosterMode = key;
          state.rosterProfile = null;
          state.profileRequest = null;
          say("");
          render();
        }, state.rosterMode === key);
        tab.setAttribute("aria-pressed", String(state.rosterMode === key));
        modeBar.append(tab);
      });
      const { directForm, excelForm } = window.EorapPracticumRoster;
      let form;
      if (state.rosterMode === "excel") {
        form = excelForm({ cohort, reviewers, people: roster, today: state.board.today, table, run, save: registerStudents });
      } else if (state.rosterMode === "paste") {
        form = rosterForm(reviewers);
      } else {
        form = directForm({
          today: state.board.today, profile: state.rosterProfile, reviewers, run,
          cancel: () => {
            state.rosterProfile = null;
            state.profileRequest = null;
            render();
          },
          save: async (values, reviewer, profile) => {
            if (!profile) {
              await registerStudents([values], reviewer);
              return;
            }
            await rpc(db, "update_roster_profile", {
              p_cohort: cohort.id, p_person: profile.person_id, p_reviewer: reviewer, p_profile: values
            });
            state.rosterProfile = null;
            state.profileRequest = null;
            await fetchBoard();
            say("기본정보를 저장했습니다.");
          }
        });
      }
      const region = layout("pr-roster-registration", el("h3", "실습생 등록·기본정보"), modeBar, form);
      region.id = "pr-roster-registration";
      region.tabIndex = -1;
      return region;
    }

    async function editProfile(person) {
      const request = { person: person.id };
      state.profileRequest = request;
      const profile = await rpc(db, "roster_profile", { p_cohort: cohort.id, p_person: person.id });
      if (state.profileRequest !== request) return;
      state.rosterProfile = profile;
      state.rosterMode = "direct";
      render();
      body.querySelector("#pr-roster-registration")?.focus();
    }

    function rosterForm(reviewers) {
      const area = el("textarea");
      area.value = state.rosterText;
      area.required = true;
      area.placeholder = "김실습, trainee@example.com";
      area.addEventListener("input", () => { state.rosterText = area.value; });
      const choices = reviewers.length === 1 ? [] : [["", "선택"]];
      const reviewer = select([...choices, ...reviewers.map(row => [row.id, row.label])]);
      reviewer.required = true;
      const { form, submit } = formSubmit("명단 등록", control => run(async () => {
        const rows = parseRoster(area.value);
        if (!rows.length) throw new Error("등록할 실습생 명단을 입력해 주세요.");
        await registerStudents(rows, reviewer.value);
      }, control));
      form.append(el("h4", "실습생 명단 등록"),
        el("p", "이름과 개인·학교 이메일을 한 줄에 한 명씩 입력하거나 두 열을 복사해 붙여넣으세요.", "pr-muted"),
        field("명단 붙여넣기", area), field("실습지도자", reviewer), submit);
      return form;
    }

    function access() {
      const { roster, reviewers } = state.board;
      const content = panel(el("h3", "실습생 계정과 지도자"),
        el("p", "개인 또는 학교 이메일로 링크를 발급해 해당 실습생에게 직접 전달합니다. 재발급 링크에서도 비밀번호를 설정할 수 있습니다.", "pr-muted"));
      if (reviewers.length || state.rosterProfile) content.append(registrationPanel(roster, reviewers));
      else content.append(el("p", "사용자·권한에서 같은 기관의 실습지도자 또는 기관관리자를 활성화해 주세요.", "pr-note"));
      if (!roster.length) return content;
      content.append(table(["실습생", "연결 이메일", "지도자", "접속 상태", "기본정보"], roster, person => [
        person.name, person.email, person.reviewer_name || reviewers.find(r => r.id === person.reviewer_id)?.label, badge(person.account),
        button("기본정보 수정", event => run(() => editProfile(person), event.currentTarget))
      ]));
      const available = roster.filter(p => p.practice_status !== "completed");
      if (!available.length || !reviewers.length) {
        if (reviewers.length) content.append(el("p", "초대할 수 있는 진행 중·예정 실습생이 없습니다.", "pr-note"));
        return content;
      }
      const person = select(available.map(p => [p.id, p.name]), state.link?.person || state.invitee);
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
        state.invitee = person.value;
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
      const { days, diary_deadline: deadline } = state.board;
      const dates = el("textarea");
      dates.required = true;
      dates.placeholder = "YYYY-MM-DD";
      dates.value = state.calendarDates;
      const delay = input("number", String(deadline.delay_days));
      delay.required = true;
      delay.min = "0";
      delay.step = "1";
      const time = input("time", deadline.cutoff.slice(0, 5));
      time.required = true;

      const toDates = () => [...new Set(dates.value.trim().split(/[\s,]+/).filter(Boolean))];
      const saveDates = (cancel, control) => run(async () => {
        const listed = toDates();
        if (!listed.length || listed.length > 150 || listed.some(value => !/^\d{4}-\d{2}-\d{2}$/.test(value)))
          throw new Error("실습일을 YYYY-MM-DD 형식으로 최대 150개까지 입력해 주세요.");
        await rpc(db, "set_days", { p_cohort: cohort.id, p_dates: listed, p_time: null, p_cancel: cancel });
        state.calendarDates = "";
        await fetchBoard();
        say(cancel ? "선택한 실습일을 취소했습니다." : "실습일을 저장했습니다. 각 날짜에 이 차수의 일지 마감 기준을 적용했습니다.");
      }, control);
      const { form: dateForm, submit: dateSubmit } = formSubmit("실습일 저장", control => saveDates(false, control));

      function fillDates(firstWeekday, lastWeekday) {
        const first = new Date(cohort.start_date + "T00:00:00Z");
        const last = new Date(cohort.end_date + "T00:00:00Z");
        if (!Number.isFinite(first.valueOf()) || !Number.isFinite(last.valueOf()) || first > last) {
          say("차수의 시작일과 종료일을 확인하거나 실습일을 직접 입력해 주세요.", true);
          return;
        }
        const values = [];
        for (const day = first; day <= last && values.length <= 150; day.setUTCDate(day.getUTCDate() + 1)) {
          const weekday = day.getUTCDay();
          if (weekday >= firstWeekday && weekday <= lastWeekday) values.push(day.toISOString().slice(0, 10));
        }
        if (values.length > 150) {
          say("실습일이 150개를 넘습니다. 기간을 나눠 날짜를 입력해 주세요.", true);
          return;
        }
        dates.value = state.calendarDates = values.join("\n");
        say(values.length
          ? "실습일 " + values.length + "개를 채웠습니다. 실제 휴무일을 목록에서 조정한 뒤 저장해 주세요."
          : "차수 기간에 선택한 요일의 날짜가 없습니다.");
      }
      dates.addEventListener("input", () => { state.calendarDates = dates.value; });
      const fill = layout("pr-row", button("차수 화~토 채우기", () => fillDates(2, 6)),
        button("차수 월~금 채우기", () => fillDates(1, 5)));
      fill.hidden = !cohort.start_date || !cohort.end_date;
      dateForm.append(fill, field("실습 날짜 (한 줄에 하나)", dates),
        layout("pr-row", dateSubmit, button("입력한 실습일 취소", event => saveDates(true, event.currentTarget))));

      const { form: deadlineForm, submit: deadlineSubmit } = formSubmit("마감 기준 저장", control => run(async () => {
        const delayDays = delay.valueAsNumber;
        if (!Number.isInteger(delayDays) || delayDays < 0 || !time.value)
          throw new Error("마감 일수와 시각을 입력해 주세요. 당일 마감은 0일입니다.");
        await rpc(db, "set_diary_deadline", { p_cohort: cohort.id, p_delay_days: delayDays, p_cutoff: time.value });
        await fetchBoard();
        say("일지 마감 기준을 저장했습니다. 이 차수에 등록된 실습일의 마감이 갱신됐습니다.");
      }, control));
      deadlineForm.append(layout("pr-grid", field("실습일로부터 며칠 뒤", delay),
        field("일지 마감 시각 (한국시간)", time)), deadlineSubmit);

      const schedule = panel(el("h3", "실습일 등록"),
        el("p", "센터 운영일인 화~토요일을 기준으로 채우거나, 실제 일정을 직접 입력할 수 있습니다.", "pr-muted"), dateForm);
      const settings = panel(el("h3", "일지 마감 기준"),
        el("p", "기본은 실습일 7일 뒤 오후 6시입니다. 0일은 실습일 당일을 뜻합니다. 기준을 바꾸면 이 차수에 등록된 실습일에도 적용됩니다.", "pr-muted"),
        deadlineForm);
      const content = layout("", schedule, settings);
      if (days.length) {
        const detail = el("details", null, "pr-detail");
        detail.append(el("summary", "등록한 실습일 " + days.length + "개"),
          table(["실습일", "일지 마감", "상태"], days, day => [day.day, dateLabel(day.due_at), day.cancelled ? "취소" : "등록"]));
        content.append(panel(detail));
      }
      return content;
    }

    function reports() {
      const { roster, templates, today, assignments } = state.board;
      const person = select([["", "차수 전체"], ...roster.map(p => [p.id, p.name])]);
      const type = select(templates.map(t => [t.code, t.title]));
      const due = input("datetime-local", (cohort.end_date || today) + "T18:00");
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
      const content = panel(el("h3", "보고서 양식과 제출기한"),
        el("p", "차수 공통 또는 실습생 개인에게 배정합니다. 같은 양식과 대상을 다시 저장하면 제출기한과 작성 안내가 갱신됩니다.", "pr-muted"), form);
      if (assignments.length) content.append(table(["배정 대상", "보고서", "제출기한"], assignments, report =>
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
  window.EorapPracticumReview = { mount, create };
})();
