"""Build-brief §13 checks for the four-step flow, run against a live server.

  python tools/verify.py [--base http://localhost:8000] [--out shots]

1 submission (before + planned works) → 2 simulation result → 3 AI suggestions → 4 report.
Opens every cell through the UI, compares what is displayed with results_table.csv (and
results.json for fields the CSV lacks), checks the suggestion ladder and the verdict grid,
works and heat layers, that no demand percentage appears anywhere, takes screenshots of the
four steps (wide and narrow), and repeats with the network blocked.
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent.parent
DATA = HERE.parent / "prova_1064_handoff" / "prova_1064_handoff" / "data"
WORKS_NET = HERE.parent / "prova_1064_handoff" / "prova_1064_handoff" / "networks" / "urubah_after_5lane.net.xml"
PLANS = ["works", "sb2", "sb2_div", "sb2_div_ret"]
DEMANDS = ["100", "70", "50"]
SUB = "works@100"
EXPECTED_VERDICT = {  # brief §13
    "100": {"works": "rejected", "sb2": "rejected", "sb2_div": "rejected", "sb2_div_ret": "rejected"},
    "70": {"works": "rejected", "sb2": "rejected", "sb2_div": "rejected", "sb2_div_ret": "accepted"},
    "50": {"works": "accepted", "sb2": "accepted", "sb2_div": "accepted", "sb2_div_ret": "accepted"},
}
# Accepted options first, then the rejected ones, the contractor's plan last.
EXPECTED_LADDER = ["sb2_div_ret@70", "works@50", "sb2@100", "sb2_div@100", "sb2_div_ret@100", "works@100"]
# A demand level written as a percentage (100% / 70% / 50%) or «نحو 70». Diversion «10%» is allowed.
DEMAND_PCT = re.compile(r"(?<![\d.])(?:100|70|50)\s*%|%\s*(?:100|70|50)(?![\d.])|نحو\s*(?:70|50)")

fails: list[str] = []
passes = 0


def check(cond: bool, msg: str):
    global passes
    if cond:
        passes += 1
    else:
        fails.append(msg)


def num(s: str) -> float:
    return float(s.replace("+", "").replace("%", "").replace(",", "").replace("−", "-").strip())


def same(shown: str | None, expected, label: str):
    if shown is None:
        fails.append(f"{label}: not shown")
        return
    try:
        ok = num(shown) == float(expected)
    except ValueError:
        ok = shown.strip() == str(expected)
    check(ok, f"{label}: shown {shown!r}, expected {expected!r}")


READ_FIELDS = """(sel) => {
  const root = document.querySelector(sel); const out = {};
  if (!root) return out;
  root.querySelectorAll('[data-f]').forEach(e => { const k = e.dataset.f; if (!(k in out)) out[k] = e.dataset.v || e.textContent.trim(); });
  return out;
}"""

CSV_FIELDS = [("inc", "increase_pct"), ("vehh", "vehh_lost"), ("median", "median_delay_s"), ("p95", "p95_delay_s"),
              ("cycle", "cycle_s"), ("tele", "teleports"), ("rule_queue_m", "queue_total_m"),
              ("rule_segment_s", "segment_extra_s")]


def minutes(sec) -> str:
    """The interface shows the average delay in minutes with one decimal."""
    return f"{float(sec) / 60:.1f}"


def goto(page, base, cell, step):
    page.goto(f"{base}/#cell={cell}&step={step}")
    page.wait_for_function("document.body.dataset.ready === '1'")
    page.wait_for_function(f"document.body.dataset.step === '{step}'")
    page.wait_for_timeout(250)


def check_result_block(page, root, k, r, c, table_root=None):
    """The verdict/rules/tiles/approach block, used on step 2 (submission) and step 3 (details)."""
    f = page.evaluate(READ_FIELDS, root)
    check(f.get("verdict") == r["verdict"], f"{k} verdict shown {f.get('verdict')} csv {r['verdict']}")
    for fld, col in CSV_FIELDS:
        same(f.get(fld), r[col], f"{k} {fld}")
    check(f.get("avg_min") == minutes(r["junction_avg_delay_s"]), f"{k} average delay shown {f.get('avg_min')} min, expected {minutes(r['junction_avg_delay_s'])}")
    check(page.locator(f"{root} .tile").count() == 4, f"{k} number cards: {page.locator(f'{root} .tile').count()}")
    heading = page.locator(f"{root} .rules").locator("xpath=..").locator("h3").text_content()
    check(heading == "شروط خطة الحركة المرورية الثلاث", f"{k} conditions heading is {heading!r}")
    check(page.locator(f"{root} .rule .r-val > small, {root} .t-sub").count() == 0, f"{k} small lines under numbers still shown")
    check(f.get("run") == f"runs/{r['run_folder']}", f"{k} run folder {f.get('run')}")
    g = r["greens_A_D_B_C"].split("/")
    check(f.get("greens") == f"A {g[0]} / D {g[1]} / B {g[2]} / C {g[3]}", f"{k} greens {f.get('greens')}")
    for rk in ["queue", "segment", "junction"]:
        stv = page.get_attribute(f'{root} .rule[data-rule="{rk}"]', "data-status")
        check(stv == r[f"rule_{rk}"], f"{k} rule {rk} shown {stv} csv {r['rule_' + rk]}")
    if r["verdict"] == "rejected":
        for rk, lab in [("queue", "طول الطابور"), ("segment", "التأخير على المقطع"), ("junction", "تأخير التقاطع")]:
            if r[f"rule_{rk}"] == "fail":
                check(lab in f.get("reason", ""), f"{k} reason does not name {lab}")
    d = k.split("@")[1]
    note = page.locator(f"{root} [data-f=offpeak]").count()
    check(note == (1 if (r["verdict"] == "accepted" and d != "100") else 0), f"{k} off-peak note count {note}")
    t = table_root or root
    for a in "ABCD":
        same(page.text_content(f'{t} .ap-table tr[data-ap="{a}"] [data-f=ap_delay]'), r[f"delay_{a}"], f"{k} delay_{a}")
        for fld in ["percyc", "over10", "maxq", "pend", "qtot"]:
            same(page.text_content(f'{t} .ap-table tr[data-ap="{a}"] [data-f=ap_{fld}]'), c["ap"][a][fld], f"{k} ap {a} {fld}")


def check_maps(page, k, res, heat: bool):
    """Split view: plan on #map-main, before at the same time on #map-ref."""
    d = k.split("@")[1]
    c, b = res["cells"][k], res["cells"][f"before@{d}"]
    check(page.get_attribute("#map-main", "data-cell") == k, f"{k} main map shows {page.get_attribute('#map-main', 'data-cell')}")
    wc = int(page.get_attribute("#map-main", "data-works-count"))
    check(wc == len(res["works"][c["net"]]), f"{k} works drawn {wc}")
    check(page.locator("#map-main .works-band").count() == wc, f"{k} works paths missing")
    hc = int(page.get_attribute("#map-main", "data-heat-count"))
    check(hc == (len(c["heat"]) // 5 if heat else 0), f"{k} heat pieces {hc}")
    check(page.get_attribute("#map-ref", "data-cell") == f"before@{d}", f"{k} reference map is not before@{d}")
    check(page.get_attribute("#map-ref", "data-works-count") == "0", f"before@{d} shows works")
    rhc = int(page.get_attribute("#map-ref", "data-heat-count"))
    check(rhc == (len(b["heat"]) // 5 if heat else 0), f"before@{d} heat pieces {rhc}")


def no_demand_pct(page, label):
    text = page.evaluate("document.body.innerText")
    hits = DEMAND_PCT.findall(text)
    check(not hits, f"{label}: demand percentage shown: {hits[:5]}")
    tech = [w for w in ("anthropic", "OpenRouter", "claude") if w.lower() in text.lower()]
    check(not tech, f"{label}: technical wording shown: {tech}")


def submit(page, base):
    """Step 1 starts with the upload: submit the contractor's works network and wait for the reveal."""
    page.goto(base + "/")
    page.wait_for_function("document.body.dataset.ready === '1'")
    if page.locator("#submitted").count():
        return
    page.set_input_files("#file-in", str(WORKS_NET))
    page.click("#btn-submit")
    page.wait_for_selector("#submitted", timeout=20000)
    page.wait_for_timeout(300)


def shot(page, path):
    """Whole-page screenshot. The window is stretched to the page height first and the maps are given
    time to redraw: Chromium's built-in full-page capture fires before the second (synced) map redraws."""
    vp = page.viewport_size
    h = page.evaluate("document.documentElement.scrollHeight")
    page.set_viewport_size({"width": vp["width"], "height": h})
    page.wait_for_timeout(1500)
    page.screenshot(path=path)
    page.set_viewport_size(vp)
    page.wait_for_timeout(300)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--out", default=str(HERE / "tools" / "shots"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    base = args.base

    rows = {f"{r['plan']}@{r['demand_pct']}": r for r in csv.DictReader(open(DATA / "results_table.csv", encoding="utf-8"))}
    res = json.loads((DATA / "results.json").read_text(encoding="utf-8"))
    console_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, locale="ar")
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" and "tile" not in m.text.lower() else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        # --- before submission: only the upload card, steps locked, nothing of the case shown ---
        page.goto(base + "/")
        page.wait_for_function("document.body.dataset.ready === '1'")
        page.wait_for_timeout(300)
        check(page.locator("#upload-card").is_visible(), "upload card not shown before submission")
        check(page.locator("#s1-workspace").is_hidden(), "map/details shown before submission")
        check(page.locator("#case-chip").is_hidden(), "case chip shown before submission")
        check(page.locator('#stepbar li[data-step="2"].locked').count() == 1, "step 2 not locked before submission")
        page.goto(base + "/#cell=works@100&step=3")
        page.wait_for_timeout(400)
        check(page.evaluate("document.body.dataset.step") == "1", "a locked step opened before submission")
        shot(page, str(out / "step1_upload_wide.png"))
        # a file that is not a road network is refused
        page.set_input_files("#file-in", str(DATA / "results_table.csv"))
        page.click("#btn-submit")
        page.wait_for_selector(".upload-err", timeout=15000)
        check("ليس شبكة طرق" in page.text_content(".upload-err"), "wrong file not rejected with a clear message")
        # the sample-file button loads the bundled works network, identical to the handoff file
        page.click("#btn-sample")
        page.wait_for_function("(document.querySelector('.picked') || {}).textContent?.includes('urubah_after_5lane.net.xml')", timeout=15000)
        check("urubah_after_5lane.net.xml" in page.text_content(".picked"), "sample button did not pick the sample file")
        check(page.locator("#btn-submit").is_enabled(), "submit not enabled after choosing the sample file")
        sample_size = page.evaluate("fetch('/static/samples/urubah_after_5lane.net.xml').then(r => r.arrayBuffer()).then(b => b.byteLength)")
        check(sample_size == WORKS_NET.stat().st_size, f"sample file size {sample_size} differs from the handoff file")
        # the real works network is read and accepted
        page.set_input_files("#file-in", str(WORKS_NET))
        page.click("#btn-submit")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(out / "step1_reading_wide.png"))
        page.wait_for_selector("#submitted", timeout=20000)
        stages = page.eval_on_selector_all("#stages li", "els => els.length") if page.locator("#stages").count() else 0
        sub_info = page.text_content("#submitted")
        for frag in ["urubah_after_5lane.net.xml", "716", "827"]:
            check(frag in sub_info, f"submitted card does not show {frag}")
        check(page.locator("#case-chip").is_visible(), "case chip hidden after submission")
        page.reload()
        page.wait_for_function("document.body.dataset.ready === '1'")
        page.wait_for_timeout(500)
        check(page.locator("#submitted").count() == 1, "submission lost after reload")
        check(page.evaluate("document.body.dataset.step") == "1", "page does not open on step 1")
        check(page.evaluate("document.body.dataset.cell") == SUB, "page does not open on the submission")
        check(page.evaluate("document.documentElement.dir") == "rtl", "document is not rtl")
        sub_text = page.text_content("#submitted")
        for f in ["urubah_before_5lane.net.xml", "urubah_after_5lane.net.xml", "16:00–20:00"]:
            check(f in sub_text, f"step 1 submission does not show {f}")
        check_maps(page, SUB, res, heat=False)
        proj = json.loads(page.get_attribute("#map-main", "data-proj-check"))
        check(proj["inside_view"] and proj["nearest_lane_m"] < 15, f"junction not on lanes: {proj}")
        print("projection check:", proj)
        no_demand_pct(page, "step 1")

        # --- step 2: the submission against before ---
        goto(page, base, SUB, 2)
        check_result_block(page, "#s2-panel", SUB, rows[SUB], res["cells"][SUB], table_root="#s2-below")
        check_maps(page, SUB, res, heat=True)
        no_demand_pct(page, "step 2")

        # --- step 3: ladder, grid, and every plan cell through the details block ---
        goto(page, base, SUB, 3)
        ladder = page.eval_on_selector_all("#ladder [data-cell]", "els => els.map(e => e.dataset.cell)")
        check(ladder == EXPECTED_LADDER, f"ladder order {ladder}")
        check(page.evaluate("document.body.dataset.cell") == "sb2_div_ret@70", "step 3 does not start on the first accepted option (sb2_div_ret@70)")
        for k in EXPECTED_LADDER:
            r = rows[k]
            f = page.evaluate(READ_FIELDS, f'#ladder [data-cell="{k}"]')
            check(f.get("verdict") == r["verdict"], f"ladder {k} verdict")
            check(f.get("avg_min") == minutes(r["junction_avg_delay_s"]), f"ladder {k} average delay {f.get('avg_min')}")
            for fld, col in [("inc", "increase_pct"), ("inc_min", "increase_pct_min"),
                             ("inc_max", "increase_pct_max"), ("rule_queue_m", "queue_total_m")]:
                same(f.get(fld), r[col], f"ladder {k} {fld}")
            check(f.get("run") == r["run_folder"], f"ladder {k} run")
            off = page.locator(f'#ladder [data-cell="{k}"] [data-f=offpeak]').count()
            check(off == (1 if r["verdict"] == "accepted" and not k.endswith("@100") else 0), f"ladder {k} off-peak note")
        grid = page.eval_on_selector_all("#vgrid [data-cell]", "els => els.map(e => [e.dataset.cell, e.className])")
        check(len(grid) == 12, f"verdict grid has {len(grid)} cells")
        for k, cls in grid:
            check(rows[k]["verdict"] in cls, f"grid {k} shows {cls}, csv {rows[k]['verdict']}")
        no_demand_pct(page, "step 3")

        for d in DEMANDS:
            for pl in PLANS:
                k = f"{pl}@{d}"
                check(rows[k]["verdict"] == EXPECTED_VERDICT[d][pl], f"{k} verdict not as brief §13")
                page.click(f'#vgrid [data-cell="{k}"]')
                page.wait_for_function(f"document.body.dataset.cell === '{k}'")
                page.wait_for_timeout(150)
                check_result_block(page, "#s3-details", k, rows[k], res["cells"][k])
                check_maps(page, k, res, heat=True)
                check(page.locator(f'#vgrid [data-cell="{k}"].sel').count() == 1, f"{k} not highlighted in grid")

        # --- AI availability ---
        status = page.evaluate("fetch('/api/ai/status').then(r => r.json())")
        goto(page, base, "sb2@100", 3)
        if status["available"]:
            check(page.locator('[data-run="suggest"]').is_enabled(), "suggest button disabled with a key")
        else:
            check(page.locator(".ai-off").first.is_visible(), "no-key message not shown")
            check(page.locator('[data-run="suggest"]').is_disabled(), "AI buttons enabled without a key")
        print("ai status:", status)

        # --- screenshots (wide) ---
        for step, cell in [(1, SUB), (2, SUB), (3, "sb2@100"), (4, "sb2@100")]:
            goto(page, base, cell, step)
            page.wait_for_timeout(1500)
            shot(page, str(out / f"step{step}_wide.png"))
            no_demand_pct(page, f"step {step}")
        goto(page, base, SUB, 2)
        page.click("#btn-works"); page.wait_for_timeout(1500)
        page.locator("#map-area").screenshot(path=str(out / "works_zone_submission.png"))
        goto(page, base, "sb2@100", 3)
        page.click("#btn-works"); page.wait_for_timeout(1500)
        page.locator("#map-area").screenshot(path=str(out / "works_zone_sb2_100.png"))

        # --- narrow ---
        narrow = browser.new_page(viewport={"width": 420, "height": 860}, locale="ar")
        narrow.on("pageerror", lambda e: console_errors.append(str(e)))
        submit(narrow, base)
        for step, cell in [(1, SUB), (2, SUB), (3, "sb2@100"), (4, "sb2@100")]:
            goto(narrow, base, cell, step)
            narrow.wait_for_timeout(1500)
            sw = narrow.evaluate("document.documentElement.scrollWidth"); iw = narrow.evaluate("window.innerWidth")
            check(sw <= iw, f"narrow step {step}: page scrolls sideways ({sw} > {iw})")
            shot(narrow, str(out / f"step{step}_narrow.png"))

        # --- offline ---
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="ar")
        ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
        off = ctx.new_page()
        off.on("pageerror", lambda e: console_errors.append("offline: " + str(e)))
        submit(off, base)
        goto(off, base, SUB, 2)
        off.wait_for_timeout(5000)
        check("no-tiles" in (off.get_attribute("#map-main", "class") or ""), "offline: no-tiles fallback not active")
        lanes = off.locator("#map-main svg path").count()
        check(lanes > 200, f"offline: only {lanes} paths drawn")
        shot(off, str(out / "offline_step2.png"))
        browser.close()

    check(not console_errors, f"console errors: {console_errors[:5]}")
    print(f"\npassed checks: {passes}")
    if fails:
        print(f"FAILED: {len(fails)}")
        for m in fails:
            print("  -", m)
        sys.exit(1)
    print("all checks passed")
    print("screenshots:", out)


if __name__ == "__main__":
    main()
