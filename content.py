"""Arabic labels and fixed texts used by both the interface and the model prompt.

Nothing here is a simulation number: all figures come from results.json.
The only numbers in this file are the guide limits, the assumed period times and the
facts listed in the brief's limitations section.
"""

PLANS = {
    "before": {
        "label": "قبل الأعمال",
        "desc": "المرجع: الطريق دون أعمال.",
    },
    "works": {
        "label": "الأعمال كما نُفّذت",
        "desc": "الخروج جنوباً بمسار واحد، والاقتراب شمالاً بمسارين.",
    },
    "sb2": {
        "label": "مساران جنوباً",
        "desc": "الإبقاء على مسارين للخروج جنوباً.",
    },
    "sb2_div": {
        "label": "مساران جنوباً + تحويل 10%",
        "desc": "مساران جنوباً، مع تحويل 10% من حركة الاقتراب شمالاً إلى طريق آخر.",
    },
    "sb2_div_ret": {
        "label": "مساران جنوباً + تحويل 10% + إعادة توقيت",
        "desc": "كالخطة السابقة، مع إعادة توزيع زمن الأخضر (52/52/37/32 ث).",
    },
}
PLAN_ORDER = ["works", "sb2", "sb2_div", "sb2_div_ret"]  # 'before' is reference only

# Working periods are shown by their times only (no demand levels). The keys are the
# results.json cell suffixes and are never shown.
PERIODS = {
    "100": {"label": "16:00–20:00", "times": "16:00–20:00"},
    "70": {"label": "10:00–13:00 و 22:00–00:00", "times": "10:00–13:00 و 22:00–00:00"},
    "50": {"label": "00:00–01:00 وقبل 06:30", "times": "00:00–01:00 وقبل 06:30"},
}
PERIOD_ORDER = ["100", "70", "50"]
ASSUMED_TAG = "افتراضي"
OFFPEAK_NOTE = "يصلح فقط إذا سمحت طبيعة الأعمال بإيقافها في الذروة"

# What the contractor submitted: the works as built, at the time they were done.
SUBMISSION = {
    "cell": "works@100",
    "before_cell": "before@100",
    "networks": [
        {"role": "before", "label": "شبكة الطريق قبل الأعمال", "file": "urubah_before_5lane.net.xml"},
        {"role": "after", "label": "شبكة الطريق بعد الأعمال (خطة المقاول)", "file": "urubah_after_5lane.net.xml"},
    ],
    "summary": "إغلاق مسارين في اتجاه الجنوب ومسار واحد (الأوسط) في اتجاه الشمال.",
}

# AI suggestion ladder. Cards 1–3 change the plan at the requested time; cards 4–5 move the
# works to another time and take the first plan (in PLAN_ORDER) whose stored verdict is accepted.
LADDER_STEPS = [
    {"kind": "plan", "cell": "sb2@100", "title": "إغلاق مسار واحد بدل مسارين جنوباً",
     "change": "يبقى مساران مفتوحان للخروج جنوباً بدل مسار واحد."},
    {"kind": "plan", "cell": "sb2_div@100", "title": "+ تحويل 10% من الحركة القادمة من الجنوب",
     "change": "مع إغلاق مسار واحد جنوباً، تُحوَّل 10% من الحركة القادمة من الجنوب إلى طريق آخر."},
    {"kind": "plan", "cell": "sb2_div_ret@100", "title": "+ إعادة توقيت الإشارة",
     "change": "مع ما سبق، يُعاد توزيع زمن الأخضر إلى 52/52/37/32 ث."},
    {"kind": "time", "demand": "70", "title": "تنفيذ الأعمال في 10:00–13:00 و 22:00–00:00",
     "change": "نقل وقت العمل خارج 16:00–20:00."},
    {"kind": "time", "demand": "50", "title": "تنفيذ الأعمال في 00:00–01:00 وقبل 06:30",
     "change": "نقل وقت العمل إلى الليل."},
]


