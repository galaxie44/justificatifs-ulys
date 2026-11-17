"""Justificatifs Ulys — upload de reçus + lien public sans accès au compte Ulys."""
from __future__ import annotations

import os
import secrets
from io import BytesIO
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

import database as db
from ulys_parser import parse_ulys_pdf

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Persistance SQLite sur le volume Fly
db.DB_PATH = DATA_DIR / "app.db"

APP_NAME = os.getenv("APP_NAME", "Justificatifs Ulys")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000").rstrip("/")
MAX_UPLOAD_BYTES = 8 * 1024 * 1024

app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@app.on_event("startup")
def on_startup() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    db.init_db()


def _euro(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.2f} €".replace(".", ",")


def _km(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.1f} km".replace(".", ",")


templates.env.filters["euro"] = _euro
templates.env.filters["km"] = _km


def _public_base(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-proto")
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if host:
        scheme = forwarded or request.url.scheme or "https"
        if "fly.dev" in host or "localhost" not in host:
            scheme = forwarded or "https"
        return f"{scheme}://{host}".rstrip("/")
    return BASE_URL


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    dossiers = db.list_dossiers()
    return templates.TemplateResponse(
        request,
        "admin.html",
        {
            "app_name": APP_NAME,
            "dossiers": dossiers,
            "base_url": _public_base(request),
        },
    )


@app.post("/dossiers")
async def create_dossier(title: str = Form(...), description: str = Form("")):
    if not title.strip():
        return RedirectResponse("/", status_code=303)
    dossier = db.create_dossier(title, description)
    return RedirectResponse(f"/dossiers/{dossier['id']}", status_code=303)


@app.get("/dossiers/{dossier_id}", response_class=HTMLResponse)
async def dossier_page(request: Request, dossier_id: int):
    dossier = db.get_dossier(dossier_id)
    if not dossier:
        raise HTTPException(404, "Dossier introuvable")
    receipts = db.list_receipts(dossier_id)
    stats = db.dossier_stats(dossier_id)
    base = _public_base(request)
    return templates.TemplateResponse(
        request,
        "dossier_admin.html",
        {
            "app_name": APP_NAME,
            "dossier": dossier,
            "receipts": receipts,
            "stats": stats,
            "base_url": base,
            "share_url": f"{base}/j/{dossier['share_token']}",
        },
    )


@app.post("/dossiers/{dossier_id}/update")
async def update_dossier(
    dossier_id: int,
    title: str = Form(...),
    description: str = Form(""),
):
    if not db.get_dossier(dossier_id):
        raise HTTPException(404)
    db.update_dossier(dossier_id, title, description)
    return RedirectResponse(f"/dossiers/{dossier_id}", status_code=303)


@app.post("/dossiers/{dossier_id}/delete")
async def delete_dossier(dossier_id: int):
    files = db.delete_dossier(dossier_id)
    for name in files:
        path = UPLOAD_DIR / name
        if path.exists():
            path.unlink()
    return RedirectResponse("/", status_code=303)


@app.post("/dossiers/{dossier_id}/upload")
async def upload_receipts(
    dossier_id: int,
    files: list[UploadFile] = File(...),
    motif: str = Form(""),
):
    if not db.get_dossier(dossier_id):
        raise HTTPException(404)

    for upload in files:
        if not upload.filename:
            continue
        filename = upload.filename
        if not filename.lower().endswith(".pdf"):
            continue
        content = await upload.read()
        if len(content) > MAX_UPLOAD_BYTES:
            continue
        if not content.startswith(b"%PDF"):
            continue

        stored = f"{secrets.token_hex(16)}.pdf"
        dest = UPLOAD_DIR / stored
        dest.write_bytes(content)

        try:
            parsed = parse_ulys_pdf(dest).to_dict()
        except Exception:
            dest.unlink(missing_ok=True)
            continue

        db.add_receipt(dossier_id, stored, filename, parsed, motif=motif)

    return RedirectResponse(f"/dossiers/{dossier_id}", status_code=303)


@app.post("/receipts/{receipt_id}/motif")
async def update_motif(receipt_id: int, motif: str = Form("")):
    receipt = db.get_receipt(receipt_id)
    if not receipt:
        raise HTTPException(404)
    db.update_receipt_motif(receipt_id, motif)
    return RedirectResponse(f"/dossiers/{receipt['dossier_id']}", status_code=303)


@app.post("/receipts/{receipt_id}/delete")
async def delete_receipt(receipt_id: int):
    receipt = db.get_receipt(receipt_id)
    if not receipt:
        raise HTTPException(404)
    dossier_id = receipt["dossier_id"]
    stored = db.delete_receipt(receipt_id)
    if stored:
        path = UPLOAD_DIR / stored
        if path.exists():
            path.unlink()
    return RedirectResponse(f"/dossiers/{dossier_id}", status_code=303)


@app.get("/pdf/{receipt_id}")
async def admin_pdf(receipt_id: int):
    receipt = db.get_receipt(receipt_id)
    if not receipt:
        raise HTTPException(404)
    path = UPLOAD_DIR / receipt["stored_filename"]
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=receipt["original_filename"],
    )


