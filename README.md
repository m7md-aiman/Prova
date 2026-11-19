# بروفة: مراجعة خطة التحويل، الإشارة 1064 (نموذج أولي)

A review platform for the signal 1064 detour experiment. The interface is in Arabic (right to left).

The flow has four steps:
1. **تقديم الطلب** (submission): the contractor's before network and planned works (2 lanes closed southbound,
   the middle lane closed northbound) at the requested time 16:00–20:00, shown side by side on the map.
2. **نتيجة المحاكاة** (simulation result): the planned works against before, with the verdict, the three guide
   rules, the headline figures and the per-approach table.
3. **مقترحات الذكاء الاصطناعي** (AI suggestions): a fixed ladder taken from the data. First close 1 lane instead
   of 2, then divert 10%, then retime the signal, then move the works to another time. A live AI explanation
   on request, a plan × time verdict grid, and the details of the selected alternative.
4. **التقرير** (report): a live review report (copy / download) and a question box.

Working periods are named by their times only («افتراضي»); demand levels are not shown.
The simulation results are precomputed and read from `results.json`. The app never runs SUMO.
The AI evaluation, Q&A and review report are generated live through the Anthropic API.

## Start

```powershell
cd prova_platform
python -m venv .venv                      # first time only
.venv\Scripts\python -m pip install -r requirements.txt   # first time only
$env:OPENROUTER_API_KEY = "sk-or-..."    # optional; or ANTHROPIC_API_KEY. Without either, the AI section says so in Arabic
.venv\Scripts\python -m uvicorn app:app --port 8000
```

Then open http://localhost:8000.

- Data: `data/results.json`, a byte-identical copy of `prova_1064_handoff/data/results.json` (so the folder
  deploys on its own). If `data/` is missing, the handoff copy next to this folder is used. `PROVA_DATA` overrides both.
- Sample file: `static/samples/urubah_after_5lane.net.xml`, a copy of the contractor's works network. The upload
  card offers it («استخدم الملف التجريبي») for visitors who do not have the file; it goes through the same checks.
- The key is read only from an environment variable and never written to a file:
  - `OPENROUTER_API_KEY`: requests go to OpenRouter's Anthropic-compatible endpoint, model `anthropic/claude-opus-5.5`. Used first if set.
  - `ANTHROPIC_API_KEY`: requests go to the Anthropic API directly, model `claude-opus-5-5`.
  - `PROVA_MODEL` overrides the model name.
- Leaflet and proj4js are bundled in `static/vendor/`, so the map works offline. Without internet the
  base tiles are replaced by the plain lane drawing, and the font falls back to a system Arabic font.

## Deploy on Vercel

The folder deploys as is: Vercel detects the FastAPI `app` in `app.py`, installs `requirements.txt`, and serves
`static/` from its CDN. `vercel.json` lets the AI stream run for up to 300 s (the full report takes 1–2 minutes).
`.vercelignore` leaves out `.venv/`, `tools/` and `walkthrough/`.

1. Install the CLI once: `npm i -g vercel`, then `vercel login`.
2. From this folder: `vercel` (first time: accept the defaults; it creates the project), then `vercel --prod`.
3. In the Vercel dashboard → Project → Settings → Environment Variables, add `OPENROUTER_API_KEY`
   (or `ANTHROPIC_API_KEY`) for Production, then redeploy (`vercel --prod`). Never put the key in a file.
4. Set a spending limit on the key at the provider. Without a key, the platform still works and the AI section
   says so in Arabic.

Connecting a GitHub repository in the Vercel dashboard works the same way (set the Root Directory to this folder
if the repository holds more than it).

## Files

| Path | What it does |
|---|---|
| `app.py` | FastAPI app. Serves `results.json` unchanged, the UI text, and the static files, and runs the streaming AI endpoint. |
| `llm.py` | Builds the model context on the server, holds the system prompt, and streams Claude through the Anthropic SDK, via OpenRouter or Anthropic. |
| `content.py` | Arabic labels, rule definitions, period times (marked «افتراضي») and the limitations list. |
| `numcheck.py` | Flags any number in generated text that is not in the data sent to the model. |
| `static/` | The front end: plain HTML, CSS and JS with no build step. |
| `data/results.json` | The simulation results (copy of the handoff file, unchanged). |
| `vercel.json`, `pyproject.toml`, `.python-version`, `.vercelignore` | Vercel deployment settings. |
| `tools/verify.py` | Playwright check of all 15 cells against `results_table.csv`, plus screenshots and an offline run. |

## Check

With the server running:

```powershell
.venv\Scripts\python -m pip install playwright   # first time only
.venv\Scripts\python -m playwright install chromium   # first time only
.venv\Scripts\python tools\verify.py
```
