(() => {
  "use strict";
  const ui = window.EorapPracticum;
  const { el, layout, button, field, input, select, badge, panel, message, rpc, dateLabel, download, versionList, formatMinutes, diaryMinutes } = ui;
  const $ = id => document.getElementById(id);
  const box = $("trainee-content");
  const notice = $("trainee-notice");
  const controls = $("trainee-session");
  const main = $("trainee-main");
  const config = window.EORAPSHOW_CONFIG;
  const pages = [["today", "오늘의 실습"], ["diaries", "내 일지"], ["reports", "내 보고서"], ["feedback", "피드백"]];
  const state = { db: null, memberships: [], person: null, progress: null, page: "today", editor: null };
  const show = (...children) => {
    box.replaceChildren(...children);
    box.removeAttribute("aria-busy");
  };
  function errorText(error) {
    if (error?.status === 400 || error?.status === 422) return "이메일, 비밀번호 또는 초대 링크의 유효기간을 확인해 주세요.";
    return error?.message && /^[가-힣]/.test(error.message) ? error.message : "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  async function run(fn, node) {
    if (node) node.disabled = true;
    message(notice, "");
    try { return await fn(); }
    catch (error) { message(notice, errorText(error), true); }
    finally { if (node) node.disabled = false; }
  }
  function login() {
    controls.hidden = true;
    const email = input("email");
    email.autocomplete = "username";
    email.required = true;
    email.maxLength = 254;
    const password = input("password");
    password.autocomplete = "current-password";
    password.required = true;
    const signIn = el("button", "로그인", "pr-btn pr-primary");
    signIn.type = "submit";
    const form = el("form");
    form.append(field("실습생 이메일", email), field("비밀번호", password), signIn);
    form.addEventListener("submit", event => {
      event.preventDefault();
      run(async () => {
        const result = await state.db.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
        if (result.error) throw new Error("로그인 정보를 확인해 주세요. 비밀번호 재설정 링크는 기관 실습담당자에게 요청할 수 있습니다.");
        await connected();
      }, signIn);
    });
    const card = panel(el("h1", "실습생 로그인"),
      el("p", "처음 접속하는 경우 기관 실습담당자가 전달한 링크에서 비밀번호를 설정해 주세요.", "pr-muted"), form);
    card.classList.add("pr-start");
    show(card);
  }

  function setPassword(fromInvite) {
    const password = input("password");
    const confirm = input("password");
    [password, confirm].forEach(control => {
      control.autocomplete = "new-password";
      control.required = true;
      control.minLength = 6;
    });
    const save = el("button", "비밀번호 저장", "pr-btn pr-primary");
    save.type = "submit";
    const actions = layout("pr-row", save);
    if (!fromInvite) actions.append(button("돌아가기", () => render()));
    const form = el("form");
    form.append(field("새 비밀번호 (6자 이상)", password), field("비밀번호 확인", confirm), actions);
    form.addEventListener("submit", event => {
      event.preventDefault();
      run(async () => {
        if (password.value !== confirm.value) throw new Error("입력한 비밀번호가 서로 다릅니다.");
        const result = await state.db.auth.updateUser({ password: password.value });
        if (result.error) throw new Error("비밀번호를 저장하지 못했습니다. 6자 이상으로 확인해 주세요.");
        await connected();
        if (state.memberships.length) message(notice, "비밀번호를 저장했습니다.");
      }, save);
    });
    const card = panel(el("h1", fromInvite ? "실습생 비밀번호 설정" : "비밀번호 변경"), form);
    card.classList.add("pr-start");
    show(card);
  }

  async function connected() {
    state.memberships = await rpc(state.db, "home");
    if (!state.memberships.length) {
      await state.db.auth.signOut({ scope: "local" });
      state.person = null;
      login();
      message(notice, "이 계정에 연결된 실습 차수가 없습니다. 기관 실습담당자에게 확인해 주세요.", true);
      return;
    }
    controls.hidden = false;
    if (!state.memberships.some(member => member.id === state.person?.id)) state.person = state.memberships[0];
    await refresh();
  }

  async function refresh() {
    state.progress = await rpc(state.db, "student", { p_person: state.person.id });
    render();
  }

  function dueLabel(item, prefix) {
    const time = el("time", dateLabel(item.due_at));
    time.dateTime = item.due_at;
    if (item.day) time.dataset.diaryDay = item.day;
    const label = el("span", null, "pr-muted");
    label.append(prefix, time);
    if (item.late) label.append(" · 제출 당시 기한 후");
    return label;
  }

  let checkingDeadlines = false;
  async function syncDiaryDeadlines() {
    const person = state.person;
    const labels = box.querySelectorAll("time[data-diary-day]");
    if (document.hidden || !person || (!labels.length && !box.querySelector("#trainee-today")) || checkingDeadlines) return;
    checkingDeadlines = true;
    try {
      const current = await rpc(state.db, "student", { p_person: person.id });
      if (state.person !== person) return;
      const today = box.querySelector("#trainee-today");
      if (today) {
        const changed = JSON.stringify(state.progress) !== JSON.stringify(current);
        state.progress = current;
        if (changed) today.replaceChildren(...showToday(current.items));
        return;
      }
      const dates = new Map(current.items.filter(item => item.day).map(item => [item.day, item.due_at]));
      // Update the visible dates in place so the student's editor keeps its current input.
      box.querySelectorAll("time[data-diary-day]").forEach(time => {
        const due = dates.get(time.dataset.diaryDay);
        if (!due || time.dateTime === due) return;
        time.dateTime = due;
        time.textContent = dateLabel(due);
      });
      state.progress = current;
    } catch {
      // Retry the background refresh when the page is focused or the next interval runs.
    } finally {
      checkingDeadlines = false;
    }
  }

  function workCard(item, title) {
    const label = item.day || item.title + (item.individual ? " · 개별 배정" : "");
    const card = el("article", null, "pr-card pr-row pr-between");
    const detail = layout("", el("p", title || label, "pr-card-title"),
      dueLabel(item, "기한 "));
    const actions = layout("pr-row", badge(item.day && item.day > state.progress.today && !item.work_id ? "scheduled" : item.status));
    const writable = state.progress.can_write && (!item.day || item.day <= state.progress.today);
    if (item.work_id || writable) {
      const label = item.status === "changes" && writable ? "보완하기" :
        item.status === "draft" && writable ? "이어서 작성" : item.work_id ? "보기" : "작성";
      actions.append(button(label, event => run(() => open(item), event.currentTarget), !item.work_id));
    }
    card.append(detail, actions);
    if (item.day) card.dataset.diaryDay = item.day;
    return card;
  }

  const koreaDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  });

  function dueDays(item, today) {
    const calendarDay = koreaDate.format(new Date(item.due_at));
    return Math.round((Date.parse(calendarDay) - Date.parse(today)) / 86400000);
  }

  function urgentLabel(item, days) {
    if (Date.parse(item.due_at) < Date.now() || days < 0) return "마감 지남";
    if (days === 0) return "오늘 마감";
    return "제출까지 " + days + "일";
  }

  function showToday(items) {
    const { today, can_write: canWrite, target_minutes: target } = state.progress;
    const eligible = items.filter(item => !item.day || item.day <= today);
    const current = eligible.find(item => item.day === today);
    const corrections = canWrite ? eligible.filter(item => item.status === "changes") : [];
    const unfinished = canWrite ? eligible.filter(item => ["missing", "draft"].includes(item.status)) : [];
    const urgent = unfinished.filter(item => item !== current && dueDays(item, today) <= 2);
    const actions = [
      ...corrections.map(item => workCard(item, (item.day ? item.day + " 실습일지" : item.title) + " · 보완 요청")),
      ...(unfinished.includes(current) ? [workCard(current, "오늘 실습일지")] : []),
      ...urgent.map(item => workCard(item, (item.day ? item.day + " 실습일지" : item.title) +
        " · " + urgentLabel(item, dueDays(item, today))))
    ];
    const confirmed = eligible.filter(item => item.day && item.status === "reviewed")
      .reduce((total, item) => total + (item.minutes ?? 0), 0);
    const awaiting = eligible.filter(item => item.day && item.status === "submitted")
      .reduce((total, item) => total + (item.minutes ?? 0), 0);
    const time = panel(el("h2", "내 실습시간"), el("p", "확인 " + formatMinutes(confirmed) +
      " / 목표 " + formatMinutes(target), "pr-time-total"));
    const meter = el("progress", null, "pr-time-meter");
    meter.max = target;
    meter.value = Math.min(confirmed, target);
    meter.setAttribute("aria-label", "목표 대비 확인된 실습시간");
    time.append(meter);
    if (awaiting) time.append(el("p", "검토 대기 " + formatMinutes(awaiting), "pr-muted"));
    const stats = [
      ["일지 제출", eligible.filter(i => i.day && i.version > 0).length + " / " + eligible.filter(i => i.day).length + "일"],
      ["보고서 제출", eligible.filter(i => !i.day && i.version > 0).length + " / " + eligible.filter(i => !i.day).length + "건"],
      ["보완 요청", eligible.filter(i => i.status === "changes").length + "건"]
    ];
    const future = unfinished.filter(item => !item.day && !urgent.includes(item)).slice(0, 4);
    return [
      panel(el("h2", "지금 할 일"), ...(actions.length ? actions : [el("p", "지금 처리할 제출·보완 항목이 없습니다.", "pr-muted")])),
      ...(current && !actions.some(card => card.dataset.diaryDay === today)
        ? [panel(el("h2", "오늘의 실습일지"), workCard(current))] : []),
      time,
      panel(el("h2", "내 작성 현황"), layout("pr-grid", ...stats.map(([title, value]) =>
        layout("pr-stat", el("span", title), el("strong", value))))),
      ...(future.length ? [panel(el("h2", "예정된 보고서"), ...future.map(item => workCard(item)))] : [])
    ];
  }

  function showWorkList(items, kind, empty) {
    const list = items.filter(kind);
    return panel(...(list.length ? list.map(item => workCard(item)) : [el("p", empty, "pr-muted")]));
  }

  function render() {
    const { person, page, progress } = state;
    if (!person || !progress) return;
    const nav = el("nav", null, "pr-row pr-nav");
    nav.setAttribute("aria-label", "실습생 메뉴");
    pages.forEach(([key, title]) => {
      const tab = button(title, () => {
        state.page = key;
        message(notice, "");
        render();
        main.focus();
        syncDiaryDeadlines();
      }, page === key);
      if (page === key) tab.setAttribute("aria-current", "page");
      nav.append(tab);
    });
    const title = layout("", el("h1", pages.find(([key]) => key === page)[1]),
      el("p", [person.name, person.institution, person.cohort].join(" · "), "pr-muted"));
    if (state.memberships.length > 1) {
      const group = select(state.memberships.map(m => [m.id, m.institution + " · " + m.cohort]), person.id);
      group.addEventListener("change", () => run(async () => {
        const next = state.memberships.find(m => m.id === group.value);
        const nextProgress = await rpc(state.db, "student", { p_person: next.id });
        state.person = next;
        state.progress = nextProgress;
        render();
      }, group));
      title.append(field("실습 차수", group));
    }
    const views = {
      today: () => {
        const today = layout("", ...showToday(progress.items));
        today.id = "trainee-today";
        return [today];
      },
      diaries: () => [showWorkList(progress.items, i => i.day, "등록된 실습일이 없습니다.")],
      reports: () => [showWorkList(progress.items, i => !i.day, "배정된 보고서가 없습니다.")],
      feedback: () => [showWorkList(progress.items, i => i.status === "changes" || i.status === "reviewed" ||
        (i.status === "submitted" && i.version > 1), "받은 검토 의견이 없습니다.")]
    };
    show(title, nav, ...views[page]());
  }

  async function open(row) {
    const work = row.work_id ? await rpc(state.db, "item", { p_work: row.work_id }) : await rpc(state.db, "open", {
      p_person: state.person.id, p_day: row.day, p_assignment: row.assignment_id
    });
    drawWork(work);
    main.focus();
  }

  function drawWork(work) {
    const back = button("목록으로", event => run(async () => {
      if (state.editor) await state.editor.flush();
      await refresh();
      state.editor = null;
      main.focus();
    }, event.currentTarget));
    const head = layout("pr-row pr-between", el("h1", work.title + (work.day ? " · " + work.day : "")), back);
    const context = layout("pr-row", badge(work.status), dueLabel(work, "제출기한 "));
    const header = panel(head, context);
    if (work.instructions) header.append(el("p", work.instructions, "pr-note pr-safe-text"));
    const versions = versionList(state.db, work, notice, state.person);
    if (!work.can_write) {
      state.editor = null;
      show(header, panel(versions));
      return;
    }
    const editable = editor(work);
    show(header, editable, ...(work.versions.length ? [panel(versions)] : []));
  }

  function editor(work) {
    const db = state.db;
    let revision = work.revision;
    let attachment = work.attachment_key ? { key: work.attachment_key, name: work.attachment_name } : null;
    let changed = 0;
    let saved = 0;
    let uploading = false;
    let submitting = false;
    let timer;
    let queue = Promise.resolve();
    const status = el("p", "입력하면 서버에 자동 저장됩니다.", "pr-muted");
    status.setAttribute("role", "status");
    const form = el("form");
    const inputs = el("fieldset");
    inputs.style.cssText = "border:0;padding:0;margin:0;min-width:0";
    const controls = new Map();
    const attachmentBox = layout("pr-row");
    const hint = el("p", "이용자와 청소년의 이름·연락처 등 개인을 식별할 수 있는 정보는 입력하지 마세요.", "pr-note");
    function save(isSubmit = false) {
      clearTimeout(timer);
      const operation = queue.then(async () => {
        if (!isSubmit && changed === saved) return;
        const version = changed;
        status.textContent = isSubmit ? "제출 중…" : "자동 저장 중…";
        const result = await rpc(db, "save", {
          p_work: work.id, p_revision: revision,
          p_body: Object.fromEntries([...controls].map(([key, control]) => [key, control.value])),
          p_file_key: attachment?.key || null, p_file_name: attachment?.name || null, p_submit: isSubmit
        });
        revision = result.revision;
        saved = version;
        status.textContent = isSubmit ? "제출 완료" : "저장됨 · " + dateLabel(result.saved_at);
        return result;
      });
      queue = operation.catch(error => {
        status.textContent = errorText(error) + " · 입력 내용이 화면에 남아 있습니다.";
      });
      return operation;
    }
    function markChanged() {
      changed += 1;
      status.textContent = "저장 대기 중…";
      clearTimeout(timer);
      timer = setTimeout(() => save().catch(() => {}), 900);
    }
    function timeValues() {
      return ["start_time", "end_time", "break_minutes"].map(key => controls.get(key)?.value || "");
    }
    if (work.day) {
      const timeInputs = [
        ["start_time", "시작 시각", input("time", work.draft.start_time || "")],
        ["end_time", "종료 시각", input("time", work.draft.end_time || "")],
        ["break_minutes", "휴게시간 (분)", input("number", work.draft.break_minutes ?? "0")]
      ];
      const rest = timeInputs[2][2];
      rest.min = "0";
      rest.step = "1";
      const total = el("p", null, "pr-note");
      total.setAttribute("role", "status");
      const showDuration = () => {
        const minutes = diaryMinutes(...timeValues());
        total.textContent = minutes == null
          ? "시작·종료 시각을 입력하면 휴게시간을 빼고 계산합니다."
          : "당일 실습시간 " + formatMinutes(minutes);
      };
      const fields = timeInputs.map(([key, label, control]) => {
        controls.set(key, control);
        control.addEventListener("input", () => {
          showDuration();
          markChanged();
        });
        return field(label, control);
      });
      showDuration();
      inputs.append(el("h3", "실습시간"), layout("pr-grid", ...fields), total);
    }
    work.fields.forEach(def => {
      const area = el("textarea");
      area.value = work.draft[def.key] || "";
      area.maxLength = 24000;
      area.addEventListener("input", markChanged);
      controls.set(def.key, area);
      inputs.append(field(def.label + (def.required ? " *" : ""), area));
    });
    if (!work.day) {
      const upload = input("file");
      upload.accept = ".pdf,application/pdf";
      function renderAttachment() {
        const current = attachment;
        attachmentBox.replaceChildren();
        if (!current) return;
        attachmentBox.append(el("span", current.name, "pr-muted"),
          button("내려받기", event => run(() => download(db, current.key, current.name), event.currentTarget)),
          button("첨부 제거", () => {
            attachment = null;
            renderAttachment();
            markChanged();
          }));
      }
      upload.addEventListener("change", () => {
        const file = upload.files[0];
        if (!file) return;
        run(async () => {
          uploading = true;
          inputs.disabled = true;
          try {
            if (file.size > 10485760 || new TextDecoder().decode(await file.slice(0, 5).arrayBuffer()) !== "%PDF-")
              throw new Error("10MB 이하 PDF 파일을 선택해 주세요.");
            await save();
            status.textContent = "PDF를 올리고 있습니다…";
            const path = work.person_id + "/" + work.id + "/" + crypto.randomUUID() + ".pdf";
            const { error } = await db.storage.from("practicum-submissions").upload(path, file, {
              contentType: "application/pdf", upsert: false
            });
            if (error) throw new Error("PDF를 올리지 못했습니다. 다시 시도해 주세요.");
            attachment = { key: path, name: file.name.slice(0, 180) };
            renderAttachment();
            changed += 1;
          } finally {
            uploading = false;
            inputs.disabled = false;
            upload.value = "";
          }
          await save();
        }, upload);
      });
      inputs.append(el("p", "웹에서 본문을 작성하거나 보고서 PDF를 첨부해 제출할 수 있습니다. PDF는 최대 10MB입니다.", "pr-muted"),
        field("보고서 PDF 첨부", upload), attachmentBox);
      renderAttachment();
    }
    const manualSave = button("임시저장", event => run(() => save(), event.currentTarget));
    const submit = el("button", work.status === "changes" ? "보완본 제출" : "제출하기", "pr-btn pr-primary");
    submit.type = "submit";
    inputs.append(layout("pr-row", manualSave, submit));
    form.append(inputs, status);
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (submitting || uploading) return;
      if (!attachment) {
        const empty = work.fields.find(def => def.required && !controls.get(def.key).value.trim());
        if (empty) {
          message(notice, empty.label + " 항목을 작성해 주세요.", true);
          controls.get(empty.key).focus();
          return;
        }
      }
      if (work.day) {
        const [start, end, rest] = timeValues();
        if ((start || end || (rest && rest !== "0")) && diaryMinutes(start, end, rest) == null) {
          message(notice, "시작·종료 시각과 휴게시간을 확인해 주세요.", true);
          controls.get("start_time").focus();
          return;
        }
      }
      if (!window.confirm("현재 내용을 제출하시겠습니까? 지도자가 이 제출본을 확인할 수 있습니다.")) return;
      run(async () => {
        submitting = true;
        inputs.disabled = true;
        try {
          await save(true);
          const result = await rpc(db, "item", { p_work: work.id });
          drawWork(result);
          main.focus();
          message(notice, "제출했습니다. 검토 결과는 피드백에서 확인할 수 있습니다.");
        } finally {
          submitting = false;
          inputs.disabled = false;
        }
      });
    });
    state.editor = {
      flush: () => uploading || submitting ? Promise.reject(new Error("첨부 또는 제출 처리 중입니다.")) : save(),
      dirty: () => uploading || submitting || changed !== saved
    };
    return panel(el("h2", work.status === "changes" ? "보완본 작성" : "본문 작성"), hint, form);
  }

  $("trainee-logout").addEventListener("click", event => run(async () => {
    if (state.editor) await state.editor.flush();
    const result = await state.db.auth.signOut({ scope: "local" });
    if (result.error) throw result.error;
    Object.assign(state, { editor: null, person: null, progress: null, memberships: [], page: "today" });
    login();
  }, event.currentTarget));
  $("trainee-password").addEventListener("click", event => run(async () => {
    if (state.editor) await state.editor.flush();
    state.editor = null;
    setPassword(false);
  }, event.currentTarget));
  window.addEventListener("beforeunload", event => {
    if (!state.editor?.dirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  document.addEventListener("visibilitychange", syncDiaryDeadlines);
  window.addEventListener("focus", syncDiaryDeadlines);
  window.setInterval(syncDiaryDeadlines, 60000);

  async function start() {
    if (!config?.url || !config?.publishableKey || !window.supabase) {
      show(panel(el("h1", "실습 서버 연결 확인"), el("p", "실습생 공간을 불러오지 못했습니다. 새로고침해 주세요.")));
      return;
    }
    state.db = window.supabase.createClient(config.url, config.publishableKey, {
      auth: { storageKey: "eorapshow-trainee-session", detectSessionInUrl: false }
    });
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get("token_hash");
    const type = hash.get("type");
    if (token) {
      history.replaceState(null, "", location.pathname + location.search);
      const result = ["invite", "magiclink"].includes(type)
        ? await state.db.auth.verifyOtp({ token_hash: token, type }) : { error: true };
      if (result.error || !result.data?.session) {
        login();
        message(notice, "초대 링크를 확인할 수 없습니다. 다시 발급받거나 이미 등록한 비밀번호로 로그인해 주세요.", true);
        return;
      }
      state.memberships = await rpc(state.db, "home");
      if (!state.memberships.length) {
        await connected();
        return;
      }
      setPassword(true);
      return;
    }
    const { data } = await state.db.auth.getUser();
    if (data.user) await connected();
    else login();
  }
  start().catch(error => {
    login();
    message(notice, errorText(error), true);
  });
})();