@app.get("/j/{token}", response_class=HTMLResponse)
async def public_justification(request: Request, token: str):
    dossier = db.get_dossier_by_token(token)
    if not dossier:
        raise HTTPException(404, "Lien invalide ou expiré")
    receipts = db.list_receipts(dossier["id"])
    stats = db.dossier_stats(dossier["id"])
    return templates.TemplateResponse(
        request,
        "public.html",
        {
            "app_name": APP_NAME,
            "dossier": dossier,
            "receipts": receipts,
            "stats": stats,
            "token": token,
        },
    )


@app.get("/j/{token}/pdf/{receipt_id}")
async def public_pdf(token: str, receipt_id: int):
    dossier = db.get_dossier_by_token(token)
    if not dossier:
        raise HTTPException(404)
    receipt = db.get_receipt(receipt_id)
    if not receipt or receipt["dossier_id"] != dossier["id"]:
        raise HTTPException(404)
    path = UPLOAD_DIR / receipt["stored_filename"]
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=receipt["original_filename"],
    )


@app.get("/j/{token}/export.pdf")
async def export_justification_pdf(token: str):
    dossier = db.get_dossier_by_token(token)
    if not dossier:
        raise HTTPException(404)
    receipts = db.list_receipts(dossier["id"])
    stats = db.dossier_stats(dossier["id"])

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=1.5 * cm,
        rightMargin=1.5 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
        title=f"Justificatif — {dossier['title']}",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleFR",
        parent=styles["Heading1"],
        fontSize=16,
        spaceAfter=6,
    )
    sub_style = ParagraphStyle(
        "SubFR",
        parent=styles["Normal"],
        fontSize=10,
        textColor=colors.HexColor("#44515c"),
        spaceAfter=12,
    )
    cell = ParagraphStyle("Cell", parent=styles["Normal"], fontSize=8, leading=10)

    story = [
        Paragraph("Justificatif de frais de péage — Ulys", title_style),
        Paragraph(dossier["title"], styles["Heading2"]),
    ]
    if dossier.get("description"):
        story.append(Paragraph(dossier["description"].replace("\n", "<br/>"), sub_style))
    story.append(
        Paragraph(
            f"{stats['count']} trajet(s) · {_km(stats['total_km'])} · "
            f"Total TTC {_euro(stats['total_ttc'])} · HT {_euro(stats['total_ht'])} · "
            f"TVA {_euro(stats['total_tva'])}",
            sub_style,
        )
    )
    story.append(Spacer(1, 0.3 * cm))

    header = ["Date", "Entrée", "Sortie", "Km", "TTC", "Motif"]
    data = [header]
    for r in receipts:
        data.append(
            [
                Paragraph(r.get("date_raw") or "—", cell),
                Paragraph(r.get("entree") or "—", cell),
                Paragraph(r.get("sortie") or "—", cell),
                Paragraph(_km(r.get("km")), cell),
                Paragraph(_euro(r.get("prix_ttc")), cell),
                Paragraph(r.get("motif") or "—", cell),
            ]
        )

    table = Table(data, colWidths=[3.2 * cm, 3.8 * cm, 3.8 * cm, 1.8 * cm, 2 * cm, 3.6 * cm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f3d3e")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 9),
                ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f7faf8")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f7faf8"), colors.white]),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d5e0dc")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(table)
    story.append(Spacer(1, 0.8 * cm))
    story.append(
        Paragraph(
            "Document généré automatiquement à partir des reçus Ulys uploadés. "
            "Aucun accès au compte Ulys n’est nécessaire pour consulter ce justificatif. "
            "Les montants sont issus des reçus informatifs ; la facture mensuelle Ulys fait foi.",
            ParagraphStyle("Foot", parent=styles["Normal"], fontSize=8, textColor=colors.grey),
        )
    )
    doc.build(story)
    buffer.seek(0)
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in dossier["title"])[:40]
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="justificatif-{safe_name}.pdf"'},
    )


@app.get("/health")
async def health():
    return {"status": "ok", "app": APP_NAME}
