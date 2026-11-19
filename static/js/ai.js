/* Live AI (streamed from /api/ai/stream): suggestions and per-alternative evaluation (step 3),
   review report and questions (step 4). */
(function () {
  "use strict";

  let status = { available: null };
  const docs = { suggest: null, report: null, evaluate: {} };  // doc: {kind, cell, md, done, check, model, error}
  const qa = [];                                               // [{q, a, done, error}]
  let busy = false;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- minimal Markdown -> HTML (escaped first) ---------- */
  function inline(s) {
    s = esc(s);
    s = s.replace(/(?<![\w/])([+\-−]?\d[\d.,:]*(?:[–-]\d[\d.,:]*)?%?)/g, '<span class="num">$1</span>');
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    return s;
  }
  /* Lists: indented items nest under the previous item, and a blank line between items of the
     same list does not restart it (numbering continues). */
  const LI = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;
  function list(lines, i, indent) {
    const first = LI.exec(lines[i]);
    const ordered = /\d/.test(first[2]), start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    while (i < lines.length) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) { i = j; break; }
      const m = LI.exec(lines[j]);
      if (!m) {
        // a wrapped line right under an item belongs to it
        if (j === i && items.length && lines[j].search(/\S/) > indent) { items[items.length - 1].text += " " + lines[j].trim(); i = j + 1; continue; }
        break;
      }
      const ind = m[1].length;
      if (ind < indent) break;
      if (ind > indent) {
        if (!items.length) break;
        const [sub, ni] = list(lines, j, ind);
        items[items.length - 1].sub += sub; i = ni;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ text: m[3], sub: "" }); i = j + 1;
    }
    const tag = ordered ? "ol" : "ul";
    return [`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${items.map((x) => `<li>${inline(x.text)}${x.sub}</li>`).join("")}</${tag}>`, i];
  }
  function md(src) {
    const lines = src.replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { const n = Math.min(m[1].length, 3); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\s*\|/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
        const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
        if (!body.length) continue;
        const [head, ...rest] = body;
        out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
          rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      if (LI.test(l)) {
        const [html, ni] = list(lines, i, LI.exec(l)[1].length);
        out.push(html); i = ni;
        continue;
      }
      if (/^>\s?/.test(l)) {
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
        out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`);
        continue;
      }
      if (/^-{3,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*[-*•]\s|\s*\d+[.)]\s|>)/.test(lines[i])) p.push(lines[i++]);
      if (p.length) out.push(`<p>${inline(p.join(" "))}</p>`); else i++;
    }
    return out.join("\n");
  }

  /* ---------- streaming ---------- */
  async function stream(body, onDelta) {
    const res = await fetch("/api/ai/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
        const line = chunk.split("\n").find((x) => x.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "delta") onDelta(ev.text);
        else final = ev;
      }
    }
    return final || { type: "error", message: "انقطع الاتصال قبل اكتمال الإجابة." };
  }

  /* ---------- documents ---------- */
  const DOC = {
    suggest: { title: "مقترحات الذكاء الاصطناعي", empty: "اضغط «اقترح بدائل» ليشرح الذكاء الاصطناعي لماذا رُفضت خطة المقاول، ثم يعرض المقترحات: المقبولة أولاً، ثم بقية المحاولات." },
    evaluate: { title: "تقييم البديل", empty: "اضغط «قيّم هذا البديل» لتقييم موجز للبديل المختار مقارنةً بقبل الأعمال وبخطة المقاول." },
    report: { title: "تقرير المراجعة", empty: "اضغط «أنشئ تقرير المراجعة» لتقرير كامل بالأقسام السبعة، يغطي خطة المقاول والمقترحات والتوصية." },
  };
  const docOf = (slot, cell) => (slot === "evaluate" ? docs.evaluate[cell] : docs[slot]) || null;

  function badge(d) {
    if (!d || !d.done || !d.check) return "";
    if (d.check.ok) return `<span class="check-badge ok" data-f="numcheck" data-ok="1">✓ الأرقام مطابقة لنتائج المحاكاة</span>`;
    return `<span class="check-badge bad" data-f="numcheck" data-ok="0">✕ أرقام غير موجودة في نتائج المحاكاة: <span class="num">${d.check.unknown.map(esc).join("، ")}</span></span>`;
  }
  function headHtml(slot, d) {
    const st = !d ? "" : d.error ? "تعذّر الإكمال" : d.done ? "اكتمل" : "يُكتب الآن…";
    const can = d && d.done && !d.error && d.md;
    return `<span class="doc-title">${DOC[slot].title}</span><span class="doc-status">${st}</span>${badge(d)}
      <span class="doc-tools"><button type="button" class="btn-ghost" data-act="copy" data-slot="${slot}" ${can ? "" : "disabled"}>نسخ</button>
      <button type="button" class="btn-ghost" data-act="dl" data-slot="${slot}" ${can ? "" : "disabled"}>تنزيل (Markdown)</button></span>`;
  }
  function bodyHtml(slot, d) {
    if (!d) return `<div class="doc-body empty compact">${DOC[slot].empty}</div>`;
    const body = d.error ? `<p class="err">${esc(d.error)}</p>` : md(d.md) + (d.done ? "" : '<span class="caret"></span>');
    return `<div class="doc-body" data-kind="${slot}">${body}</div>`;
  }
  function docPanel(slot, cell) {
    const d = docOf(slot, cell);
    return `<div class="doc" data-slot="${slot}" data-cell="${cell}"><div class="doc-head">${headHtml(slot, d)}</div>${bodyHtml(slot, d)}</div>`;
  }
  function refresh(slot, cell) {
    const el = document.querySelector(`.doc[data-slot="${slot}"]`);
    if (!el || (slot === "evaluate" && el.dataset.cell !== cell)) return;
    const d = docOf(slot, cell);
    el.querySelector(".doc-head").innerHTML = headHtml(slot, d);
    el.querySelector(".doc-body").outerHTML = bodyHtml(slot, d);
  }
  function qaHtml() {
    return qa.map((x) => `<div class="qa-item"><div class="qa-q">${esc(x.q)}</div>
      <div class="qa-a doc-body" style="min-height:0;padding:6px 4px">${x.error ? `<p class="err">${esc(x.error)}</p>` : md(x.a || "") + (x.done ? "" : '<span class="caret"></span>')}</div></div>`).join("");
  }
  function banner() {
    if (status.available === null) return `<div class="ai-banner">جارٍ التحقق من إعداد خدمة الذكاء الاصطناعي…</div>`;
    if (!status.available) return `<div class="ai-banner ai-off" role="status"><b>الذكاء الاصطناعي غير متاح</b>${esc(status.message)}</div>`;
    return "";
  }
  const disabled = () => (!status.available || busy ? "disabled" : "");

  /* ---------- step 3: suggestions + evaluate ---------- */
  function renderSuggest(el, c) {
    el.innerHTML = `
      <div class="ai-hero">
        <div class="ai-hero-side">
          <div class="eyebrow">الخطوة 3</div>
          <h2>مقترحات الذكاء الاصطناعي</h2>
          <p class="small muted">رُفضت خطة المقاول في وقت العمل المطلوب. يقترح الذكاء الاصطناعي تعديلات بالترتيب، ويستند كل حكم إلى نتائج المحاكاة المخزّنة.</p>
          ${banner()}
          <button type="button" class="btn ai-btn" data-run="suggest" ${disabled()}>اقترح بدائل</button>
        </div>
        ${docPanel("suggest", c.SUB)}
      </div>`;
  }
  function renderEvaluate(el, c) {
    el.innerHTML = `
      <div class="card eval-card">
        <div class="eval-head"><h3 style="margin:0">تقييم الذكاء الاصطناعي لهذا البديل</h3>
          <button type="button" class="btn secondary ai-btn" data-run="evaluate" ${disabled()}>قيّم هذا البديل</button></div>
        ${status.available ? "" : banner()}
        ${docPanel("evaluate", c.cellKey)}
      </div>`;
  }

  /* ---------- step 4: report + questions ---------- */
  function renderReport(el, c) {
    const { R, SUB, cellKey, helpers: h } = c;
    const sub = R.cells[SUB], selKey = cellKey, sel = R.cells[selKey], selD = selKey.split("@")[1];
    const selDiff = selKey !== SUB;
    el.innerHTML = `
      <div class="summary-strip">
        <div class="ss-item"><span class="ss-k">خطة المقاول</span><span class="ss-v">${h.timeOf("100")}</span></div>
        <div class="ss-item"><span class="ss-k">الحكم</span><span>${h.verdictPill(sub.verdict, true)}</span></div>
        <div class="ss-item"><span class="ss-k">السبب</span><span class="small">${h.reasonLine(sub)}</span></div>
        ${selDiff ? `<div class="ss-item"><span class="ss-k">البديل المختار</span><span class="ss-v">${esc(h.nameOf(selKey))} · ${h.timeOf(selD)}</span></div>
        <div class="ss-item"><span class="ss-k">حكمه</span><span>${h.verdictPill(sel.verdict, true)}</span></div>` : ""}
        <div class="ss-item"><span class="ss-k">مصدر الأرقام</span><span class="run">runs/${esc(sub.run)}${selDiff ? ` · runs/${esc(sel.run)}` : ""}</span></div>
        <button type="button" class="btn-ghost" data-go="3" style="margin-inline-start:auto">→ المقترحات</button>
      </div>
      <div class="ai-grid">
        <div class="panel">
          <div class="card"><h3>تقرير المراجعة</h3>${banner()}
            <div class="ai-actions" style="margin-top:12px">
              <button type="button" class="btn ai-btn" data-run="report" ${disabled()}>أنشئ تقرير المراجعة</button>
            </div></div>
          <div class="card"><h3>اسأل عن هذه المراجعة</h3>
            <form class="qa-form" id="qa-form">
              <textarea id="qa-input" placeholder="مثال: لماذا لا يكفي إغلاق مسار واحد بدل مسارين؟" ${status.available ? "" : "disabled"}></textarea>
              <div class="qa-suggest">${["ما القاعدة التي حسمت رفض خطة المقاول؟", "ما أفضل بديل في 16:00–20:00؟", "ما الاقتراب الأكثر تأثراً؟", "كم تكلفة تنفيذ الخطة؟"]
                .map((q) => `<button type="button" class="ai-btn" data-q="${esc(q)}" ${disabled()}>${h.timesHtml(q)}</button>`).join("")}</div>
              <button type="submit" class="btn ai-btn" ${disabled()}>أرسل السؤال</button>
            </form>
            <div class="qa-thread" id="qa-thread" style="margin-top:12px">${qaHtml()}</div>
          </div>
          ${h.limitsBlock(false)}
        </div>
        ${docPanel("report", SUB)}
      </div>
      <div class="step-nav" style="margin-top:16px"><button type="button" class="btn-ghost" data-go="3">→ المقترحات</button><span></span></div>`;
  }

  /* ---------- running ---------- */
  function setBusy(b) {
    busy = b;
    document.querySelectorAll(".ai-btn").forEach((e) => (e.disabled = b || !status.available));
  }
  async function runDoc(slot, cell) {
    const d = { kind: slot, cell, md: "", done: false };
    if (slot === "evaluate") docs.evaluate[cell] = d; else docs[slot] = d;
    setBusy(true); refresh(slot, cell);
    let pending = false;
    const ev = await stream({ action: slot, cell }, (t) => {
      d.md += t;
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; refresh(slot, cell); }); }
    }).catch(() => ({ type: "error", message: "تعذّر الاتصال بالخادم." }));
    if (ev.type === "error") d.error = ev.message; else { d.check = ev.numcheck; d.model = ev.model; }
    d.done = true;
    setBusy(false); refresh(slot, cell);
  }
  async function ask(q, cell) {
    const history = qa.filter((x) => x.done && !x.error).map((x) => ({ q: x.q, a: x.a }));
    const item = { q, a: "", done: false };
    qa.push(item);
    const redraw = () => { const t = document.getElementById("qa-thread"); if (t) t.innerHTML = qaHtml(); };
    setBusy(true); redraw();
    let pending = false;
    const ev = await stream({ action: "ask", cell, question: q, history }, (t) => {
      item.a += t;
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; redraw(); }); }
    }).catch(() => ({ type: "error", message: "تعذّر الاتصال بالخادم." }));
    if (ev.type === "error") item.error = ev.message;
    item.done = true;
    setBusy(false); redraw();
  }

  function currentCell() { return (window.__prova && `${window.__prova.S.plan}@${window.__prova.S.demand}`) || "works@100"; }

  function bindOnce() {
    document.addEventListener("click", async (e) => {
      const run = e.target.closest("[data-run]");
      if (run && !busy && status.available) {
        const slot = run.dataset.run;
        // Suggestions and the report cover the whole review; evaluate covers the selected alternative.
        return runDoc(slot, slot === "suggest" ? ((window.__prova && window.__prova.SUB) || "works@100") : currentCell());
      }
      const sq = e.target.closest(".qa-suggest [data-q]");
      if (sq && !busy && status.available) return ask(sq.dataset.q, currentCell());
      const act = e.target.closest("[data-act]");
      if (act) {
        const slot = act.dataset.slot, panel = act.closest(".doc"), d = docOf(slot, panel.dataset.cell);
        if (!d || !d.md) return;
        if (act.dataset.act === "copy") {
          try { await navigator.clipboard.writeText(d.md); act.textContent = "نُسخ ✓"; } catch { act.textContent = "تعذّر النسخ"; }
          setTimeout(() => (act.textContent = "نسخ"), 1600);
        } else {
          const blob = new Blob([d.md], { type: "text/markdown;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `prova_1064_${slot}${slot === "evaluate" ? "_" + d.cell.replace("@", "_") : ""}.md`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }
      }
    });
    document.addEventListener("submit", (e) => {
      if (e.target.id !== "qa-form") return;
      e.preventDefault();
      const inp = document.getElementById("qa-input"), q = inp.value.trim();
      if (!q || busy || !status.available) return;
      inp.value = ""; ask(q, currentCell());
    });
  }

  async function init(onReady) {
    bindOnce();
    try { status = await fetch("/api/ai/status").then((r) => r.json()); }
    catch { status = { available: false, message: "تعذّر الوصول إلى الخادم." }; }
    if (onReady) onReady();
  }

  window.ProvaAI = { init, renderSuggest, renderEvaluate, renderReport, _md: md };
})();