def ladder(results: dict) -> list[dict]:
    """Resolve the ladder against results.json. Verdicts are only looked up, never derived."""
    out = []
    for i, step in enumerate(LADDER_STEPS, 1):
        item = {"n": i, **step}
        if step["kind"] == "time":
            d = step["demand"]
            chosen = next((p for p in PLAN_ORDER if results["cells"][f"{p}@{d}"]["verdict"] == "accepted"), None)
            item["cell"] = f"{chosen}@{d}" if chosen else f"{PLAN_ORDER[-1]}@{d}"
            item["found_accepted"] = chosen is not None
            if chosen and chosen != "works":
                # The plan itself changes too: name the plan as the headline, the move in time underneath.
                item["title"] = PLANS[chosen]["label"]
                item["change"] = "مع نقل وقت العمل خارج 16:00–20:00."
            item.pop("demand")
        out.append(item)
    # Accepted options first (stored verdicts only), each group keeping the ladder order; then renumber.
    out.sort(key=lambda it: results["cells"][it["cell"]]["verdict"] != "accepted")
    for i, it in enumerate(out, 1):
        it["n"] = i
    return out

APPROACHES = {
    "A": "طريق العروبة من الشرق",
    "B": "طريق العروبة من الغرب",
    "C": "المهندس مساعد العنقري من الشمال",
    "D": "المهندس مساعد العنقري من الجنوب",
}

RULES = [
    {
        "key": "queue",
        "field": "queue_m",
        "label": "طول الطابور",
        "unit": "م",
        "limit": "أقل من 1,500 م (مشروط بين 1,500 و2,500 م، ومرفوض فوق 2,500 م)",
        "definition": "أطول طابور على أي اقتراب، شاملاً الجزء المقدَّر خارج حدود الخريطة.",
    },
    {
        "key": "segment",
        "field": "segment_extra_s",
        "label": "التأخير على المقطع",
        "unit": "ث",
        "limit": "لا يزيد على 900 ث فوق المعتاد",
        "definition": "زيادة تأخير أسوأ اقتراب عن تأخيره قبل الأعمال عند الطلب نفسه.",
    },
    {
        "key": "junction",
        "field": "junction_inc_pct",
        "label": "تأخير التقاطع",
        "unit": "%",
        "limit": "لا تزيد الزيادة على 30%",
        "definition": "زيادة متوسط التأخير لكل سيارة في التقاطع عن قبل الأعمال عند الطلب نفسه.",
    },
]

VERDICTS = {"accepted": "مقبول", "rejected": "مرفوض", "reference": "مرجع"}
RULE_STATUS = {"pass": "مستوفى", "fail": "غير مستوفى", "conditional": "مشروط"}

LIMITATIONS = [
    "جميع الأرقام من محاكاة معايَرة لتقاطع واحد، وليست قياسات أُخذت أثناء الأعمال.",
    "المعايرة مبنية على عدٍّ بالعين في زيارتين ميدانيتين (12 و15 نوفمبر 2026)، وتطابق سعة كل اقتراب العدَّ بفارق نحو 10%.",
    "كل نتيجة تغطي فترة 32 دقيقة بطلب ثابت؛ والطوابير التي ما زالت تنمو ستكون أطول في فترة أطول.",
    "طول الطابور خارج حدود الخريطة مقدَّر من السيارات التي لم تتمكن من الدخول، وليس محاكى.",
    "لم تُنمذَج وجهة الحركة المحوَّلة ولا تأخيرها هناك.",
    "أوقات فترات العمل وحجم الحركة فيها افتراضية («افتراضي») إلى أن تُجرى عدّات ميدانية.",
    "خطة الإشارة ليوم 15 نوفمبر (A 55 / D 48 / B 40 / C 30 ث، الدورة 203 ث) مستخدمة في جميع الفترات.",
    "نسب الانعطاف، وإعدادات فجوة التتابع، ونسبة الوقت الذي يكون فيه المسار الأيمن مسدوداً على طريق العروبة قيم افتراضية مُلاءَمة مع العدّ.",
    "موقع المسارات المغلقة وطولها في الرسم تقريبيان (نحو 100 م جنوباً ونحو 94 م شمالاً في النموذج).",
]

CASE = {
    "title": "أعمال على الضلع الجنوبي لطريق المهندس مساعد العنقري عند تقاطعه مع طريق العروبة",
    "signal": "الإشارة 1064",
}


def public_content(results: dict) -> dict:
    """Everything the front end needs besides results.json."""
    return {
        "submission": SUBMISSION,
        "ladder": ladder(results),
        "plans": PLANS,
        "plan_order": PLAN_ORDER,
        "periods": PERIODS,
        "period_order": PERIOD_ORDER,
        "assumed_tag": ASSUMED_TAG,
        "offpeak_note": OFFPEAK_NOTE,
        "approaches": APPROACHES,
        "rules": RULES,
        "verdicts": VERDICTS,
        "rule_status": RULE_STATUS,
        "limitations": LIMITATIONS,
        "case": CASE,
    }
