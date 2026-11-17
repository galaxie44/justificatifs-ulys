"""Parseur de reçus PDF Ulys (péages VINCI Autoroutes)."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path

from pypdf import PdfReader


@dataclass
class UlysReceipt:
    date_raw: str
    date_iso: str | None
    entree: str
    sortie: str
    km: float | None
    classe_tarif: str
    prix_ht: float | None
    tva: float | None
    prix_ttc: float | None
    formule: str
    badge: str
    source_filename: str

    def to_dict(self) -> dict:
        return asdict(self)


_MONEY_RE = re.compile(r"(\d+[.,]\d{2})\s*€")
_DATE_RE = re.compile(
    r"(\d{2}/\d{2}/\d{4})\s+à\s+(\d{1,2})h(\d{2})",
    re.IGNORECASE,
)
_PLAZA_RE = re.compile(r"^A\d+-.+", re.IGNORECASE)
_BADGE_RE = re.compile(r"\b(\d{3}\s+\d{2}\s+\d{7}\s+\d{5})\b")
_KM_RE = re.compile(r"^(\d+[.,]\d+)$")


def _parse_money(values: list[str]) -> tuple[float | None, float | None, float | None]:
    """Retourne (ttc, ht, tva) à partir des montants trouvés."""
    amounts = []
    for v in values:
        for m in _MONEY_RE.finditer(v):
            amounts.append(float(m.group(1).replace(",", ".")))
    if not amounts:
        return None, None, None
    # Sur les reçus Ulys : TTC apparaît souvent avant HT/TVA dans le bloc valeurs
    ttc = amounts[0] if amounts else None
    ht = amounts[1] if len(amounts) > 1 else None
    tva = amounts[2] if len(amounts) > 2 else None
    # Si 3 montants et TTC ≈ HT+TVA, ok ; sinon prendre le plus grand comme TTC
    if ht is not None and tva is not None and ttc is not None:
        if abs((ht + tva) - ttc) > 0.05:
            ordered = sorted(amounts, reverse=True)
            ttc = ordered[0]
            # recalcul approximatif
            rest = [a for a in amounts if a != ttc]
            if len(rest) >= 2:
                ht, tva = rest[0], rest[1]
    return ttc, ht, tva


def _to_iso(date_raw: str) -> str | None:
    m = _DATE_RE.search(date_raw)
    if not m:
        return None
    d, mo, y = m.group(1).split("/")
    hh = int(m.group(2))
    mm = m.group(3)
    return f"{y}-{mo}-{d}T{hh:02d}:{mm}:00"


def parse_ulys_pdf(path: str | Path) -> UlysReceipt:
    path = Path(path)
    reader = PdfReader(str(path))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    date_raw = ""
    for ln in lines:
        if _DATE_RE.search(ln):
            date_raw = ln
            break

    plazas = [ln for ln in lines if _PLAZA_RE.match(ln)]
    entree = plazas[0] if len(plazas) > 0 else ""
    sortie = plazas[1] if len(plazas) > 1 else ""

    km = None
    for ln in lines:
        if _KM_RE.match(ln):
            km = float(ln.replace(",", "."))
            break

    classe = ""
    for ln in lines:
        if re.fullmatch(r"\d+", ln):
            classe = ln
            break

    formule = ""
    for ln in lines:
        if ln.lower() in {"classic", "premium", "liber-t", "télépéage"} or ln == "Classic":
            formule = ln
            break
        if "classic" in ln.lower() and "formule" not in ln.lower():
            formule = ln
            break

    badge = ""
    m = _BADGE_RE.search(text)
    if m:
        badge = m.group(1)
    else:
        # fallback : ligne avec beaucoup de chiffres
        for ln in lines:
            digits = re.sub(r"\D", "", ln)
            if len(digits) >= 15:
                badge = ln
                break

    ttc, ht, tva = _parse_money(lines)

    return UlysReceipt(
        date_raw=date_raw,
        date_iso=_to_iso(date_raw) if date_raw else None,
        entree=entree,
        sortie=sortie,
        km=km,
        classe_tarif=classe,
        prix_ht=ht,
        tva=tva,
        prix_ttc=ttc,
        formule=formule or "Classic",
        badge=badge,
        source_filename=path.name,
    )
