"""Check that every number in a generated text appears in the data the model was given."""
import re

_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩٫٬", "0123456789.,")
# A number: digits with optional thousands separators and an optional decimal part.
_NUM = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")


def normalise(text: str) -> str:
    return text.translate(_ARABIC_DIGITS)


def _canon(token: str) -> str:
    token = token.replace(",", "")
    if "." in token:
        token = token.rstrip("0").rstrip(".")
    return token.lstrip("0") or "0"


def numbers_in(text: str) -> list[str]:
    return [_canon(m.group(0)) for m in _NUM.finditer(normalise(text))]


def allowed_numbers(context_text: str) -> set[str]:
    """All numbers in the context. Signed values are covered because the sign is not part of the token."""
    return set(numbers_in(context_text))


def check(generated: str, context_text: str) -> dict:
    allowed = allowed_numbers(context_text)
    found = numbers_in(generated)
    unknown = sorted({n for n in found if n not in allowed}, key=lambda s: (len(s), s))
    return {"checked": len(found), "unknown": unknown, "ok": not unknown}
