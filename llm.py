"""Live LLM part: context built on the server from results.json, streamed with the Anthropic SDK.

Two ways to reach Claude, chosen from the environment (keys are never written to a file):
  OPENROUTER_API_KEY  -> OpenRouter's Anthropic-compatible Messages endpoint (used first if set)
  ANTHROPIC_API_KEY   -> the Anthropic API directly
"""
import json
import os
from typing import AsyncIterator

import anthropic

import content
import numcheck

OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api")
PROVIDERS = {
    "openrouter": {"env": "OPENROUTER_API_KEY", "model": os.environ.get("PROVA_MODEL", "anthropic/claude-opus-5.5")},
    "anthropic": {"env": "ANTHROPIC_API_KEY", "model": os.environ.get("PROVA_MODEL", "claude-opus-5-5")},
}


def provider() -> str | None:
    for name in ("openrouter", "anthropic"):
        if os.environ.get(PROVIDERS[name]["env"], "").strip():
            return name
    return None


def model_name() -> str | None:
    p = provider()
    return PROVIDERS[p]["model"] if p else None


EFFORT = {"suggest": "low", "evaluate": "low", "ask": "low", "report": "medium"}
MAX_TOKENS = {"suggest": 6000, "evaluate": 4000, "ask": 4000, "report": 16000}

REPORT_SECTIONS = [
    "ملخص القرار",
    "وصف الأعمال والخطة",
    "نتائج المحاكاة",
    "مقارنة البدائل",
    "التحقق من حدود الدليل",
    "الافتراضات والقيود",
    "التوصية",
]


def key_available() -> bool:
    return provider() is not None


def _time(demand: str) -> str:
    return f'{content.PERIODS[demand]["times"]} ({content.ASSUMED_TAG})'


def _minutes(seconds: float) -> float:
    """Average delay in minutes, one decimal, the same value the interface shows (317 s → 5.3)."""
    return float(f"{seconds / 60:.1f}")


def _full(results: dict, key: str) -> dict:
    """One cell without its heat array, named by plan and working time (never by demand level)."""
    plan, demand = key.split("@")
    cell = {k: v for k, v in results["cells"][key].items() if k != "heat"}
    return {"plan_label": content.PLANS[plan]["label"], "working_time": _time(demand),
            "avg_delay_min": _minutes(cell["avg"]), **cell}


def _compact(results: dict, key: str) -> dict:
    plan, demand = key.split("@")
    c = results["cells"][key]
    return {
        "plan_label": content.PLANS[plan]["label"],
        "working_time": _time(demand),
        "verdict": content.VERDICTS[c["verdict"]],
        "rules": {r["label"]: content.RULE_STATUS[c["rules"][r["key"]]] for r in content.RULES},
        "avg_delay_min": _minutes(c["avg"]),
        "inc_pct": c["inc_pct"],
        "inc_pct_range": c["inc_pct_range"],
        "vehh": c["vehh"],
        "queue_m": c["rules"]["queue_m"],
        "segment_extra_s": c["rules"]["segment_extra_s"],
        "run": c["run"],
    }


