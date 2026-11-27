/* 어랍쇼 공동운영: 인증은 Supabase Auth, 인가와 기록은 DB RLS가 수행한다. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const cfg = window.EORAPSHOW_CONFIG || {};
  const roles = {
    super_admin:"최고관리자", foundation_admin:"재단관리자",
    institution_admin:"기관관리자", instructor:"실습지도자", viewer:"조회자"
  };
  const statuses = { pending:"승인대기", active:"활성", rejected:"거절" };
  const personRoles = { trainee:"실습생", instructor:"실습지도자", staff:"운영 담당자" };
  const personStatuses = { planned:"예정", in_progress:"진행 중", completed:"수료", withdrawn:"중단·보관" };
  const instructorTypes = {
    practice_lead:"실습총괄", manager:"관리자", program_staff:"사업담당자", admin_staff:"행정담당자",
    specialist:"전문분야 담당자", hr_staff:"인사·채용 담당자", practice_supervisor:"실습지도자", external_expert:"외부전문가"
  };
  const responsibilityLabels = { lead:"주담당", co:"공동담당", support:"지원" };
  const splitList = value => String(value||"").split(",").map(x=>x.trim()).filter(Boolean);
  const joinList = value => Array.isArray(value)?value.join(", "):"";
  const careerText = months => {
    const m=Number(months||0), y=Math.floor(m/12), r=m%12;
    return (y?y+"년 ":"")+(r?r+"개월":(!y?"0개월":""));
  };
  const metricLabels = {
    participants:"참여인원(명)",days:"실습 운영일수(일)",hours:"누적 실습시간(인시)",
    education:"교육 운영횟수(회)",projects:"프로젝트 운영건수(건)",completions:"수료인원(명)"
  };
  const state = {
    db:null,user:null,profile:null,institutions:[],cohorts:[],rows:[],manualEditor:false,manualChapterId:null,
    tab:"summary",filter:"all",month:new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Seoul"}).slice(0,7)
  };
  function show(id){ for (const key of ["setup","login","pending","app"]) $(key).classList.toggle("hidden",key!==id); }
  function message(value,error=false){
    const box=$("message"); box.textContent=value; box.classList.toggle("error",error);
    box.classList.toggle("hidden",!value);
  }
  function el(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=String(text);if(cls)x.className=cls;return x;}
  function button(label,fn,cls="btn"){const b=el("button",label,cls);b.type="button";b.addEventListener("click",fn);return b;}
  function line(label,value){const p=el("p");p.append(el("strong",label+" "),document.createTextNode(String(value??"—")));return p;}
  function option(value,label,selected){const o=el("option",label);o.value=value;o.selected=selected;return o;}
  function field(label,type,value,name,required=true){
    const wrap=el("label",undefined,"field"),title=el("span",label),input=el(type==="textarea"?"textarea":"input");
    if(type!=="textarea")input.type=type;
    input.name=name;input.value=value??"";input.required=required;
    wrap.append(title,input);return wrap;
  }
  function selectField(label,name,values,current){
    const wrap=el("label",undefined,"field"),select=el("select");select.name=name;
    for(const [value,text] of values)select.append(option(value,text,current===value));
    wrap.append(el("span",label),select);return wrap;
  }
  function formValue(form,name){return form.elements.namedItem(name)?.value??"";}
  function centerName(id){return state.institutions.find(c=>c.id===id)?.name||id||"전체기관";}
  function isGlobal(){return ["super_admin","foundation_admin"].includes(state.profile?.role);}
  function canEdit(){return ["super_admin","foundation_admin","institution_admin","instructor"].includes(state.profile?.role);}
  function canManage(){return ["super_admin","foundation_admin","institution_admin"].includes(state.profile?.role);}
  function canSeeAudit(){return canManage();}
  function centerChoices(includeAll=false){
    const list=state.institutions.filter(c=>c.id!=="foundation"&&c.is_active);
    return (includeAll?[["all","전체 기관"]]:[]).concat(list.map(c=>[c.id,c.name]));
  }
  function scoped(query){
    return state.filter==="all"?query:query.eq("institution_id",state.filter);
  }
  function monthValue(){return state.month+"-01";}
  async function loadProfile(){
    const result=await state.db.auth.getUser();
    if(result.error||!result.data.user){
      state.user=null;state.profile=null;$("logout").classList.add("hidden");$("identity").textContent="";
      show("login");return;
    }
    state.user=result.data.user;
    const profile=await state.db.from("staff_profiles")
      .select("user_id,email,display_name,role,institution_id,status")
      .eq("user_id",state.user.id).single();
    if(profile.error)throw profile.error;
    state.profile=profile.data;
    $("identity").textContent=(state.profile.display_name||state.profile.email)+" · "+(roles[state.profile.role]||"");
    $("logout").classList.remove("hidden");
    if(state.profile.status!=="active"){
      $("pending-text").textContent=state.profile.status==="rejected"
        ?"접근 요청이 거절되었습니다. 운영자에게 문의해 주세요."
        :"계정이 생성되었으며 관리자 승인을 기다리고 있습니다.";
      show("pending");return;
    }
    const centers=await state.db.from("institutions").select("id,name,is_active,sort_order").order("sort_order");
    if(centers.error)throw centers.error;
    state.institutions=centers.data||[];
    const assignment=await state.db.from("manual_editors")
      .select("institution_id").eq("email",state.profile.email)
      .eq("institution_id",state.profile.institution_id).maybeSingle();
    if(assignment.error)throw assignment.error;
    state.manualEditor=isGlobal()||!!assignment.data;
    if(location.hash.startsWith("#manual")){
      state.tab=state.manualEditor?"manual":"summary";
      state.manualChapterId=decodeURIComponent(location.hash.split("=")[1]||"");
    }
    state.filter=isGlobal()?"all":state.profile.institution_id;
    if(!state.filter)throw Error("소속기관이 지정되지 않았습니다. 관리자가 계정 설정을 확인해야 합니다.");
    show("app"); buildNavigation(); await load();
  }
  function buildNavigation(){
    $("role-info").textContent=(roles[state.profile.role]||"")+" · "+(isGlobal()?"전체기관":centerName(state.profile.institution_id))+" · 서버 저장";
    const tabs=[["summary","대시보드"],["people","기관별 인원"],["instructors","강의 담당자 역량"],["monthly","월별 실적"],["cohorts","실습 차수"]];
    if(state.manualEditor)tabs.push(["manual","매뉴얼 편집"]);
    if(canManage())tabs.push(["staff","사용자·권한"]);
    if(canSeeAudit())tabs.push(["audit","감사기록"]);
    $("tabs").replaceChildren();
    for(const [key,label] of tabs){
      const b=button(label,async()=>{state.tab=key;await load();});
      b.setAttribute("aria-selected",String(state.tab===key));$("tabs").append(b);
    }
    const filter=$("center-filter"); filter.replaceChildren();
    for(const [id,label] of centerChoices(isGlobal())){
      if(!isGlobal()&&id!==state.profile.institution_id)continue;
      filter.append(option(id,label,id===state.filter));
    }
    filter.disabled=!isGlobal();
    filter.value=state.filter;
  }
  async function query(table,cols="*",limit=500){
    let req=scoped(state.db.from(table).select(cols)).limit(limit);
    if(table==="monthly_metrics")req=req.eq("month",monthValue());
    req=req.order(table==="monthly_metrics"?"institution_id":"created_at",{ascending:false});
    const result=await req;if(result.error)throw result.error;return result.data||[];
  }
  async function load(){
    try{
      message("");buildNavigation();const box=$("content");box.replaceChildren();
      $("export").classList.toggle("hidden",!["people","monthly"].includes(state.tab));
      if(state.tab==="staff"){await staffView(box);return;}
      if(state.tab==="audit"){await auditView(box);return;}
      if(state.tab==="manual"){await manualView(box);return;}
      if(state.tab==="summary"){await summaryView(box);return;}
      if(state.tab==="instructors"){await instructorView(box);return;}
      if(state.tab==="people"||state.tab==="cohorts"){
        state.cohorts=await query("cohorts","id,institution_id,year,name,start_date,end_date,created_at");
      }
      state.rows=await query(state.tab==="monthly"?"monthly_metrics":state.tab,
        state.tab==="monthly"?"*":"*");
      if(state.tab==="people")peopleView(box);
      if(state.tab==="monthly")monthlyView(box);
      if(state.tab==="cohorts")cohortView(box);
    }catch(e){message("자료를 불러오지 못했습니다: "+e.message,true);}
  }
  function table(box,headers,records,makeCells){
    const wrap=el("div",undefined,"card scroll"),t=el("table"),thead=el("thead"),tr=el("tr"),body=el("tbody");
    for(const h of headers)tr.append(el("th",h));thead.append(tr);
    if(!records.length){const empty=el("tr"),cell=el("td","등록된 자료가 없습니다.");cell.colSpan=headers.length;empty.append(cell);body.append(empty);}
    for(const row of records){
      const item=el("tr");
      for(const value of makeCells(row)){
        const td=el("td");if(value instanceof Node)td.append(value);else td.textContent=String(value??"—");item.append(td);
      } body.append(item);
    }
    t.append(thead,body);wrap.append(t);box.append(wrap);
  }
  function actions(edit){const div=el("div",undefined,"row");div.append(button("수정",edit));return div;}
  function toolbar(box,title,add){
    const div=el("div",undefined,"toolbar");div.append(el("h2",title));
    if(add&&canEdit())div.append(button("등록",add,"btn primary"));
    box.append(div);
  }
  async function summaryView(box){
    const [people,metrics,cohorts]=await Promise.all([
      query("people","id,status,role"),query("monthly_metrics","id,participants,hours,completions"),query("cohorts","id")
    ]);
    const stats=el("div",undefined,"stats");
    for(const [label,num] of [
      ["진행 중 실습생",people.filter(p=>p.role==="trainee"&&p.status==="in_progress").length],
      ["등록 차수",cohorts.length],
      ["기준월 참여인원",metrics.reduce((n,p)=>n+p.participants,0)],
      ["기준월 누적 실습시간",metrics.reduce((n,p)=>n+Number(p.hours),0)]
    ]){const c=el("div",undefined,"stat");c.append(el("span",label),el("strong",num));stats.append(c);}
    box.append(stats);
    const note=el("div",undefined,"card");note.append(el("h2","운영 원칙"),
      line("자료 범위","선택 기관의 승인된 사용자에게만 표시됩니다."),
      line("실적 기준","월별 수치는 기관별 등록값이며 명부에서 자동 합산하지 않습니다."),
      line("삭제 대신 보관","인원 상태를 중단·보관으로 바꿔 이력을 남깁니다."));
    box.append(note);
  }
  function peopleView(box){
    toolbar(box,"기관별 인원 현황",()=>openEditor("people"));
    if(state.rows.length===500)box.append(el("p","한 번에 최대 500건을 표시합니다. 기관을 선택해 범위를 좁혀 주세요.","muted"));
    table(box,["기관","차수","이름","구분","상태","기간","관리"],state.rows,p=>{
      const cohort=state.cohorts.find(c=>c.id===p.cohort_id);
      return [centerName(p.institution_id),cohort?cohort.year+" · "+cohort.name:"차수 미지정",
        p.name,personRoles[p.role],personStatuses[p.status],
        (p.start_date||"미정")+" ~ "+(p.end_date||"미정"),canEdit()?actions(()=>openEditor("people",p)): "조회 전용"];
    });
  }
  function monthlyView(box){
    const top=el("div",undefined,"toolbar"),month=field("실적 기준월","month",state.month,"month");
    month.querySelector("input").addEventListener("change",async e=>{if(e.target.value){state.month=e.target.value;await load();}});
    top.append(el("h2","월별 운영 실적"),month);
    if(canEdit())top.append(button("실적 등록",()=>openEditor("monthly"),"btn primary"));
    box.append(top);
    table(box,["기관",...Object.values(metricLabels),"관리"],state.rows,p=>
      [centerName(p.institution_id),...Object.keys(metricLabels).map(k=>p[k]),
        canEdit()?actions(()=>openEditor("monthly",p)):"조회 전용"]);
    box.append(el("p","미등록 기관은 0건과 구분됩니다. 기관 간 동일 인원이 있을 수 있어 합계에 중복이 생길 수 있습니다.","muted"));
  }
  function cohortView(box){
    toolbar(box,"실습 차수",()=>openEditor("cohorts"));
    table(box,["기관","연도","차수","시작일","종료일","관리"],state.rows,c=>
      [centerName(c.institution_id),c.year,c.name,c.start_date||"—",c.end_date||"—",
        canEdit()?actions(()=>openEditor("cohorts",c)):"조회 전용"]);
  }
  async function staffView(box){
    if(!canManage())return;
    toolbar(box,"사용자 승인·권한");
    box.append(el("p","신규 사용자는 업무용 이메일 확인 후 승인대기 상태로 등록됩니다. 기관관리자는 재단관리자가 소속기관을 배정한 지도자·조회자만 관리할 수 있습니다.","muted"));
    let req=state.db.from("staff_profiles").select("user_id,email,display_name,role,status,institution_id,created_at").order("created_at",{ascending:false}).limit(500);
    if(state.profile.role==="institution_admin")req=req.eq("institution_id",state.profile.institution_id);
    const result=await req;if(result.error)throw result.error;state.rows=result.data||[];
    table(box,["사용자","기관","역할","상태","관리"],state.rows,p=>
      [p.display_name? p.display_name+" / "+p.email:p.email,centerName(p.institution_id),
        roles[p.role],statuses[p.status],
        p.user_id===state.user.id?"본인 계정":actions(()=>openEditor("staff",p))]);
    if(isGlobal())await manualAssignmentsView(box);
  }
  async function manualAssignmentsView(box){
    const result=await state.db.from("manual_editors").select("institution_id,email");
    if(result.error)throw result.error;
    const assigned=new Map((result.data||[]).map(x=>[x.institution_id,x.email]));
    box.append(el("h2","기관별 공통 매뉴얼 편집 담당자"));
    box.append(el("p","기관마다 업무용 이메일로 담당자 한 명을 미리 지정할 수 있습니다. 가입·이메일 확인·관리자 승인·소속기관 일치 후 편집 권한이 활성화됩니다. 담당자는 공통 매뉴얼 23개 장을 편집하며 저장 즉시 홈페이지에 게시됩니다.","muted"));
    const centers=state.institutions.filter(x=>x.id!=="foundation"&&x.is_active);
    table(box,["기관","담당자 이메일·상태","지정"],centers,c=>{
      const control=el("input");
      control.type="email";control.value=assigned.get(c.id)||"";
      control.placeholder="담당자@bwyf.or.kr";
      control.setAttribute("aria-label",c.name+" 매뉴얼 담당자 이메일");
      const record=state.rows.find(p=>p.institution_id===c.id&&p.email===control.value&&p.status==="active");
      const cell=el("div");
      cell.append(control,el("p",record?"계정 승인 완료"+(record.display_name?" · "+record.display_name:""):"가입·이메일 확인·승인 대기","muted"));
      const save=button("지정 저장",async()=>{
        if(control.value&&!control.checkValidity()){message("올바른 이메일을 입력해 주세요.",true);return;}
        save.disabled=true;
        const result=await state.db.rpc("assign_manual_editor_email",{
          p_institution_id:c.id,p_email:control.value.trim()
        });
        save.disabled=false;
        if(result.error){message("담당자 지정 실패: "+result.error.message,true);return;}
        await load();message(c.name+" 매뉴얼 담당자를 변경했습니다.");
      });
      return [c.name,cell,save];
    });
  }
  async function manualView(box){
    if(!state.manualEditor)throw Error("매뉴얼 편집 권한이 없습니다.");
    const result=await state.db.from("manual_chapters")
      .select("id,title,group_name,body,version,updated_at,sort_order").order("sort_order");
    if(result.error)throw result.error;
    const chapters=result.data||[];
    if(!chapters.length){box.append(el("p","매뉴얼 장이 아직 등록되지 않았습니다."));return;}
    let current=chapters.find(x=>x.id===state.manualChapterId)||chapters[0];
    state.manualChapterId=current.id;
    const heading=el("div",undefined,"toolbar");
    heading.append(el("h2","공통 매뉴얼 편집"));
    const view=el("a","공개 화면 보기","btn");
    view.href="./index.html#manual";heading.append(view);box.append(heading);
    box.append(el("p","저장하면 홈페이지에 즉시 반영됩니다. 같은 장의 다른 담당자 수정본이 먼저 저장되면 덮어쓰지 않고 안내합니다.","muted"));
    const selectBox=el("label",undefined,"field"),picker=el("select");
    selectBox.append(el("span","편집할 장"));
    for(const c of chapters)picker.append(option(c.id,c.title,c.id===current.id));
    picker.addEventListener("change",async()=>{
      state.manualChapterId=picker.value;
      history.replaceState(null,"","#manual="+encodeURIComponent(picker.value));
      await load();
    });
    selectBox.append(picker);box.append(selectBox);
    const card=el("div",undefined,"card");
    card.append(el("p",current.group_name+" · 게시 버전 "+current.version+" · 최종 수정 "+new Date(current.updated_at).toLocaleString("ko-KR"),"muted"));
    const form=el("form"),title=field("장 제목","text",current.title,"title");
    const body=field("매뉴얼 본문(일반 텍스트)","textarea",current.body,"body");
    title.querySelector("input").maxLength=120;
    const bodyInput=body.querySelector("textarea");
    bodyInput.maxLength=200000;
    bodyInput.style.minHeight="52vh";
    const error=el("p",undefined,"error-text");error.setAttribute("role","alert");
    const save=el("button","저장 및 즉시 게시","btn primary");save.type="submit";
    form.append(title,body,error,save);
    form.addEventListener("submit",async e=>{
      e.preventDefault();save.disabled=true;error.textContent="";
      const response=await state.db.rpc("save_manual_chapter",{
        p_id:current.id,p_title:formValue(form,"title"),p_body:formValue(form,"body"),
        p_expected_version:current.version
      });
      save.disabled=false;
      if(response.error){error.textContent=response.error.message;return;}
      await load();message("버전 "+response.data+"으로 게시했습니다. 홈페이지 새로고침 시 최신 내용이 표시됩니다.");
    });
    card.append(form);box.append(card);
    const historyResult=await state.db.from("manual_revisions")
      .select("version,title,body,editor_email,edited_at").eq("chapter_id",current.id)
      .order("version",{ascending:false}).limit(10);
    if(historyResult.error)throw historyResult.error;
    const historyCard=el("div",undefined,"card");
    historyCard.append(el("h2","최근 수정 이력"));
    for(const revision of historyResult.data||[]){
      const details=el("details"),summary=el("summary",
        "버전 "+revision.version+" · "+revision.editor_email+" · "+new Date(revision.edited_at).toLocaleString("ko-KR"));
      const prior=el("pre",revision.title+"\n\n"+revision.body);
      prior.style.cssText="white-space:pre-wrap;max-height:300px;overflow:auto;background:#f5f7f5;padding:12px";
      details.append(summary,prior);historyCard.append(details);
    }
    box.append(historyCard);
  }

  async function instructorView(box){
    toolbar(box,"강의 담당자 역량 프로필",()=>instructorEditor());
    const note=el("div",undefined,"card");
    note.append(
      el("h2","담당자 추천 기준"),
      line("우선순위","관련업무 담당경력 → 전문분야 적합성 → 최근 담당시기 → 실제 사례 보유 → 강의경험 → 총 근무경력"),
      line("경력 관리","총 근무경력·청소년분야 경력·현 기관 경력은 월 단위로 관리하고, 담당경력은 여러 건 누적합니다."),
      line("개인정보","실제 직원 이름과 경력정보는 로그인한 관리화면에서만 관리합니다.")
    );
    box.append(note);
    let req=scoped(state.db.from("instructor_profiles").select("*")).order("name",{ascending:true}).limit(500);
    const result=await req;if(result.error)throw result.error;
    const rows=result.data||[];
    table(box,["기관","이름","담당자 유형","전문분야","근무경력","강의경험","관리"],rows,p=>[
      centerName(p.institution_id),p.name,
      (p.staff_types||[]).map(x=>instructorTypes[x]||x).join(" · ")||"—",
      (p.specialties||[]).join(", ")||"—",
      "총 "+careerText(p.total_career_months)+" / 청소년 "+careerText(p.youth_career_months)+" / 현기관 "+careerText(p.current_institution_months),
      (p.lecture_experience_count||0)+"회",
      canEdit()?actions(()=>instructorEditor(p)):"조회 전용"
    ]);
  }

  function multiSelectField(label,name,values,current=[]){
    const wrap=el("label",undefined,"field"), title=el("span",label), select=el("select");
    select.name=name; select.multiple=true; select.size=Math.min(8,Math.max(4,values.length));
    for(const [value,labelText] of values)select.append(option(value,labelText,current.includes(value)));
    wrap.append(title,select); return wrap;
  }

  function instructorEditor(record=null){
    if(!canEdit())return;
    if(!record&&state.filter==="all"){message("등록할 기관을 먼저 조회 기관에서 선택해 주세요.",true);return;}
    const dialog=$("editor"),form=$("editor-form");form.replaceChildren();
    $("editor-title").textContent=record?"강의 담당자 역량 수정":"강의 담당자 역량 등록";
    const selected=record?.institution_id||(state.filter==="all"?centerChoices()[0]?.[0]:state.filter);
    const center=selectField("기관","institution_id",centerChoices(),selected);center.querySelector("select").disabled=true;form.append(center);
    form.append(field("이름","text",record?.name||"","name"));
    form.append(multiSelectField("담당자 유형(복수선택)","staff_types",Object.entries(instructorTypes),record?.staff_types||["program_staff"]));
    form.append(field("전문분야(쉼표로 구분)","text",joinList(record?.specialties),"specialties",false));
    form.append(field("총 근무경력(개월)","number",record?.total_career_months??0,"total_career_months"));
    form.append(field("청소년분야 근무경력(개월)","number",record?.youth_career_months??0,"youth_career_months"));
    form.append(field("현 기관 근무경력(개월)","number",record?.current_institution_months??0,"current_institution_months"));
    form.append(field("강의·교육 경험(회)","number",record?.lecture_experience_count??0,"lecture_experience_count"));
    form.append(field("관련 자격·교육","textarea",record?.qualifications||"","qualifications",false));
    form.append(field("담당 가능 과목(쉼표로 구분)","text",joinList(record?.available_courses),"available_courses",false));
    form.append(multiSelectField("희망 강의 영역","preferred_areas",[["이해","이해"],["실제","실제"],["경험","경험"],["가치","가치"]],record?.preferred_areas||[]));
    form.append(field("비고","textarea",record?.notes||"","notes",false));
    const active=el("label",undefined,"field"),activeInput=el("input");activeInput.type="checkbox";activeInput.name="is_active";activeInput.checked=record?.is_active!==false;
    active.append(el("span","활성 상태"),activeInput);form.append(active);
    if(record){
      const careerBox=el("div",undefined,"card");
      careerBox.append(el("h3","관련업무 담당경력"),el("p","저장 후 담당경력을 여러 건 누적할 수 있습니다.","muted"),
        button("담당경력 관리",()=>careerManager(record),"btn"));
      form.append(careerBox);
    }
    const error=el("p",undefined,"error-text");error.setAttribute("role","alert");
    const save=el("button","저장","btn primary");save.type="submit";form.append(error,save);
    form.onsubmit=async e=>{
      e.preventDefault();save.disabled=true;error.textContent="";
      try{
        const fd=new FormData(form);
        const payload={
          institution_id:selected,
          name:String(fd.get("name")||"").trim(),
          staff_types:fd.getAll("staff_types"),
          specialties:splitList(fd.get("specialties")),
          total_career_months:Number(fd.get("total_career_months")||0),
          youth_career_months:Number(fd.get("youth_career_months")||0),
          current_institution_months:Number(fd.get("current_institution_months")||0),
          lecture_experience_count:Number(fd.get("lecture_experience_count")||0),
          qualifications:String(fd.get("qualifications")||"").trim(),
          available_courses:splitList(fd.get("available_courses")),
          preferred_areas:fd.getAll("preferred_areas"),
          notes:String(fd.get("notes")||"").trim(),
          is_active:!!form.elements.namedItem("is_active")?.checked
        };
        if(!payload.name)throw Error("이름을 입력해 주세요.");
        if(!payload.staff_types.length)throw Error("담당자 유형을 하나 이상 선택해 주세요.");
        const req=record?state.db.from("instructor_profiles").update(payload).eq("id",record.id):
          state.db.from("instructor_profiles").insert(payload);
        const result=await req.select("*").single();if(result.error)throw result.error;
        dialog.close();await load();message("강의 담당자 역량 프로필을 저장했습니다.");
      }catch(ex){error.textContent=ex.message;}finally{save.disabled=false;}
    };
    dialog.showModal();
  }

  async function careerManager(profile){
    const dialog=$("editor"),form=$("editor-form");form.replaceChildren();
    $("editor-title").textContent=profile.name+" · 담당경력";
    let req=state.db.from("instructor_career_entries").select("*").eq("profile_id",profile.id).order("start_date",{ascending:false});
    const result=await req;if(result.error){message(result.error.message,true);return;}
    const records=result.data||[];
    const wrap=el("div",undefined,"card scroll"),t=el("table"),thead=el("thead"),tr=el("tr"),tbody=el("tbody");
    for(const h of ["전문분야","담당업무","기간","역할","비고"])tr.append(el("th",h));thead.append(tr);
    for(const r of records){
      const row=el("tr");
      for(const v of [r.specialty,r.duty,(r.start_date||"")+" ~ "+(r.end_date||"현재"),responsibilityLabels[r.responsibility]||r.responsibility,r.notes||"—"])row.append(el("td",v));
      tbody.append(row);
    }
    if(!records.length){const row=el("tr"),td=el("td","등록된 담당경력이 없습니다.");td.colSpan=5;row.append(td);tbody.append(row);}
    t.append(thead,tbody);wrap.append(t);form.append(wrap);
    const add=el("div",undefined,"card");add.append(el("h3","담당경력 추가"));
    add.append(field("전문분야","text","","career_specialty"),field("담당업무","text","","career_duty"));
    add.append(field("시작일","date","","career_start"),field("종료일(현재 담당이면 비움)","date","","career_end",false));
    add.append(selectField("담당 수준","career_responsibility",Object.entries(responsibilityLabels),"lead"));
    add.append(field("주요 사례·비고","textarea","","career_notes",false));
    const error=el("p",undefined,"error-text"),save=button("경력 추가",async()=>{
      save.disabled=true;error.textContent="";
      try{
        const payload={
          profile_id:profile.id,institution_id:profile.institution_id,
          specialty:formValue(add,"career_specialty").trim(),
          duty:formValue(add,"career_duty").trim(),
          start_date:formValue(add,"career_start"),
          end_date:formValue(add,"career_end")||null,
          responsibility:formValue(add,"career_responsibility"),
          notes:formValue(add,"career_notes").trim()
        };
        if(!payload.specialty||!payload.duty||!payload.start_date)throw Error("전문분야·담당업무·시작일을 입력해 주세요.");
        if(payload.end_date&&payload.end_date<payload.start_date)throw Error("종료일은 시작일 이후여야 합니다.");
        const res=await state.db.from("instructor_career_entries").insert(payload).select("id").single();if(res.error)throw res.error;
        dialog.close();await load();message("담당경력을 추가했습니다.");
      }catch(ex){error.textContent=ex.message;}finally{save.disabled=false;}
    },"btn primary");
    add.append(error,save);form.append(add);dialog.showModal();
  }

  async function auditView(box){
    if(!canSeeAudit())return;
    toolbar(box,"최근 감사기록");
    let req=state.db.from("audit_logs").select("id,actor_user_id,action,entity_type,entity_id,institution_id,created_at")
      .order("created_at",{ascending:false}).limit(100);
    if(state.filter!=="all")req=req.eq("institution_id",state.filter);
    const result=await req;if(result.error)throw result.error;state.rows=result.data||[];
    table(box,["시간","기관","행위","대상","식별자"],state.rows,r=>
      [new Date(r.created_at).toLocaleString("ko-KR"),centerName(r.institution_id),
        r.action,r.entity_type,r.entity_id]);
  }
  function openEditor(type,record=null){
    if(type!=="staff"&&!record&&state.filter==="all"){
      message("등록할 기관을 먼저 조회 기관에서 선택해 주세요.",true);return;
    }
    const dialog=$("editor"),form=$("editor-form");form.replaceChildren();
    $("editor-title").textContent=record?"자료 수정":"자료 등록";
    const selected=record?.institution_id||(state.filter==="all"?centerChoices()[0]?.[0]:state.filter);
    if(type!=="staff"){
      const center=selectField("기관","institution_id",centerChoices(),selected);
      center.querySelector("select").disabled=true;
      form.append(center);
    }
    if(type==="people"){
      form.append(selectField("차수","cohort_id",[["","미지정"],...state.cohorts.filter(c=>c.institution_id===selected).map(c=>[c.id,c.year+" · "+c.name])],record?.cohort_id||""));
      form.append(field("이름","text",record?.name,"name"));
      form.append(selectField("구분","role",Object.entries(personRoles),record?.role||"trainee"));
      form.append(selectField("상태","status",Object.entries(personStatuses),record?.status||"planned"));
      form.append(field("시작일","date",record?.start_date,"start_date",false),field("종료일","date",record?.end_date,"end_date",false));
      form.append(field("운영 메모(민감정보 제외)","textarea",record?.memo,"memo",false));
    }
    if(type==="cohorts"){
      form.append(field("연도","number",record?.year||new Date().getFullYear(),"year"));
      form.append(field("차수명","text",record?.name,"name"));
      form.append(field("시작일","date",record?.start_date,"start_date",false),field("종료일","date",record?.end_date,"end_date",false));
    }
    if(type==="monthly"){
      form.append(field("기준월","month",record?.month?.slice(0,7)||state.month,"month"));
      for(const [key,label] of Object.entries(metricLabels))form.append(field(label,"number",record?.[key]??0,key));
      form.append(field("운영 메모","textarea",record?.memo,"memo",false));
    }
    if(type==="staff"){
      form.append(line("대상 계정",record.email));
      const allowed=state.profile.role==="super_admin"?Object.entries(roles):
        state.profile.role==="foundation_admin"?Object.entries(roles).filter(([k])=>!["super_admin","foundation_admin"].includes(k)):
        Object.entries(roles).filter(([k])=>["instructor","viewer"].includes(k));
      form.append(selectField("기관","institution_id",[["","전체기관"],...centerChoices()],record.institution_id||""));
      form.append(selectField("역할","role",allowed,record.role));
      form.append(selectField("상태","status",Object.entries(statuses),record.status));
    }
    const error=el("p",undefined,"error-text");error.setAttribute("role","alert");
    const save=el("button","저장","btn primary");save.type="submit";form.append(error,save);
    form.onsubmit=async e=>{
      e.preventDefault();save.disabled=true;error.textContent="";
      try{
        if(type==="staff"){
          const res=await state.db.rpc("manage_staff",{
            p_user_id:record.user_id,p_institution_id:formValue(form,"institution_id")||null,
            p_role:formValue(form,"role"),p_status:formValue(form,"status")
          });if(res.error)throw res.error;
        }else{
          const payload={};
          for(const x of new FormData(form).entries())payload[x[0]]=x[1];
          payload.institution_id=selected;
          if(type==="people"){
            payload.name=payload.name.trim();payload.cohort_id=payload.cohort_id||null;
            payload.start_date=payload.start_date||null;payload.end_date=payload.end_date||null;
            payload.memo=payload.memo.trim();
          }
          if(type==="cohorts"){
            payload.year=Number(payload.year);payload.name=payload.name.trim();
            payload.start_date=payload.start_date||null;payload.end_date=payload.end_date||null;
          }
          if(type==="monthly"){
            payload.month=payload.month+"-01";
            for(const key of Object.keys(metricLabels))payload[key]=Number(payload[key]);
            payload.memo=payload.memo.trim();
          }
          const tableName=type==="monthly"?"monthly_metrics":type;
          const req=record?state.db.from(tableName).update(payload).eq("id",record.id):
            state.db.from(tableName).insert(payload);
          const result=await req.select("id").single();if(result.error)throw result.error;
        }
        dialog.close();await load();message("서버에 저장했습니다.");
      }catch(ex){error.textContent=ex.message;}finally{save.disabled=false;}
    };
    dialog.showModal();
  }
  function csvCell(value){
    let s=String(value??"");
    if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
    return '"'+s.replaceAll('"','""')+'"';
  }
  async function exportCurrent(){
    if(!["people","monthly"].includes(state.tab))return;
    try{
      const tableName=state.tab==="monthly"?"monthly_metrics":"people";
      const allRows=[];
      const pageSize=500;
      for(let offset=0;;offset+=pageSize){
        let request=scoped(state.db.from(tableName).select("*"));
        if(tableName==="monthly_metrics")request=request.eq("month",monthValue());
        const page=await request.order("created_at",{ascending:false}).range(offset,offset+pageSize-1);
        if(page.error)throw page.error;
        allRows.push(...(page.data||[]));
        if((page.data||[]).length<pageSize)break;
      }
      const result=await state.db.rpc("log_export",{
        p_entity_type:state.tab,p_institution_id:state.filter==="all"?null:state.filter
      });if(result.error)throw result.error;
      const fields=state.tab==="people"?["institution_id","cohort_id","name","role","status","start_date","end_date","memo"]:
        ["institution_id","month",...Object.keys(metricLabels),"memo"];
      const rows=[fields.map(csvCell).join(",")];
      for(const row of allRows)rows.push(fields.map(key=>csvCell(row[key])).join(","));
      const blob=new Blob(["\ufeff"+rows.join("\r\n")],{type:"text/csv;charset=utf-8"});
      const url=URL.createObjectURL(blob),link=document.createElement("a");
      link.href=url;link.download="eorapshow-"+state.tab+"-"+new Date().toISOString().slice(0,10)+".csv";
      link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){message("CSV 저장 실패: "+e.message,true);}
  }
  async function init(){
    if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.url||"")||!/^sb_publishable_|^eyJ/.test(cfg.publishableKey||"")||!window.supabase){
      show("setup");return;
    }
    state.db=window.supabase.createClient(cfg.url,cfg.publishableKey);
    $("center-filter").addEventListener("change",async e=>{state.filter=e.target.value;await load();});
    $("close-editor").addEventListener("click",()=>$("editor").close());
    $("export").addEventListener("click",exportCurrent);
    $("logout").addEventListener("click",async()=>{await state.db.auth.signOut();location.reload();});
    $("login-form").addEventListener("submit",async e=>{
      e.preventDefault();message("");
      const result=await state.db.auth.signInWithPassword({email:$("email").value.trim(),password:$("password").value});
      $("password").value="";
      if(result.error){message("로그인 실패: "+result.error.message,true);return;}
      try{await loadProfile();}catch(ex){message(ex.message,true);}
    });
    $("signup").addEventListener("click",async()=>{
      if(!$("login-form").reportValidity())return;
      const email=$("email").value.trim();
      if(!/^[^\s@]+@bwyf\.or\.kr$/i.test(email)){
        message("@bwyf.or.kr 기관 업무용 이메일로 신청해 주세요.",true);return;
      }
      const result=await state.db.auth.signUp({
        email,password:$("password").value,
        options:{emailRedirectTo:location.origin+location.pathname}
      });$("password").value="";
      message(result.error?"계정 신청 실패: "+result.error.message:"확인 이메일을 발송했습니다. 이메일 확인 후 관리자 승인을 기다려 주세요.",!!result.error);
    });
    $("reset").addEventListener("click",async()=>{
      const email=$("email");if(!email.reportValidity())return;
      const result=await state.db.auth.resetPasswordForEmail(email.value.trim(),{
        redirectTo:location.origin+location.pathname
      });message(result.error?"재설정 요청 실패: "+result.error.message:"비밀번호 재설정 메일을 확인해 주세요.",!!result.error);
    });
    state.db.auth.onAuthStateChange(event=>{
      if(event!=="PASSWORD_RECOVERY")return;
      setTimeout(()=>{
        const dialog=$("editor"),form=$("editor-form");form.replaceChildren();
        $("editor-title").textContent="새 비밀번호 설정";
        const newPassword=field("새 비밀번호(6자 이상)","password","","new_password");
        newPassword.querySelector("input").minLength=6;
        form.append(newPassword);
        const save=el("button","변경","btn primary");save.type="submit";form.append(save);
        form.onsubmit=async e=>{e.preventDefault();
          const result=await state.db.auth.updateUser({password:formValue(form,"new_password")});
          if(result.error)message(result.error.message,true);else{dialog.close();message("비밀번호를 변경했습니다.");}
        };dialog.showModal();
      },0);
    });
    try{await loadProfile();}catch(e){message("접속 확인 실패: "+e.message,true);show("login");}
  }
  document.addEventListener("DOMContentLoaded",init);
})();