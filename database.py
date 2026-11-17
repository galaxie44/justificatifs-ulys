"""Stockage SQLite pour dossiers et reçus."""
from __future__ import annotations

import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "data" / "app.db"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS dossiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                share_token TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS receipts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dossier_id INTEGER NOT NULL,
                stored_filename TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                date_raw TEXT,
                date_iso TEXT,
                entree TEXT,
                sortie TEXT,
                km REAL,
                classe_tarif TEXT,
                prix_ht REAL,
                tva REAL,
                prix_ttc REAL,
                formule TEXT,
                badge TEXT,
                motif TEXT DEFAULT '',
                parsed_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (dossier_id) REFERENCES dossiers(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_receipts_dossier ON receipts(dossier_id);
            CREATE INDEX IF NOT EXISTS idx_dossiers_token ON dossiers(share_token);
            """
        )


def create_dossier(title: str, description: str = "") -> dict[str, Any]:
    token = secrets.token_urlsafe(24)
    now = _utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO dossiers (title, description, share_token, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (title.strip(), description.strip(), token, now, now),
        )
        dossier_id = cur.lastrowid
    return get_dossier(dossier_id)


def list_dossiers() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT d.*,
                   COUNT(r.id) AS receipt_count,
                   COALESCE(SUM(r.prix_ttc), 0) AS total_ttc,
                   COALESCE(SUM(r.km), 0) AS total_km
            FROM dossiers d
            LEFT JOIN receipts r ON r.dossier_id = d.id
            GROUP BY d.id
            ORDER BY d.updated_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def get_dossier(dossier_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM dossiers WHERE id = ?", (dossier_id,)).fetchone()
    return dict(row) if row else None


def get_dossier_by_token(token: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM dossiers WHERE share_token = ?", (token,)
        ).fetchone()
    return dict(row) if row else None


def update_dossier(dossier_id: int, title: str, description: str) -> None:
    with connect() as conn:
        conn.execute(
            """
            UPDATE dossiers
            SET title = ?, description = ?, updated_at = ?
            WHERE id = ?
            """,
            (title.strip(), description.strip(), _utc_now(), dossier_id),
        )


def delete_dossier(dossier_id: int) -> list[str]:
    """Supprime un dossier et retourne les noms de fichiers à effacer."""
    with connect() as conn:
        files = [
            r["stored_filename"]
            for r in conn.execute(
                "SELECT stored_filename FROM receipts WHERE dossier_id = ?",
                (dossier_id,),
            ).fetchall()
        ]
        conn.execute("DELETE FROM dossiers WHERE id = ?", (dossier_id,))
    return files


def add_receipt(dossier_id: int, stored: str, original: str, parsed: dict, motif: str = "") -> int:
    now = _utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO receipts (
                dossier_id, stored_filename, original_filename,
                date_raw, date_iso, entree, sortie, km, classe_tarif,
                prix_ht, tva, prix_ttc, formule, badge, motif, parsed_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                dossier_id,
                stored,
                original,
                parsed.get("date_raw"),
                parsed.get("date_iso"),
                parsed.get("entree"),
                parsed.get("sortie"),
                parsed.get("km"),
                parsed.get("classe_tarif"),
                parsed.get("prix_ht"),
                parsed.get("tva"),
                parsed.get("prix_ttc"),
                parsed.get("formule"),
                parsed.get("badge"),
                motif.strip(),
                json.dumps(parsed, ensure_ascii=False),
                now,
            ),
        )
        conn.execute(
            "UPDATE dossiers SET updated_at = ? WHERE id = ?",
            (now, dossier_id),
        )
        return int(cur.lastrowid)


def list_receipts(dossier_id: int) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM receipts
            WHERE dossier_id = ?
            ORDER BY COALESCE(date_iso, created_at) ASC, id ASC
            """,
            (dossier_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_receipt(receipt_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM receipts WHERE id = ?", (receipt_id,)).fetchone()
    return dict(row) if row else None


def update_receipt_motif(receipt_id: int, motif: str) -> None:
    with connect() as conn:
        row = conn.execute(
            "SELECT dossier_id FROM receipts WHERE id = ?", (receipt_id,)
        ).fetchone()
        if not row:
            return
        conn.execute(
            "UPDATE receipts SET motif = ? WHERE id = ?",
            (motif.strip(), receipt_id),
        )
        conn.execute(
            "UPDATE dossiers SET updated_at = ? WHERE id = ?",
            (_utc_now(), row["dossier_id"]),
        )


def delete_receipt(receipt_id: int) -> str | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT stored_filename, dossier_id FROM receipts WHERE id = ?",
            (receipt_id,),
        ).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))
        conn.execute(
            "UPDATE dossiers SET updated_at = ? WHERE id = ?",
            (_utc_now(), row["dossier_id"]),
        )
        return row["stored_filename"]


def dossier_stats(dossier_id: int) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS count,
                COALESCE(SUM(prix_ttc), 0) AS total_ttc,
                COALESCE(SUM(prix_ht), 0) AS total_ht,
                COALESCE(SUM(tva), 0) AS total_tva,
                COALESCE(SUM(km), 0) AS total_km
            FROM receipts
            WHERE dossier_id = ?
            """,
            (dossier_id,),
        ).fetchone()
    return dict(row)
