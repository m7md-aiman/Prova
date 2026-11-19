/* بروفة — app state and the four steps:
   1 submission (before + planned works) → 2 simulation result → 3 AI suggestions → 4 report.
   All numbers are shown exactly as stored in results.json. Working periods are named by their times only. */
(function () {
  "use strict";

  // S.plan / S.demand = the alternative selected in step 3. Steps 1–2 always show the submission.
  const S = { plan: "works", demand: "100", step: 1, mapMode: "split" };
  let R = null, C = null;          // results.json, UI content
  let SUB = "works@100";           // submitted plan cell (from content.submission)
  let mainMap = null, refMap = null, mapFitted = false;

  /* ---------- formatting (no recomputation, no re-rounding) ---------- */
  const ONE_DECIMAL = new Set(["over5", "over10", "percyc"]); // stored with one decimal
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function raw(v, field) {
    if (typeof v !== "number") return String(v);
    return ONE_DECIMAL.has(field) ? v.toFixed(1) : String(v);
  }
  const N = (v, field, attr) => `<span class="num"${attr ? ` data-f="${attr}"` : ""}>${raw(v, field)}</span>`;
  const signed = (v) => (v > 0 ? "+" + v : String(v));
  const pct = (v, attr) => `<span class="num"${attr ? ` data-f="${attr}"` : ""}>${signed(v)}%</span>`;
  const incText = (c) => `${pct(c.inc_pct, "inc")} <span class="sub">(من ${pct(c.inc_pct_range[0], "inc_min")} إلى ${pct(c.inc_pct_range[1], "inc_max")})</span>`;

  const cellKey = (p = S.plan, d = S.demand) => `${p}@${d}`;
  const split = (k) => k.split("@");
  const planLabel = (p) => C.plans[p].label;
  const verdictPill = (v, sm) => {
    const ico = v === "accepted" ? "✓" : v === "rejected" ? "✕" : "◦";
    return `<span class="pill ${v}${sm ? " sm" : ""}" data-f="verdict" data-v="${v}"><span class="ico" aria-hidden="true">${ico}</span>${C.verdicts[v]}</span>`;
  };
  const failedRules = (c) => C.rules.filter((r) => c.rules[r.key] !== "pass");
  const isOffpeakAccepted = (c, d) => c.verdict === "accepted" && d !== "100";
  const offpeakNote = () => `<div class="note-offpeak" data-f="offpeak">«${C.offpeak_note}»</div>`;
  const assumed = () => `<span class="tag-assumed">${C.assumed_tag}</span>`;
  // Each time or time range is isolated left-to-right; the Arabic between them keeps its order.
  const timesHtml = (t) => esc(t).replace(/\d{2}:\d{2}(?:–\d{2}:\d{2})?/g, (m) => `<span class="num">${m}</span>`);
  const timeOf = (d) => `${timesHtml(C.periods[d].times)}${assumed()}`;
  // Average delay is shown in minutes, one decimal (Mohamed's choice): 317 s → 5.3.
  const mins = (sec) => (sec / 60).toFixed(1);
  const runCode = (c) => `<code data-f="run">runs/${esc(c.run)}</code>`;
  const nameOf = (k) => (split(k)[0] === "works" ? "خطة المقاول" : planLabel(split(k)[0]));

  function ruleValue(r, c) {
    const v = c.rules[r.field];
    if (r.key === "queue") return `<span>${N(v, null, "rule_queue_m")} <small>م</small></span>`;
    if (r.key === "segment") return `<span>${N(v, null, "rule_segment_s")} <small>ث</small></span>`;
    return `<span>${pct(v, "rule_junction_pct")}</span>`;
  }
  function reasonLine(c) {
    if (c.verdict === "reference") return "مرجع المقارنة، دون أعمال.";
    const f = failedRules(c);
    if (c.verdict === "rejected" && f.length)
      return `سبب الرفض: <b>${f.map((r) => r.label).join("، ")}</b> — ` +
        f.map((r) => (r.key === "junction" ? `الزيادة ${pct(c.rules.junction_inc_pct)} والحد 30%`
          : r.key === "queue" ? `الطابور ${N(c.rules.queue_m)} م والحد 1,500 م` : `الزيادة ${N(c.rules.segment_extra_s)} ث والحد 900 ث`)).join("؛ ") + ".";
    return "القواعد الثلاث في الدليل مستوفاة.";
  }
  function limitsBlock(open) {
    return `<details class="limits"${open ? " open" : ""}><summary>الافتراضات والقيود (${C.limitations.length})</summary>
      <ol>${C.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ol></details>`;
  }

  /* ---------- the result block (used by steps 2 and 3) ---------- */
  function resultParts(k) {
    const [p, d] = split(k), c = R.cells[k], b = R.cells[`before@${d}`];
    const head = `
      <div class="card">
        <div class="eyebrow">${esc(nameOf(k))} · ${timeOf(d)}</div>
        ${p === "works" ? "" : `<div class="small muted">${esc(planLabel(p))}</div>`}
        <div class="verdict-head" style="margin:8px 0 8px">${verdictPill(c.verdict)}</div>
        <div class="reason" data-f="reason">${reasonLine(c)}</div>
        ${isOffpeakAccepted(c, d) ? `<div style="margin-top:10px">${offpeakNote()}</div>` : ""}
      </div>`;
    const rules = `<div class="card"><h3>شروط خطة الحركة المرورية الثلاث</h3><div class="rules">${C.rules.map((r) => {
      const st = c.rules[r.key];
      return `<div class="rule ${st}" data-rule="${r.key}" data-status="${st}">
        <span class="r-name">${r.label}</span>
        <span class="r-val">${ruleValue(r, c)}</span>
        <span class="r-limit">الحد: ${r.limit}</span>
        <span class="r-mark"><i aria-hidden="true">${st === "pass" ? "✓" : st === "fail" ? "✕" : "!"}</i>${C.rule_status[st]}</span>
      </div>`;
    }).join("")}</div></div>`;
    const tiles = `
      <div class="card">
        <h3>الأرقام الرئيسية</h3>
        <div class="tiles">
          <div class="tile"><div class="t-label">متوسط التأخير لكل سيارة</div>
            <div class="t-val"><span class="num" data-f="avg_min">${mins(c.avg)}</span><span class="unit">دقيقة</span></div></div>
          <div class="tile"><div class="t-label">الزيادة عن قبل الأعمال</div>
            <div class="t-val">${pct(c.inc_pct, "inc")}</div></div>
          <div class="tile"><div class="t-label">ساعات المركبات المفقودة (32 دقيقة)</div>
            <div class="t-val">${N(c.vehh, null, "vehh")}</div></div>
          <div class="tile"><div class="t-label">التأخير لكل سيارة: الوسيط / <span class="num">95%</span></div>
            <div class="t-val">${N(c.median, null, "median")} <span class="unit">/</span> ${N(c.p95, null, "p95")}<span class="unit">ث</span></div></div>
        </div>
      </div>`;
    const source = `<div class="source">مصدر الأرقام: ${runCode(c)} (5 بذور) · توقيت الإشارة
        <span class="num" data-f="greens">A ${c.greens[0]} / D ${c.greens[1]} / B ${c.greens[2]} / C ${c.greens[3]}</span> ث ·
        الدورة <span class="num" data-f="cycle">${c.cycle}</span> ث · النقل الآني <span class="num" data-f="tele">${c.tele}</span></div>`;
    const rows = ["A", "B", "C", "D"].map((a) => {
      const x = c.ap[a], xb = b.ap[a];
      return `<tr data-ap="${a}"><td><span class="appr-k">${a}</span>${esc(C.approaches[a])}</td>
        <td class="n">${N(x.delay, null, "ap_delay")}</td><td class="n ref-col">${N(xb.delay)}</td>
        <td class="n">${N(x.percyc, "percyc", "ap_percyc")}</td><td class="n">${N(x.over10, "over10", "ap_over10")}</td>
        <td class="n">${N(x.maxq, null, "ap_maxq")}</td><td class="n">${N(x.pend, null, "ap_pend")}</td>
        <td class="n">${N(x.qtot, null, "ap_qtot")}</td><td class="n ref-col">${N(xb.qtot)}</td></tr>`;
    }).join("");
    const table = `
      <div>
        <div class="sec-head"><h2>النتائج لكل اقتراب</h2><span class="muted small">بجانب «قبل الأعمال» في وقت العمل نفسه · ${runCode(c)}</span></div>
        <div class="tbl-wrap"><table class="data ap-table">
          <thead><tr><th>الاقتراب</th><th class="n">التأخير (ث)</th><th class="n ref-col">قبل الأعمال (ث)</th>
            <th class="n">سيارات مخدومة/دورة</th><th class="n">أكثر من 10 دقائق (%)</th><th class="n">أقصى طابور داخل الخريطة (م)</th>
            <th class="n">سيارات تنتظر خارجها</th><th class="n">الطابور الكلي (م)</th><th class="n ref-col">قبل الأعمال (م)</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <div class="muted small" style="margin-top:6px">الطابور الكلي يشمل جزءاً مقدَّراً خارج حدود الخريطة من السيارات التي لم تدخل.</div>
      </div>`;
    return { head, rules, tiles, source, table };
  }

  /* ---------- step bar + routing ---------- */
  function setStep(n) {
    if (!SUBM && n > 1) n = 1;   // nothing to show before the contractor's file is submitted
    S.step = n;
    // Entering the suggestions with nothing chosen yet: start on the first suggestion.
    if (n === 3 && cellKey() === SUB) [S.plan, S.demand] = split(C.ladder[0].cell);
    document.querySelectorAll(".step").forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
    document.querySelectorAll("#stepbar li").forEach((li) => {
      const k = Number(li.dataset.step);
      li.classList.toggle("active", k === n);
      li.classList.toggle("done", k < n);
      li.querySelector("button").setAttribute("aria-current", k === n ? "step" : "false");
    });
    updateChrome();
    placeMap();
    render();
    writeHash();
    window.scrollTo({ top: 0 });
  }
  function writeHash() {
    const h = `#cell=${cellKey()}&step=${S.step}`;
    if (location.hash !== h) history.replaceState(null, "", h);
  }
  function readHash() {
    const m = /cell=([a-z0-9_]+)@(\d+)/.exec(location.hash);
    if (m && C.plan_order.includes(m[1]) && C.period_order.includes(m[2])) { S.plan = m[1]; S.demand = m[2]; }
    const s = /step=(\d)/.exec(location.hash);
    if (s) S.step = Math.min(4, Math.max(1, Number(s[1])));
  }

  /* ---------- map area ---------- */
  function placeMap() {
    const area = document.getElementById("map-area");
    const slot = document.querySelector(`.map-slot[data-slot="${S.step}"]`);
    area.hidden = !slot;
    if (slot && area.parentElement !== slot) slot.appendChild(area);
  }
  const mapCell = () => (S.step === 3 ? cellKey() : SUB);
  function capHtml(k, step1) {
    const [p, d] = split(k), c = R.cells[k];
    const name = p === "before" ? "قبل الأعمال" : nameOf(k);
    if (step1) return `${esc(name)}${p === "before" ? "" : " · المسارات المغلقة"}`;
    return `${esc(name)} · ${timesHtml(C.periods[d].times)} <span class="run">runs/${esc(c.run)}</span>`;
  }
  function updateMaps() {
    if (!mainMap) return;
    const step1 = S.step === 1, showHeat = !step1;
    document.getElementById("map-area").classList.toggle("no-heat", !showHeat);
    const k = mapCell(), bk = `before@${split(k)[1]}`;
    const isSplit = S.mapMode === "split";
    const mk = S.mapMode === "before" ? bk : k;
    mainMap.setCell(mk, { heat: showHeat });
    document.getElementById("cap-main").innerHTML = capHtml(mk, step1);
    document.getElementById("frame-ref").hidden = !isSplit;
    document.getElementById("maps").classList.toggle("split", isSplit);
    if (isSplit) {
      if (!refMap) {
        refMap = new ProvaMap(document.getElementById("map-ref"), R, C, { noZoomControl: true });
        mainMap.syncWith(refMap);
      }
      refMap.setCell(bk, { heat: showHeat });
      document.getElementById("cap-ref").innerHTML = capHtml(bk, step1);
    }
    document.querySelectorAll("#map-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mapMode));
    requestAnimationFrame(() => {
      mainMap.invalidate();
      // First time the map is on screen with a real size: fit the default view.
      if (!mapFitted && mainMap.el.offsetWidth > 0) { mainMap.fitView(false); mapFitted = true; }
      if (isSplit && refMap) { refMap.invalidate(); refMap.map.setView(mainMap.map.getCenter(), mainMap.map.getZoom(), { animate: false }); }
    });
  }

  /* ---------- step 1: submission ---------- */
  function closedGroups(k) {
    const c = R.cells[k];
    const items = c.net === "before" ? [] : R.works[c.net] || [];
    const g = {};
    for (const it of items) (g[it.id] = g[it.id] || { ...it, n: 0 }).n++;
    return Object.values(g);
  }
  /* ---------- submission: upload → read → reveal ---------- */
  const SUBM_KEY = "prova.submission";
  let SUBM = null;                 // {name, size, edges, lanes} once the file has been read
  let picked = null;               // File chosen, not yet submitted
  let stages = null, uploadErr = null, reading = false;
  const STAGES = ["قراءة الملف", "التحقق من نوع الملف", "مطابقة الموقع مع الإشارة 1064", "قراءة الشبكة", "تجهيز نتائج المحاكاة"];
  // The contractor's works network, offered so a visitor without the file can still try the flow.
  // It goes through exactly the same reading and checks as an uploaded file.
  const SAMPLE_URL = "/static/samples/urubah_after_5lane.net.xml";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  function loadSubmission() { try { SUBM = JSON.parse(sessionStorage.getItem(SUBM_KEY) || "null"); } catch { SUBM = null; } }
  function saveSubmission(v) {
    SUBM = v;
    try { if (v) sessionStorage.setItem(SUBM_KEY, JSON.stringify(v)); else sessionStorage.removeItem(SUBM_KEY); } catch { /* private mode */ }
  }
  function updateChrome() {
    document.getElementById("case-chip").hidden = !SUBM;
    document.querySelectorAll("#stepbar li").forEach((li) => li.classList.toggle("locked", !SUBM && Number(li.dataset.step) > 1));
  }

  function drawUpload() {
    const el = document.getElementById("s1-upload");
    const stageList = stages ? `<ol class="stages" id="stages">${stages.map((st) => `
        <li class="${st.status}"><span class="st" aria-hidden="true">${st.status === "done" ? "✓" : st.status === "fail" ? "✕" : ""}</span>
          <span>${esc(st.label)}</span>${st.detail ? `<span class="muted small">— ${st.detail}</span>` : ""}</li>`).join("")}</ol>` : "";
    el.innerHTML = `
      <div class="upload-wrap"><div class="upload-card" id="upload-card">
        <div>
          <div class="eyebrow">${esc(C.case.signal)}</div>
          <h2>تقديم طلب تصريح أعمال</h2>
          <div class="muted small" style="margin-top:4px">ارفع ملف شبكة الطرق بعد الأعمال كما أعدّه المقاول. تقرأ المنصة الملف وتتحقق منه، ثم تعرض الموقع والأعمال ونتائج المحاكاة.</div>
        </div>
        ${reading ? "" : `<label class="drop" id="drop">
          <span class="drop-ico" aria-hidden="true"></span>
          <b>اسحب ملف شبكة الأعمال هنا أو اختر ملفاً</b>
          <span class="muted small"><span class="num">.net.xml</span></span>
          <input type="file" id="file-in" accept=".xml">
        </label>
        <div class="sample-row small muted">ليس لديك الملف؟
          <button type="button" class="btn-link" id="btn-sample">استخدم الملف التجريبي</button>
          <span aria-hidden="true">·</span>
          <a class="btn-link" href="${SAMPLE_URL}" download>تنزيله</a></div>`}
        ${picked ? `<div class="picked"><span class="file-ico after" aria-hidden="true"></span><code>${esc(picked.name)}</code><span class="muted small num">${kb(picked.size)}</span></div>` : ""}
        ${stageList}
        ${uploadErr ? `<div class="upload-err" role="alert">${esc(uploadErr)}</div>` : ""}
        <div class="step-nav"><span></span><button type="button" class="btn" id="btn-submit" ${picked && !reading ? "" : "disabled"}>قدّم الطلب ←</button></div>
      </div></div>`;
  }

  async function submitFile() {
    if (!picked || reading) return;
    const file = picked;
    reading = true; uploadErr = null;
    stages = STAGES.map((label) => ({ label, status: "wait", detail: "" }));
    const set = (i, status, detail) => { stages[i].status = status; if (detail) stages[i].detail = detail; drawUpload(); };
    const fail = (i, msg) => { reading = false; set(i, "fail"); uploadErr = msg; drawUpload(); };

    set(0, "busy");
    const text = await file.text();
    await sleep(600);
    set(0, "done", `<code>${esc(file.name)}</code> · <span class="num">${kb(file.size)}</span>`);

    set(1, "busy"); await sleep(600);
    if (!/<net[\s>]/.test(text) || !/<location\b/.test(text))
      return fail(1, "الملف ليس شبكة طرق SUMO. اختر ملف شبكة الأعمال بصيغة .net.xml.");
    set(1, "done", "شبكة طرق SUMO");

    set(2, "busy"); await sleep(600);
    const m = /netOffset="(-?[\d.]+),(-?[\d.]+)"/.exec(text), off = R.projection.netOffset;
    if (!m || Math.abs(Number(m[1]) - off[0]) > 0.01 || Math.abs(Number(m[2]) - off[1]) > 0.01)
      return fail(2, "الملف لا يطابق موقع الإشارة 1064. تأكّد من اختيار ملف هذا التقاطع.");
    set(2, "done", "الموقع مطابق");

    set(3, "busy"); await sleep(600);
    const edges = (text.match(/<edge /g) || []).length, lanes = (text.match(/<lane /g) || []).length;
    set(3, "done", `<span class="num">${edges}</span> وصلة و<span class="num">${lanes}</span> مساراً`);

    set(4, "busy"); await sleep(700); set(4, "done");
    await sleep(450);
    saveSubmission({ name: file.name, size: file.size, edges, lanes });
    reading = false; picked = null; stages = null;
    [S.plan, S.demand] = split(SUB);
    setStep(1);
  }

  function renderStep1() {
    const upload = document.getElementById("s1-upload"), ws = document.getElementById("s1-workspace");
    if (!SUBM) { ws.hidden = true; upload.hidden = false; drawUpload(); return; }
    upload.hidden = true; upload.innerHTML = ""; ws.hidden = false;
    const sub = C.submission, c = R.cells[SUB], d = split(SUB)[1];
    const ref = sub.networks.find((n) => n.role === "before");
    document.getElementById("s1-panel").innerHTML = `
      <div class="card">
        <div class="eyebrow">طلب تصريح أعمال · ${esc(C.case.signal)}</div>
        <h2 class="case-title">${esc(C.case.title)}</h2>
        <div class="muted small">قُرئ ملف المقاول وتُحاكى الحالة قبل الأعمال وبعدها، ثم يقترح الذكاء الاصطناعي بدائل إن رُفضت الخطة.</div>
      </div>
      <div class="card" id="submitted">
        <h3>ما قدّمه المقاول</h3>
        <ul class="files">
          <li><span class="file-ico after" aria-hidden="true"></span><span><b>ملف شبكة الأعمال (مرفوع)</b><br><code data-f="upload_name">${esc(SUBM.name)}</code><br>
            <span class="small muted"><span class="num">${kb(SUBM.size)}</span> · <span class="num">${SUBM.edges}</span> وصلة · <span class="num">${SUBM.lanes}</span> مساراً</span></span></li>
          <li><span class="file-ico before" aria-hidden="true"></span><span><b>شبكة المرجع قبل الأعمال (لدى المنصة)</b><br><code>${esc(ref.file)}</code></span></li>
        </ul>
        <h3 style="margin-top:16px">الأعمال المطلوبة</h3>
        <div class="small" style="margin-bottom:8px">${esc(sub.summary)}</div>
        <ul class="closed-list">${closedGroups(SUB).map((it) => `
          <li><span class="sw" aria-hidden="true"></span><span>${esc(it.label)}${it.n > 1 ? " — مساران" : it.id === "nb" ? " — المسار الأوسط" : ""}</span>
          <span class="meta">نحو <span class="num">${it.length_m}</span> م · السرعة<span class="mini-speed">${it.speed_kmh}</span></span></li>`).join("")}
        </ul>
        <dl class="facts">
          <div><dt>وقت العمل المطلوب</dt><dd data-f="req_time">${timeOf(d)}</dd></div>
          <div><dt>توقيت الإشارة</dt><dd><span class="num">A ${c.greens[0]} / D ${c.greens[1]} / B ${c.greens[2]} / C ${c.greens[3]}</span> ث · الدورة <span class="num">${c.cycle}</span> ث</dd></div>
        </dl>
      </div>
      <div class="step-nav"><button type="button" class="btn-ghost" id="btn-new">طلب جديد</button><button type="button" class="btn" data-go="2">شغّل المحاكاة ←</button></div>`;
  }

  /* ---------- step 2: simulation of the submission ---------- */
  function renderStep2() {
    const x = resultParts(SUB);
    document.getElementById("s2-panel").innerHTML = x.head + x.rules + x.tiles + x.source +
      `<div class="step-nav"><button type="button" class="btn-ghost" data-go="1">→ الطلب</button>
       <button type="button" class="btn" data-go="3">اطلب مقترحات الذكاء الاصطناعي ←</button></div>`;
    document.getElementById("s2-below").innerHTML = `<div class="below">${x.table}${limitsBlock(false)}</div>`;
  }

  /* ---------- step 3: AI suggestions ---------- */
  function ladderCard(k, n, title, change, isSub) {
    const [p, d] = split(k), c = R.cells[k];
    const why = c.verdict === "rejected" ? failedRules(c).map((r) => r.label).join("، ") : "القواعد الثلاث مستوفاة";
    return `<div class="ladder-card${k === cellKey() ? " sel" : ""}${isSub ? " is-sub" : ""}" data-cell="${k}" role="button" tabindex="0" aria-pressed="${k === cellKey()}">
      <span class="lc-n">${isSub ? "—" : n}</span>
      <div class="lc-body">
        <div class="lc-title">${timesHtml(title)}</div>
        <div class="lc-sub">${title === planLabel(p) ? "" : esc(p === "works" ? "خطة المقاول كما قُدّمت" : planLabel(p)) + " · "}${timeOf(d)}</div>
        ${change ? `<div class="lc-change">${timesHtml(change)}</div>` : ""}
        <div class="lc-stats">متوسط التأخير <span class="num" data-f="avg_min">${mins(c.avg)}</span> دقيقة · الزيادة ${incText(c)} · أطول طابور ${N(c.rules.queue_m, null, "rule_queue_m")} م</div>
        <div class="lc-foot">${verdictPill(c.verdict, true)} <span class="small">${why}</span> <span class="run" data-f="run">${esc(c.run)}</span></div>
        ${isOffpeakAccepted(c, d) ? offpeakNote() : ""}
      </div>
    </div>`;
  }
  function renderStep3() {
    ProvaAI.renderSuggest(document.getElementById("s3-ai"), ctx());
    // Accepted options first (the server orders the ladder), the contractor's plan last as the reference.
    const cards = C.ladder.map((s) => ladderCard(s.cell, s.n, s.title, s.change, false)).join("") +
      ladderCard(SUB, 0, "خطة المقاول كما قُدّمت", null, true);
    const grid = `
      <table class="vgrid" id="vgrid">
        <thead><tr><th>الخطة</th>${C.period_order.map((d) => `<th>${timesHtml(C.periods[d].times).replace(/ و(?=قبل| <span)/, "<br>و").replace(/ و /, "<br>و ")}</th>`).join("")}</tr></thead>
        <tbody>${C.plan_order.map((p) => `<tr><th>${esc(p === "works" ? "خطة المقاول" : planLabel(p))}</th>${C.period_order.map((d) => {
          const k = `${p}@${d}`, v = R.cells[k].verdict;
          return `<td><button type="button" class="vg-cell ${v}${k === cellKey() ? " sel" : ""}" data-cell="${k}" title="${esc(planLabel(p))}">${C.verdicts[v]}</button></td>`;
        }).join("")}</tr>`).join("")}</tbody>
      </table>`;
    document.getElementById("s3-panel").innerHTML = `
      <div class="card">
        <h3>سُلّم المقترحات</h3>
        <div class="muted small" style="margin-bottom:10px">المقترحات المقبولة أولاً، ثم بقية المحاولات، وخطة المقاول في الأخير للمقارنة. اضغط مقترحاً لعرضه على الخريطة.</div>
        <div class="ladder" id="ladder">${cards}</div>
      </div>
      <div class="card">
        <h3>كل البدائل في كل أوقات العمل</h3>
        <div class="muted small" style="margin-bottom:8px">الأوقات ${assumed()}. اضغط أي خانة لعرضها.</div>
        <div class="tbl-wrap">${grid}</div>
      </div>
      <div class="step-nav"><button type="button" class="btn-ghost" data-go="2">→ نتيجة المحاكاة</button><button type="button" class="btn" data-go="4">التقرير ←</button></div>`;

    const k = cellKey(), x = resultParts(k);
    document.getElementById("s3-details").innerHTML = `
      <div class="sec-head" style="margin-top:22px"><h2>تفاصيل البديل المختار: ${esc(nameOf(k))}</h2></div>
      <div class="details-grid">
        <div class="panel">${x.head}${x.rules}</div>
        <div class="panel">${x.tiles}${x.source}<div id="s3-eval"></div></div>
      </div>
      <div class="below">${x.table}</div>`;
    ProvaAI.renderEvaluate(document.getElementById("s3-eval"), ctx());
  }

  /* ---------- render ---------- */
  function ctx() {
    return { R, C, S, SUB, cellKey: cellKey(), helpers: { timesHtml, timeOf, verdictPill, planLabel, nameOf, esc, limitsBlock, reasonLine, assumed, isOffpeakAccepted, offpeakNote } };
  }
  function render() {
    if (S.step === 1) renderStep1();
    if (S.step === 2) renderStep2();
    if (S.step === 3) renderStep3();
    if (S.step === 4) ProvaAI.renderReport(document.getElementById("s4"), ctx());
    updateMaps();
    document.body.dataset.cell = S.step === 3 || S.step === 4 ? cellKey() : SUB;
    document.body.dataset.step = String(S.step);
  }

  function select(k) {
    [S.plan, S.demand] = split(k);
    render(); writeHash();
  }

  /* ---------- events ---------- */
  function bind() {
    document.getElementById("stepbar").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-step]"); if (li) setStep(Number(li.dataset.step));
    });
    document.getElementById("app").addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]"); if (go) return setStep(Number(go.dataset.go));
      if (e.target.closest("#btn-submit")) return submitFile();
      if (e.target.closest("#btn-sample")) return useSample();
      if (e.target.closest("#btn-new")) { saveSubmission(null); picked = null; stages = null; uploadErr = null; [S.plan, S.demand] = split(SUB); return setStep(1); }
      const sc = e.target.closest("#ladder [data-cell], #vgrid [data-cell]"); if (sc) return select(sc.dataset.cell);
      const mm = e.target.closest("#map-mode [data-mode]"); if (mm) { S.mapMode = mm.dataset.mode; return updateMaps(); }
    });
    const pick = (f) => { if (f && !reading) { picked = f; uploadErr = null; stages = null; drawUpload(); } };
    const useSample = async () => {
      try {
        const res = await fetch(SAMPLE_URL);
        if (!res.ok) throw new Error(String(res.status));
        const name = SAMPLE_URL.split("/").pop();
        pick(new File([await res.blob()], name, { type: "text/xml" }));
      } catch {
        uploadErr = "تعذّر تحميل الملف التجريبي. حاول مرة أخرى."; drawUpload();
      }
    };
    document.getElementById("app").addEventListener("change", (e) => { if (e.target.id === "file-in") pick(e.target.files[0]); });
    document.getElementById("app").addEventListener("dragover", (e) => {
      const d = e.target.closest && e.target.closest("#drop"); if (d) { e.preventDefault(); d.classList.add("over"); }
    });
    document.getElementById("app").addEventListener("dragleave", (e) => {
      const d = e.target.closest && e.target.closest("#drop"); if (d) d.classList.remove("over");
    });
    document.getElementById("app").addEventListener("drop", (e) => {
      const d = e.target.closest && e.target.closest("#drop"); if (d) { e.preventDefault(); pick(e.dataTransfer.files[0]); }
    });
    document.getElementById("app").addEventListener("keydown", (e) => {
      const card = e.target.closest && e.target.closest("#ladder [data-cell]");
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(card.dataset.cell); }
    });
    document.getElementById("btn-works").addEventListener("click", () => mainMap.zoomWorks());
    document.getElementById("btn-fit").addEventListener("click", () => mainMap.fitView());
    window.addEventListener("hashchange", () => { const st = S.step; readHash(); if (S.step !== st) setStep(S.step); else render(); });
  }

  async function init() {
    try {
      const [r, c] = await Promise.all([fetch("/api/results").then((x) => x.json()), fetch("/api/content").then((x) => x.json())]);
      R = r; C = c; SUB = C.submission.cell;
    } catch (err) {
      document.getElementById("app").innerHTML = `<div class="card err">تعذّر تحميل البيانات من الخادم.</div>`;
      return;
    }
    document.getElementById("lg-ramp").style.background = `linear-gradient(to left, ${ProvaHeat.RAMP.join(", ")})`;
    document.getElementById("appr-key").innerHTML = Object.entries(C.approaches).map(([k, n]) => `<span><b>${k}</b>${esc(n)}</span>`).join("");
    loadSubmission();
    readHash();
    bind();
    // The map needs a visible, sized container when it is built: build it in step 2's slot.
    const firstStep = S.step;
    S.step = 2;
    document.querySelectorAll(".step").forEach((s) => (s.hidden = s.dataset.step !== "2"));
    placeMap();
    mainMap = new ProvaMap(document.getElementById("map-main"), R, C);
    window.__prova = { S, R, C, SUB, mainMap, select, setStep, get refMap() { return refMap; } };
    setStep(firstStep);
    ProvaAI.init(() => render());
    document.body.dataset.ready = "1";
  }
  init();
})();