def build_context(results: dict, selected_key: str) -> dict:
    """The data block sent to the model on every call."""
    sub = content.SUBMISSION
    sub_cell = results["cells"][sub["cell"]]
    closed = [{k: w[k] for k in ("id", "label", "speed_kmh", "length_m")} for w in results["works"][sub_cell["net"]]]
    _, sel_demand = selected_key.split("@")

    ctx = {
        "case": content.CASE,
        "submission": {
            "description": sub["summary"],
            "networks_submitted": [f'{n["label"]}: {n["file"]}' for n in sub["networks"]],
            "requested_working_time": _time(sub["cell"].split("@")[1]),
            "closed_lanes": closed,
            "result": _full(results, sub["cell"]),
        },
        "before_works_at_requested_time": _full(results, sub["before_cell"]),
        "suggestion_ladder": [
            {"n": s["n"], "title": s["title"], "what_changes": s["change"], **_compact(results, s["cell"])}
            for s in content.ladder(results)
        ],
        "all_results_by_working_time": {
            content.PERIODS[d]["times"]: [_compact(results, f"{p}@{d}") for p in ["before"] + content.PLAN_ORDER]
            for d in content.PERIOD_ORDER
        },
    }
    if selected_key != sub["cell"]:
        ctx["selected_alternative"] = {
            "result": _full(results, selected_key),
            "before_works_same_time": _full(results, f"before@{sel_demand}"),
        }
    ctx.update({
        "field_meanings": {
            "vehh": "ساعات المركبات المفقودة في فترة 32 دقيقة (المتوسط، ومداه vehh_min إلى vehh_max عبر 5 بذور)",
            "avg": "متوسط التأخير لكل سيارة في التقاطع (ث)، ومداه avg_min إلى avg_max",
            "avg_delay_min": "متوسط التأخير لكل سيارة بالدقائق (رقم عشري واحد)، وهو ما يُعرض للمراجِع",
            "inc_pct": "زيادة متوسط التأخير عن قبل الأعمال في وقت العمل نفسه (%)، ومداه inc_pct_range عبر البذور",
            "median/p95": "التأخير لكل سيارة من الباب إلى الباب (ث)",
            "over5/over10": "نسبة السيارات التي تخسر أكثر من 5 / 10 دقائق (%)",
            "stuck": "سيارات ما زالت تنتظر دخول الخريطة في نهاية الفترة",
            "tele": "عدد مرات النقل الآني في SUMO",
            "greens": "زمن الأخضر بالثواني بالترتيب A, D, B, C",
            "cycle": "طول الدورة (ث)",
            "ap.delay": "تأخير الاقتراب (ث)",
            "ap.percyc": "السيارات المخدومة في الدورة",
            "ap.over10": "نسبة من يخسر أكثر من 10 دقائق على الاقتراب (%)",
            "ap.maxq": "أقصى طابور داخل الخريطة (م)",
            "ap.pend": "سيارات تنتظر خارج الخريطة",
            "ap.qtot": "الطابور الكلي شاملاً الجزء المقدَّر خارج الخريطة (م)",
            "run": "مجلد التشغيل تحت runs/ الذي حُسبت منه الأرقام (5 بذور)؛ اسم ملف يُنقل كما هو",
        },
        "approaches": content.APPROACHES,
        "rules": [{k: r[k] for k in ("label", "limit", "definition")} for r in content.RULES],
        "verdict_labels": content.VERDICTS,
        "rule_status_labels": content.RULE_STATUS,
        "working_times": [_time(d) for d in content.PERIOD_ORDER],
        "offpeak_note": content.OFFPEAK_NOTE,
        "limitations": content.LIMITATIONS,
    })
    return ctx


