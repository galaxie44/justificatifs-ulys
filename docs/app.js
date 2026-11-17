const SUPABASE_URL = "https://lljycdhijeuizzizuceh.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsanljZGhpamV1aXp6aXp1Y2VoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MTgxNzQsImV4cCI6MjExMDQ5NDE3NH0.o-0oRw3lRvU3l_b4jt_LCRNTM7aqQa9ju0jmyOUSpUw";

const MOIS = [
  "",
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];
const YEARS = [2026, 2027];
const CACHE_TTL_MS = 60_000;

const app = document.getElementById("app");
const now = new Date();
const CURRENT_YEAR = now.getFullYear();
const CURRENT_MONTH = now.getMonth() + 1;

const cache = new Map();
let navToken = 0;

const euro = (v) =>
  v == null || Number.isNaN(Number(v))
    ? "—"
    : `${Number(v).toFixed(2).replace(".", ",")} €`;
const km = (v) =>
  v == null || Number.isNaN(Number(v))
    ? "—"
    : `${Number(v).toFixed(1).replace(".", ",")} km`;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    ...extra,
  };
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

function invalidateCaches(year, month) {
  if (year != null) cache.delete(`year:${year}`);
  if (year != null && month != null) cache.delete(`month:${year}:${month}`);
}

async function api(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...headers(options.headers || {}),
      ...(options.body
        ? { "Content-Type": "application/json", Prefer: "return=representation" }
        : {}),
    },
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  return res.json();
}

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

/** 1 seule requête SQL agrégée pour toute l'année */
async function monthTotals(year) {
  const key = `year:${year}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const rows = (await rpc("year_month_stats", { p_year: year })) || [];
  const out = {};
  for (const r of rows) {
    out[r.month] = {
      id: r.id,
      count: Number(r.receipt_count) || 0,
      total: Number(r.total_ttc) || 0,
    };
  }
  return cacheSet(key, out);
}

/** 1 seule requête : dossier + reçus embarqués */
async function getMonthBundle(year, month) {
  const key = `month:${year}:${month}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const rows = await api(
    `dossiers?year=eq.${year}&month=eq.${month}&select=id,title,description,share_token,year,month,receipts(*)&limit=1`
  );
  const dossier = rows?.[0];
  if (!dossier) throw new Error("Dossier du mois introuvable.");

  const receipts = [...(dossier.receipts || [])].sort((a, b) =>
    String(a.date_iso || a.created_at || "").localeCompare(
      String(b.date_iso || b.created_at || "")
    )
  );
  const stats = {
    count: receipts.length,
    total_ttc: receipts.reduce((s, r) => s + (r.prix_ttc || 0), 0),
    total_ht: receipts.reduce((s, r) => s + (r.prix_ht || 0), 0),
    total_tva: receipts.reduce((s, r) => s + (r.tva || 0), 0),
    total_km: receipts.reduce((s, r) => s + (r.km || 0), 0),
    receipts,
  };
  const { receipts: _drop, ...dossierMeta } = dossier;
  return cacheSet(key, { dossier: dossierMeta, stats });
}

function publicPdfUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/receipts/${path}`;
}

async function uploadStorage(path, file) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/receipts/${path}`, {
    method: "POST",
    headers: {
      ...headers({ "Content-Type": "application/pdf" }),
      "x-upsert": "false",
    },
    body: file,
  });
  if (!res.ok) throw new Error(await res.text());
}

function parseUlysText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s+à\s+(\d{1,2})h(\d{2})/i);
  let date_raw = "",
    date_iso = null;
  if (dateMatch) {
    date_raw = dateMatch[0];
    const [d, mo, y] = dateMatch[1].split("/");
    date_iso = `${y}-${mo}-${d}T${String(dateMatch[2]).padStart(2, "0")}:${dateMatch[3]}:00`;
  }
  const plazas = lines.filter((l) => /^A\d+-/i.test(l));
  const kmLine = lines.find((l) => /^\d+[.,]\d+$/.test(l));
  const money = [...text.matchAll(/(\d+[.,]\d{2})\s*€/g)].map((m) =>
    parseFloat(m[1].replace(",", "."))
  );
  const badgeMatch = text.match(/\b(\d{3}\s+\d{2}\s+\d{7}\s+\d{5})\b/);
  return {
    date_raw,
    date_iso,
    entree: plazas[0] || "",
    sortie: plazas[1] || "",
    km: kmLine ? parseFloat(kmLine.replace(",", ".")) : null,
    classe_tarif: lines.find((l) => /^\d+$/.test(l)) || "",
    prix_ttc: money[0] ?? null,
    prix_ht: money[1] ?? null,
    tva: money[2] ?? null,
    formule:
      lines.find((l) => /classic|premium|liber-t/i.test(l) && !/formule/i.test(l)) ||
      "Classic",
    badge: badgeMatch ? badgeMatch[1] : "",
  };
}

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs"
    ).then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs";
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}

