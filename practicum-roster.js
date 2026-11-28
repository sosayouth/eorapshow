(() => {
  "use strict";
  const { el, layout, button, field, input, select } = window.EorapPracticum;

  const columns = [
    ["name", "성명", ["이름", "실습생성명", "실습생이름"]],
    ["birth_date", "생년월일", ["출생일", "생일"]],
    ["gender", "성별", ["남녀"]],
    ["email", "이메일 연락처", ["이메일", "이메일주소", "전자우편", "email", "e-mail"]],
    ["mobile", "휴대전화 연락처", ["휴대전화", "휴대전화번호", "휴대폰", "휴대폰번호", "휴대폰연락처",
      "핸드폰", "핸드폰연락처", "핸드폰번호", "전화번호", "연락처", "mobile", "phone"]]
  ];
  const genderLabels = { male: "남", female: "여", other: "기타" };
  const genderAliases = new Map([
    ["남", "male"], ["남자", "male"], ["남성", "male"], ["m", "male"], ["male", "male"],
    ["여", "female"], ["여자", "female"], ["여성", "female"], ["f", "female"], ["female", "female"],
    ["기타", "other"], ["other", "other"]
  ]);
  const normalizeHeader = value => String(value).replace(/[\s._-]/g, "").toLowerCase();
  const headerKeys = new Map(columns.flatMap(([key, label, aliases]) =>
    [label, ...aliases].map(name => [normalizeHeader(name), key])));
  const text = value => String(value ?? "").trim();
  const optional = value => ["-", "미기재"].includes(text(value)) ? "" : text(value);

  function isoDate(y, m, d) {
    return String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function birthday(value, parseSerial) {
    const raw = optional(value);
    if (!raw) return null;
    const parts = raw.match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?$/)
      || raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (parts) return isoDate(...parts.slice(1));
    if (typeof value !== "number" || !Number.isInteger(value) || !parseSerial) return null;
    const decoded = parseSerial(value);
    return decoded ? isoDate(decoded.y, decoded.m, decoded.d) : null;
  }

  function validate(raw, today, parseSerial) {
    const name = text(raw.name);
    const email = text(raw.email).toLowerCase();
    const birthdayText = optional(raw.birth_date);
    const birth_date = birthday(raw.birth_date, parseSerial);
    const sex = optional(raw.gender).toLowerCase();
    const gender = genderAliases.get(sex) ?? null;
    let mobile = optional(raw.mobile).replace(/[\s().-]/g, "");
    if (/^1[016789]\d{7,8}$/.test(mobile)) mobile = "0" + mobile;
    const issues = [];
    if (!name || [...name].length > 80) issues.push("성명을 확인해 주세요.");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith("@bwyf.or.kr"))
      issues.push("실습생의 개인·학교 이메일을 확인해 주세요.");
    if (birthdayText) {
      const date = new Date(birth_date + "T00:00:00Z");
      if (!birth_date || birth_date.startsWith("0000-") || !Number.isFinite(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== birth_date || birth_date > today)
        issues.push("생년월일을 확인해 주세요.");
    }
    if (sex && !gender) issues.push("성별은 남, 여, 기타 또는 미기재로 입력해 주세요.");
    if (mobile && !/^\+?\d{7,15}$/.test(mobile)) issues.push("휴대전화 연락처를 확인해 주세요.");
    return { entry: { name, birth_date, gender, email, mobile: mobile || null }, issues };
  }

  async function excelLibrary() {
    try {
      return await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
    } catch {
      throw new Error("엑셀 파일을 열기 위한 모듈을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.");
    }
  }

  function sheetRows(XLSX, sheet, today, parseSerial) {
    const rows = new Map();
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith("!") || !text(cell.v)) continue;
      const {r, c} = XLSX.utils.decode_cell(address);
      if (!rows.has(r)) rows.set(r, new Map());
      rows.get(r).set(c, cell.v);
    }
    const sorted = [...rows].sort(([a],[b]) => a - b);
    for (const [headerRow, cells] of sorted) {
      const mapped = [...cells].map(([column, value]) => [headerKeys.get(normalizeHeader(value)), column])
        .filter(([key]) => key);
      const keys = new Map(mapped);
      if (!keys.has("name") || !keys.has("email")) continue;
      if (keys.size !== mapped.length)
        throw new Error("같은 항목의 열이 두 개 이상 있습니다. 머리글을 확인해 주세요.");
      return sorted.filter(([index, values]) =>
        index > headerRow && [...keys.values()].some(column => text(values.get(column))))
        .map(([index, values]) => {
          const raw = Object.fromEntries([...keys].map(([key, column]) => [key, values.get(column)]));
          return { row: index + 1, raw, ...validate(raw, today, parseSerial) };
        });
    }
    return null;
  }

  async function readWorkbook(file, today) {
    if (!/\.xlsx$/i.test(file.name)) throw new Error("엑셀 .xlsx 파일을 선택해 주세요.");
    const XLSX = await excelLibrary();
    let book;
    try {
      book = XLSX.read(await file.arrayBuffer(), { type: "array", cellFormula: false, cellHTML: false });
    } catch {
      throw new Error("엑셀 파일을 열지 못했습니다. 열림 암호가 없는 .xlsx 파일인지 확인해 주세요.");
    }
    const parseSerial = value => XLSX.SSF.parse_date_code(value, { date1904: !!book.Workbook?.WBProps?.date1904 });
    const sheets = book.SheetNames.flatMap((name, index) => {
      if (book.Workbook?.Sheets?.[index]?.Hidden || !book.Sheets[name]) return [];
      try { return [{ name, rows: sheetRows(XLSX, book.Sheets[name], today, parseSerial) }]; }
      catch (error) { return [{ name, rows: null, error: error.message }]; }
    });
    if (!sheets.length) throw new Error("엑셀 파일에서 표시된 시트를 찾을 수 없습니다.");
    return sheets;
  }

  async function downloadTemplate() {
    const XLSX = await excelLibrary();
    const file = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([columns.map(([, label]) => label)]);
    sheet["!cols"] = [18, 17, 12, 33, 24].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(file, sheet, "실습생 명단");
    XLSX.writeFileXLSX(file, "어랍쇼_실습생_일괄등록_양식.xlsx");
  }

  function reviewerInput(reviewers) {
    const options = reviewers.length === 1 ? [] : [["", "선택"]];
    const control = select([...options, ...reviewers.map(row => [row.id, row.label])]);
    control.required = true;
    return control;
  }

  function submitForm(title, action) {
    const form = el("form");
    const submit = el("button", title, "pr-btn pr-primary");
    submit.type = "submit";
    form.addEventListener("submit", event => {
      event.preventDefault();
      action(submit);
    });
    return { form, submit };
  }

  function directForm({ today, profile, reviewers, run, save, cancel }) {
    const name = input("text", profile?.name ?? "");
    name.maxLength = 80;
    name.required = true;
    const birth = input("date", profile?.birth_date ?? "");
    birth.max = today;
    const gender = select([["", "미기재"], ...Object.entries(genderLabels)], profile?.gender ?? "");
    const email = input("email", profile?.email ?? "");
    email.required = true;
    email.maxLength = 254;
    email.readOnly = !!profile?.email_locked;
    const mobile = input("tel", profile?.mobile ?? "");
    mobile.maxLength = 30;
    const reviewer = profile?.has_member ? null : reviewerInput(reviewers);
    const { form, submit } = submitForm(profile ? "기본정보 저장" : "실습생 등록", control => run(async () => {
      const result = validate({ name: name.value, birth_date: birth.value, gender: gender.value,
        email: email.value, mobile: mobile.value }, today);
      if (result.issues.length) throw new Error(result.issues.join(" "));
      await save(result.entry, reviewer?.value || null, profile);
    }, control));
    form.autocomplete = "off";
    form.append(el("h4", profile ? profile.name + " · 기본정보 수정" : "실습생 기본정보"),
      el("p", "성명과 이메일은 필수입니다. 나머지 항목은 필요한 경우 입력하세요.", "pr-muted"),
      layout("pr-grid", field("성명", name), field("생년월일", birth), field("성별", gender),
        field(profile?.email_locked ? "계정 이메일" : "이메일 연락처", email), field("휴대전화 연락처", mobile)));
    if (reviewer) form.append(field("실습지도자", reviewer));
    form.append(layout("pr-row", submit, ...(profile ? [button("수정 취소", cancel)] : [])));
    return form;
  }

  function showPhone(value) {
    return /^(01[016789])\d{7,8}$/.test(value || "")
      ? value.replace(/^(01[016789])(\d{3,4})(\d{4})$/, "$1-$2-$3") : value;
  }

  function excelForm({ cohort, reviewers, people, today, table, run, save }) {
    const file = input("file");
    file.accept = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const reviewer = reviewerInput(reviewers);
    const options = layout("");
    const preview = layout("", el("p", "파일을 선택하면 등록할 명단을 먼저 확인할 수 있습니다.", "pr-muted"));
    let accepted = [];
    const { form, submit } = submitForm("확인한 명단 등록", control => run(async () => {
      if (!accepted.length) throw new Error("등록할 명단을 확인해 주세요.");
      await save(accepted, reviewer.value);
    }, control));
    submit.disabled = true;

    function showSheet(sheet) {
      accepted = [];
      submit.disabled = true;
      if (!sheet.rows?.length) {
        const note = sheet.error || (sheet.rows ? "이 시트에 등록할 명단이 없습니다." :
          "성명과 이메일 연락처 열을 확인해 주세요.");
        preview.replaceChildren(el("p", note, "pr-note"));
        return;
      }
      const seen = new Set(people.map(person => text(person.email).toLowerCase()).filter(Boolean));
      const rows = sheet.rows.map(row => {
        if (row.issues.length) return { ...row, status: "오류", note: row.issues.join(" ") };
        if (seen.has(row.entry.email)) return { ...row, status: "중복", note: "같은 이메일이 이미 있습니다." };
        seen.add(row.entry.email);
        accepted.push(row.entry);
        return { ...row, status: "등록 가능" };
      });
      const errors = rows.filter(row => row.status === "오류").length;
      const duplicates = rows.length - accepted.length - errors;
      const summary = "등록 가능 " + accepted.length + "명 · 중복 " + duplicates + "명 · 오류 " + errors + "건";
      if (errors) accepted = [];
      const stats = el("p", summary, "pr-note");
      stats.setAttribute("role", "status");
      preview.replaceChildren(stats,
        ...(errors ? [el("p", "오류가 표시된 엑셀 행을 수정한 뒤 다시 선택해 주세요.", "pr-alert")] : []),
        table(["엑셀 행", ...columns.map(([, label]) => label), "확인"], rows, row => [
          row.row,
          row.entry.name,
          row.entry.birth_date || text(row.raw.birth_date),
          genderLabels[row.entry.gender] || text(row.raw.gender),
          row.entry.email,
          showPhone(row.entry.mobile) || text(row.raw.mobile),
          row.note ? row.status + " · " + row.note : row.status
        ]));
      submit.disabled = !accepted.length;
    }

    file.addEventListener("change", event => run(async () => {
      const chosen = file.files[0];
      options.replaceChildren();
      accepted = [];
      submit.disabled = true;
      if (!chosen) {
        preview.replaceChildren(el("p", "등록할 엑셀 파일을 선택해 주세요.", "pr-muted"));
        return;
      }
      preview.replaceChildren(el("p", "엑셀 명단을 읽고 있습니다.", "pr-muted"));
      try {
        const sheets = await readWorkbook(chosen, today);
        const selected = sheets.findIndex(sheet => sheet.rows?.length);
        const sheet = select(sheets.map((row, i) => [String(i), row.name]), String(Math.max(0, selected)));
        if (sheets.length > 1) options.append(field("등록할 시트", sheet));
        sheet.addEventListener("change", () => showSheet(sheets[Number(sheet.value)]));
        showSheet(sheets[Number(sheet.value)]);
      } catch (error) {
        file.value = "";
        preview.replaceChildren(el("p", error.message, "pr-alert"));
      }
    }, event.currentTarget));
    form.append(el("h4", "엑셀 명단 업로드"),
      el("p", cohort.name + "에 등록할 명단을 선택합니다. 같은 이메일은 한 건만 등록됩니다.", "pr-muted"),
      layout("pr-row", button("엑셀 양식 내려받기", event => run(downloadTemplate, event.currentTarget))),
      layout("pr-grid", field("엑셀 파일 (.xlsx)", file), field("일괄 지정할 실습지도자", reviewer)),
      options, preview, submit);
    return form;
  }

  window.EorapPracticumRoster = { directForm, excelForm };
})();