SYSTEM_PROMPT = f"""You are the review assistant on «بروفة», a prototype platform used by a reviewer at a permitting
authority to examine a contractor's road-works plan at one signalised junction. The contractor submitted the road
before the works and the planned works (two lanes closed southbound, the middle lane closed northbound) at the
requested working time. You receive a DATA block: precomputed results of a calibrated traffic simulation. You explain
those results; you do not produce new ones.

Rules you must follow in every answer:
1. Write in formal Arabic (فصحى). Use Western digits (0-9) only.
2. Use only the numbers in the DATA block, and quote them exactly as stored (same value, same decimals, no rounding,
   no new arithmetic such as differences, ratios or sums that are not already in the data). If the reader asks for
   something the data does not contain, write exactly «غير متوفر في نتائج المحاكاة».
3. Every verdict is already decided in the data. State it as given («مقبول» / «مرفوض» / «مرجع») and name the guide
   rule(s) that decided it (a rule marked «غير مستوفى» caused a rejection). Never produce, change or second-guess a verdict.
4. Anything assumed (the working times, the traffic in each working time, and the assumed items in the limitations)
   must be marked «{content.ASSUMED_TAG}».
5. Name working periods only by their times (for example 16:00–20:00). Never mention demand levels or percentages of
   demand, and never describe a period as a share of the peak. Run folder names (such as sb2_div_ret_demand70) are
   file identifiers: quote them verbatim when citing the source, and never interpret the numbers inside them.
6. Never mention a right turn from the south approach, in any form.
7. Whenever you recommend, or present as acceptable, an option that is accepted only outside 16:00–20:00, include
   this sentence verbatim: «{content.OFFPEAK_NOTE}».
8. When you suggest improvements, follow suggestion_ladder in its order: the accepted options come first, then the
   rejected ones (closing one lane southbound instead of two, then the diversion, then the signal retiming).
9. Refer to plans by their Arabic labels and to approaches by letter plus Arabic name (e.g. «D — المهندس مساعد العنقري من الجنوب»).
10. Do not invent field measurements, costs, dates, agency names or legal references.
11. Write rule results with their Arabic labels («مستوفى» / «غير مستوفى» / «مشروط»). Never print raw codes or field
    names such as pass, fail, rejected, inc_pct or queue_m.
12. Output Markdown. Do not number headings.
13. Give the average delay per car in minutes, quoting avg_delay_min exactly (for example «5.3 دقيقة»). Other delays
    (per approach, median, 95th percentile, segment) stay in seconds as stored."""

ACTION_INSTRUCTIONS = {
    "suggest": (
        "اكتب مقترحات الذكاء الاصطناعي للمراجِع (نحو 250 إلى 350 كلمة). ابدأ بفقرة قصيرة عن حكم خطة المقاول "
        "كما في البيانات والقاعدة التي حسمته. ثم اعرض المقترحات بترتيب suggestion_ladder بالضبط في قائمة مرقّمة، "
        "لكل مقترح: عنوانه، وما الذي يتغيّر، وحكمه كما في البيانات، والقاعدة الحاسمة إن رُفض، "
        "ومتوسط التأخير بالدقائق والزيادة عن قبل الأعمال. اختم بتوصية في سطرين تذكر الخيارات المقبولة وفق البيانات."
    ),
    "evaluate": (
        "اكتب تقييماً موجزاً للبديل في selected_alternative، أو لخطة المقاول إن لم يوجد بديل مختار "
        "(نحو 150 إلى 220 كلمة)، في فقرات قصيرة أو نقاط: الحكم كما في البيانات والقاعدة التي حسمته، "
        "وأهم الأرقام مقارنة بقبل الأعمال في وقت العمل نفسه، والاقتراب الأكثر تأثراً، ومقارنته بخطة المقاول، "
        "وتنبيه واحد من القيود. ابدأ مباشرة دون عنوان رئيسي."
    ),
    "ask": (
        "أجب عن سؤال المراجِع التالي عن هذه المراجعة إجابة مباشرة وموجزة، مستنداً إلى البيانات وحدها."
    ),
    "report": (
        "أنشئ تقرير مراجعة كاملاً لطلب المقاول. ابدأ بعنوان من المستوى الأول يذكر الإشارة 1064 ووقت العمل المطلوب، "
        "ثم الأقسام التالية بهذا الترتيب وبهذه العناوين بالضبط، كل منها عنوان من المستوى الثاني: "
        + "، ".join(REPORT_SECTIONS)
        + ". في «التحقق من حدود الدليل» اعرض جدولاً للقواعد الثلاث لخطة المقاول فيه القيمة والحد والحالة. "
        "في «مقارنة البدائل» اعرض جدولاً بمقترحات suggestion_ladder بترتيبها، مع خطة المقاول في أوله. "
        "إن وُجد selected_alternative فاذكر أنه البديل الذي اختاره المراجِع. "
        "اختم التقرير بسطر «مصدر الأرقام:» يذكر مجلدات التشغيل التي جاءت منها الأرقام المستخدمة."
    ),
}


def context_text(ctx: dict) -> str:
    return json.dumps(ctx, ensure_ascii=False, indent=1)