async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const texts = await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, i) => {
      const page = await pdf.getPage(i + 1);
      const content = await page.getTextContent();
      return content.items.map((it) => it.str).join("\n");
    })
  );
  return texts.join("\n");
}

function appUrl() {
  return `${location.origin}${location.pathname.replace(/\/$/, "")}/`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}
function safeName(s) {
  return String(s || "fichier")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

/** Nom lisible : 01_2026-11-15_A11-Angers_vers_A11-Nantes_9.80e.pdf */
function receiptPdfName(r, idx = 0) {
  let datePart = "";
  if (r.date_iso) {
    datePart = r.date_iso.slice(0, 10);
  } else if (r.date_raw) {
    const m = String(r.date_raw).match(/(\d{2})\/(\d{2})\/(\d{4})/);
    datePart = m ? `${m[3]}-${m[2]}-${m[1]}` : safeName(r.date_raw);
  } else {
    datePart = `trajet-${idx + 1}`;
  }
  const from = safeName(r.entree || "entree") || "entree";
  const to = safeName(r.sortie || "sortie") || "sortie";
  const amount =
    r.prix_ttc != null && !Number.isNaN(Number(r.prix_ttc))
      ? `${Number(r.prix_ttc).toFixed(2)}e`
      : "";
  const parts = [
    String(idx + 1).padStart(2, "0"),
    datePart,
    `${from}_vers_${to}`,
  ];
  if (amount) parts.push(amount);
  return `${parts.join("_")}.pdf`;
}

async function downloadMonthZip(label, stats, button) {
  if (!stats.receipts.length) {
    alert("Aucun reçu à télécharger pour ce mois.");
    return;
  }
  const old = button.textContent;
  button.disabled = true;
  button.textContent = "Préparation du ZIP…";
  try {
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
    const zip = new JSZip();
    const folder = zip.folder(safeName(label));

    button.textContent = "Téléchargement des PDF…";
    const used = new Set();
    const blobs = await Promise.all(
      stats.receipts.map(async (r, idx) => {
        const res = await fetch(publicPdfUrl(r.stored_filename));
        if (!res.ok) throw new Error(`Impossible de récupérer le PDF n°${idx + 1}`);
        const blob = await res.blob();
        let name = receiptPdfName(r, idx);
        if (used.has(name)) {
          name = name.replace(/\.pdf$/i, `_${idx + 1}.pdf`);
        }
        used.add(name);
        return { name, blob };
      })
    );
    for (const f of blobs) folder.file(f.name, f.blob);

    button.textContent = "Création du ZIP…";
    const content = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(content);
    a.download = `${safeName(label)}_justificatifs-ulys.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    button.textContent = "ZIP téléchargé ✓";
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
    button.textContent = old;
  } finally {
    button.disabled = false;
    setTimeout(() => {
      if (button.textContent.includes("✓")) button.textContent = old;
    }, 2000);
  }
}

async function downloadNamedPdf(r, idx) {
  const res = await fetch(publicPdfUrl(r.stored_filename));
  if (!res.ok) throw new Error("Téléchargement impossible");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = receiptPdfName(r, idx);
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFiles(files, dossier, motif = "Déplacement ADLB") {
  const pdfs = [...files].filter((f) => f?.name?.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) throw new Error("Choisissez au moins un PDF Ulys.");

  // Parse en parallèle, puis upload/insert
  const parsedList = await Promise.all(
    pdfs.map(async (file) => ({
      file,
      parsed: parseUlysText(await extractPdfText(file)),
      stored: `${crypto.randomUUID()}.pdf`,
    }))
  );

  await Promise.all(
    parsedList.map(async ({ file, stored }) => {
      await uploadStorage(stored, file);
    })
  );

  await api("receipts", {
    method: "POST",
    body: JSON.stringify(
      parsedList.map(({ file, parsed, stored }) => ({
        dossier_id: dossier.id,
        stored_filename: stored,
        original_filename: file.name,
        ...parsed,
        motif,
      }))
    ),
  });

  await api(`dossiers?id=eq.${dossier.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  });

  invalidateCaches(dossier.year, dossier.month);
  return parsedList.length;
}

function route() {
  const token = ++navToken;
  const hash = location.hash.replace(/^#/, "") || "/";
  const month = hash.match(/^\/(\d{4})\/(\d{1,2})$/);
  if (month) return renderMonth(Number(month[1]), Number(month[2]), token);
  const year = hash.match(/^\/(\d{4})$/);
  if (year) return renderYear(Number(year[1]), token);
  return renderHome();
}

const LOGO = "assets/adlb-logo.png";

function brand(title, subtitle, backHref = null) {
  return `
    <div class="top-simple">
      <div>
        ${backHref ? `<a class="back" href="${backHref}">← Retour</a>` : ""}
        <h1 style="margin-top:${backHref ? "0.15rem" : "0"}">${title}</h1>
        ${subtitle ? `<p class="muted small" style="margin:0.25rem 0 0">${subtitle}</p>` : ""}
      </div>
      <img class="logo-mini" src="${LOGO}" alt="ADLB" width="48" height="48" />
    </div>
  `;
}

function renderHome() {
  const defaultYear = YEARS.includes(CURRENT_YEAR) ? CURRENT_YEAR : 2026;
  app.innerHTML = `
    <div class="hero">
      <img class="logo-hero" src="${LOGO}" alt="Adour Dax Landes Basket" width="118" height="118" />
      <h1>Justificatifs ADLB</h1>
      <p>Notes de frais Ulys · Adour Dax Landes Basket</p>
    </div>

    <div class="card">
      <p class="section-label">Choisir une année</p>
      <div class="year-grid">
        ${YEARS.map(
          (y) => `
          <a class="year-card ${y === defaultYear ? "current" : ""}" href="#/${y}">
            <strong>${y}</strong>
            <span>${y === CURRENT_YEAR ? "Année en cours" : y === CURRENT_YEAR + 1 ? "Année prochaine" : ""}</span>
          </a>`
        ).join("")}
      </div>
    </div>
    <p class="footer-note">Année → mois · consultez les trajets · téléchargez le dossier ZIP.</p>
  `;
  monthTotals(defaultYear).catch(() => {});
}

async function renderYear(year, token = navToken) {
  if (!YEARS.includes(year)) {
    location.hash = "#/";
    return;
  }
  const cached = cacheGet(`year:${year}`);
  if (!cached) {
    app.innerHTML = `${brand(String(year), "Chargement…", "#/")}<div class="center muted">Chargement…</div>`;
  }
  try {
    const totals = await monthTotals(year);
    if (token !== navToken) return;
    app.innerHTML = `
      ${brand(String(year), "Choisissez un mois pour consulter ou télécharger", "#/")}
      <div class="month-grid">
        ${Array.from({ length: 12 }, (_, i) => i + 1)
          .map((m) => {
            const info = totals[m] || { count: 0, total: 0 };
            const isCurrent = year === CURRENT_YEAR && m === CURRENT_MONTH;
            return `
              <a class="month-card ${isCurrent ? "current" : ""}" href="#/${year}/${m}">
                <strong>${MOIS[m]}</strong>
                <span>${info.count ? `${info.count} trajet${info.count > 1 ? "s" : ""} · ${euro(info.total)}` : "Vide"}</span>
              </a>`;
          })
          .join("")}
      </div>
    `;
    // Prefetch du mois courant / novembre si données
    const hot = totals[CURRENT_YEAR === year ? CURRENT_MONTH : 11];
    if (hot?.count) getMonthBundle(year, CURRENT_YEAR === year ? CURRENT_MONTH : 11).catch(() => {});
  } catch (err) {
    if (token !== navToken) return;
    app.innerHTML = `${brand(String(year), "Erreur", "#/")}<div class="card status err">${escapeHtml(err.message)}</div>`;
  }
}

async function renderMonth(year, month, token = navToken) {
  if (!YEARS.includes(year) || month < 1 || month > 12) {
    location.hash = "#/";
    return;
  }
  const label = `${MOIS[month]} ${year}`;
  const cached = cacheGet(`month:${year}:${month}`);
  if (!cached) {
    app.innerHTML = `${brand(label, "Chargement…", `#/${year}`)}<div class="center muted">Chargement…</div>`;
  }
  try {
    const { dossier, stats } = await getMonthBundle(year, month);
    if (token !== navToken) return;

    app.innerHTML = `
      ${brand(label, "Consulter · télécharger · ajouter des reçus", `#/${year}`)}

      <div class="stats">
        <div class="stat"><span>Trajets</span><strong>${stats.count}</strong></div>
        <div class="stat"><span>Km</span><strong>${km(stats.total_km)}</strong></div>
        <div class="stat stat-total"><span>Total</span><strong>${euro(stats.total_ttc)}</strong></div>
      </div>

      <div class="card">
        <button class="btn btn-primary btn-lg" type="button" id="dlZip" ${stats.count ? "" : "disabled"}>
          Télécharger le dossier complet (ZIP)
        </button>
        <p class="muted small" style="margin:0.7rem 0 0">PDF du mois uniquement, renommés automatiquement.</p>
      </div>

      <div class="card">
        <h2>Reçus du mois</h2>
        ${
          stats.receipts.length
            ? stats.receipts
                .map(
                  (r, idx) => `
            <div class="trip">
              <div class="row">
                <div class="main">${escapeHtml(r.entree || "?")} → ${escapeHtml(r.sortie || "?")}</div>
                <div class="amount">${euro(r.prix_ttc)}</div>
              </div>
              <div class="meta">${escapeHtml(r.date_raw || "—")} · ${km(r.km)}</div>
              <div class="meta" style="margin-top:0.45rem">
                <button class="btn btn-secondary" type="button" data-dl-pdf="${idx}">Télécharger ce PDF</button>
              </div>
            </div>`
                )
                .join("")
            : `<p class="muted center" style="margin:0">Aucun reçu pour ce mois.</p>`
        }
      </div>

      <div class="card no-print">
        <h2>Ajouter des reçus</h2>
        <div class="drop" id="drop">
          <strong>Déposez vos reçus PDF ici</strong>
          <span>ou touchez pour choisir les fichiers</span>
          <input id="files" type="file" accept="application/pdf,.pdf" multiple />
        </div>
        <div class="field">
          <label for="motif">Motif (optionnel)</label>
          <input id="motif" value="Déplacement ADLB" />
        </div>
        <p class="status" id="status"></p>
      </div>
    `;

    document.getElementById("dlZip").onclick = (e) =>
      downloadMonthZip(label, stats, e.currentTarget);

    app.querySelectorAll("[data-dl-pdf]").forEach((btn) => {
      btn.onclick = async () => {
        const idx = Number(btn.getAttribute("data-dl-pdf"));
        const old = btn.textContent;
        btn.disabled = true;
        try {
          await downloadNamedPdf(stats.receipts[idx], idx);
        } catch (err) {
          alert(err.message || String(err));
        } finally {
          btn.disabled = false;
          btn.textContent = old;
        }
      };
    });

    const drop = document.getElementById("drop");
    const input = document.getElementById("files");
    const status = document.getElementById("status");
    const run = async (fileList) => {
      status.className = "status";
      status.textContent = "Analyse en cours…";
      drop.style.pointerEvents = "none";
      try {
        const motif =
          document.getElementById("motif").value.trim() || "Déplacement ADLB";
        const ok = await importFiles(fileList, dossier, motif);
        status.className = "status ok";
        status.textContent = `${ok} reçu(s) ajouté(s)`;
        route();
      } catch (err) {
        status.className = "status err";
        status.textContent = err.message || String(err);
        drop.style.pointerEvents = "";
      }
    };
    drop.onclick = () => input.click();
    input.onchange = () => input.files?.length && run(input.files);
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    };
    drop.ondragleave = () => drop.classList.remove("drag");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
      if (e.dataTransfer.files?.length) run(e.dataTransfer.files);
    };
  } catch (err) {
    if (token !== navToken) return;
    app.innerHTML = `${brand(label, "Erreur", `#/${year}`)}<div class="card status err">${escapeHtml(err.message)}</div>`;
  }
}

window.addEventListener("hashchange", route);
route();
