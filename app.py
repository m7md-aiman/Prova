"""بروفة — signal 1064 review platform (prototype).

Start:  .venv\\Scripts\\python -m uvicorn app:app --port 8000
"""
import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import content
import llm

HERE = Path(__file__).resolve().parent
# results.json: PROVA_DATA if set, else the byte-identical copy bundled in data/ (used when deployed),
# else the handoff folder next to this one.
_BUNDLED = HERE / "data" / "results.json"
_HANDOFF = HERE.parent / "prova_1064_handoff" / "prova_1064_handoff" / "data" / "results.json"
DATA_FILE = Path(os.environ.get("PROVA_DATA") or (_BUNDLED if _BUNDLED.exists() else _HANDOFF))

RESULTS: dict = json.loads(DATA_FILE.read_text(encoding="utf-8"))
RESULTS_BYTES = DATA_FILE.read_bytes()  # served unchanged

app = FastAPI(title="بروفة — نموذج أولي", docs_url=None, redoc_url=None)


@app.middleware("http")
async def no_stale_pages(request, call_next):
    """Make the browser re-check the page, scripts and styles on every load, so changes show up."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/ai/stream"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html")


@app.get("/api/results")
def results():
    """results.json exactly as delivered."""
    return Response(content=RESULTS_BYTES, media_type="application/json; charset=utf-8")


@app.get("/api/content")
def ui_content():
    return content.public_content(RESULTS)


@app.get("/api/ai/status")
def ai_status():
    if llm.key_available():
        return {"available": True, "model": llm.model_name(), "provider": llm.provider()}
    # Visitors see a plain Arabic notice; the operator finds the variable names in the server log and README.
    return {
        "available": False,
        "message": "قسم الذكاء الاصطناعي غير مفعّل حالياً: لم يُضبط مفتاح خدمة الذكاء الاصطناعي على الخادم. "
                   "بقية المنصة تعمل كالمعتاد.",
    }


if not llm.key_available():
    print("[prova] AI disabled: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY in the server environment.", flush=True)


class HistoryItem(BaseModel):
    q: str = Field(max_length=2000)
    a: str = Field(max_length=20000)


class AIRequest(BaseModel):
    action: str
    cell: str = content.SUBMISSION["cell"]  # the alternative the reviewer selected; defaults to the submitted plan
    question: str | None = Field(default=None, max_length=2000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=10)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@app.post("/api/ai/stream")
async def ai_stream(req: AIRequest):
    if req.action not in llm.ACTION_INSTRUCTIONS:
        raise HTTPException(400, "unknown action")
    plan = req.cell.partition("@")[0]
    if req.cell not in RESULTS["cells"] or plan not in content.PLAN_ORDER:
        raise HTTPException(400, "unknown cell")
    if req.action == "ask" and not (req.question or "").strip():
        raise HTTPException(400, "empty question")

    async def gen():
        if not llm.key_available():
            yield _sse({"type": "error", "message": ai_status()["message"]})
            return
        async for ev in llm.stream_answer(RESULTS, req.cell, req.action, req.question,
                                          [h.model_dump() for h in req.history]):
            yield _sse(ev)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