def build_messages(action: str, ctx_text: str, question: str | None, history: list[dict]) -> list[dict]:
    data_block = f"<DATA>\n{ctx_text}\n</DATA>"
    first_user = f"{data_block}\n\n{ACTION_INSTRUCTIONS[action]}"
    if action != "ask":
        return [{"role": "user", "content": first_user}]
    # Q&A: the data block rides on the first question; earlier turns follow as plain text.
    msgs: list[dict] = []
    turns = [h for h in history if h.get("q") and h.get("a")][-6:]
    for i, h in enumerate(turns):
        q = f"{first_user}\n\nالسؤال: {h['q']}" if i == 0 else h["q"]
        msgs.append({"role": "user", "content": q})
        msgs.append({"role": "assistant", "content": h["a"]})
    q = f"{first_user}\n\nالسؤال: {question}" if not msgs else question
    msgs.append({"role": "user", "content": q})
    return msgs


async def stream_answer(results: dict, cell_key: str, action: str, question: str | None,
                        history: list[dict]) -> AsyncIterator[dict]:
    """Yields {"type": "delta", "text": ...} events, then one {"type": "done", ...} or {"type": "error", ...}."""
    ctx_text = context_text(build_context(results, cell_key))
    messages = build_messages(action, ctx_text, question, history)
    prov = provider()
    key_env = PROVIDERS[prov]["env"]
    params = dict(
        model=PROVIDERS[prov]["model"],
        max_tokens=MAX_TOKENS[action],
        system=SYSTEM_PROMPT,
        messages=messages,
        thinking={"type": "adaptive"},
        output_config={"effort": EFFORT[action]},
    )
    if prov == "openrouter":
        # OpenRouter takes the key as a Bearer token; it routes between Claude hosts itself.
        client = anthropic.AsyncAnthropic(base_url=OPENROUTER_BASE_URL, api_key=None,
                                          auth_token=os.environ[key_env].strip())
        stream_ctx = client.messages.stream(**params)
    else:
        client = anthropic.AsyncAnthropic(api_key=os.environ[key_env].strip())
        # Anthropic's server-side refusal fallback (beta, Anthropic API only).
        stream_ctx = client.beta.messages.stream(**params, betas=["server-side-fallback-2026-07-01"],
                                                 fallbacks="default")
    parts: list[str] = []
    try:
        async with stream_ctx as stream:
            async for text in stream.text_stream:
                text = numcheck.normalise(text)  # keep Western digits if the model slips
                parts.append(text)
                yield {"type": "delta", "text": text}
            final = await stream.get_final_message()
        if final.stop_reason == "refusal":
            yield {"type": "error", "message": "امتنع النموذج عن الإجابة عن هذا الطلب."}
            return
        full = "".join(parts)
        yield {
            "type": "done",
            "stop_reason": final.stop_reason,
            "model": final.model,
            "numcheck": numcheck.check(full, ctx_text),
        }
    except anthropic.AuthenticationError:
        yield {"type": "error", "message": f"مفتاح {key_env} غير صالح. تحقّق من قيمته ثم أعد تشغيل الخادم."}
    except anthropic.RateLimitError:
        yield {"type": "error", "message": "تجاوزنا حدّ الطلبات المسموح مؤقتاً. حاول بعد قليل."}
    except anthropic.NotFoundError:
        yield {"type": "error", "message": f"النموذج {params['model']} غير متاح لدى مزوّد الخدمة."}
    except anthropic.APIStatusError as e:
        if e.status_code == 402:
            yield {"type": "error", "message": "رصيد حساب OpenRouter غير كافٍ لهذا الطلب. أضف رصيداً إلى الحساب ثم أعد المحاولة."}
            return
        yield {"type": "error", "message": f"أعادت خدمة النموذج خطأً (الرمز {e.status_code})."}
    except anthropic.APIConnectionError:
        yield {"type": "error", "message": "تعذّر الاتصال بخدمة النموذج. تحقّق من الاتصال بالإنترنت."}
