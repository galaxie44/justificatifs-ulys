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
const app = document.getElementById("app");
const now = new Date();
const CURRENT_YEAR = now.getFullYear();
const CURRENT_MONTH = now.getMonth() + 1;

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

async function extractPdfText(file) {
  const pdfjsLib = await import(
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs"
  );
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs";
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join("\n") + "\n";
  }
  return text;
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

async function getDossier(year, month) {
  const rows = await api(
    `dossiers?year=eq.${year}&month=eq.${month}&select=*&limit=1`
  );
  return rows?.[0] || null;
}

async function getStats(dossierId) {
  const rows = (await api(`receipts?dossier_id=eq.${dossierId}&select=*`)) || [];
  rows.sort((a, b) =>
    String(a.date_iso || a.created_at).localeCompare(String(b.date_iso || b.created_at))
  );
  return {
    count: rows.length,
    total_ttc: rows.reduce((s, r) => s + (r.prix_ttc || 0), 0),
    total_ht: rows.reduce((s, r) => s + (r.prix_ht || 0), 0),
    total_tva: rows.reduce((s, r) => s + (r.tva || 0), 0),
    total_km: rows.reduce((s, r) => s + (r.km || 0), 0),
    receipts: rows,
  };
}

async function monthTotals(year) {
  const dossiers =
    (await api(`dossiers?year=eq.${year}&select=id,month&order=month.asc`)) || [];
  const out = {};
  for (const d of dossiers) {
    const receipts =
      (await api(`receipts?dossier_id=eq.${d.id}&select=prix_ttc`)) || [];
    out[d.month] = {
      id: d.id,
      count: receipts.length,
      total: receipts.reduce((s, r) => s + (r.prix_ttc || 0), 0),
    };
  }
  return out;
}

function shareUrl(token) {
  return `${location.origin}${location.pathname.replace(/\/$/, "")}/#/j/${token}`;
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

async function importFiles(files, dossier, motif = "Déplacement professionnel") {
  const pdfs = [...files].filter((f) => f?.name?.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) throw new Error("Choisissez au moins un PDF Ulys.");
  let ok = 0;
  for (const file of pdfs) {
    const text = await extractPdfText(file);
    const parsed = parseUlysText(text);
    const stored = `${crypto.randomUUID()}.pdf`;
    await uploadStorage(stored, file);
    await api("receipts", {
      method: "POST",
      body: JSON.stringify({
        dossier_id: dossier.id,
        stored_filename: stored,
        original_filename: file.name,
        ...parsed,
        motif,
      }),
    });
    ok += 1;
  }
  await api(`dossiers?id=eq.${dossier.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  });
  return ok;
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const pub = hash.match(/^\/j\/([^/]+)/);
  if (pub) return renderPublic(decodeURIComponent(pub[1]));
  const month = hash.match(/^\/(\d{4})\/(\d{1,2})$/);
  if (month) return renderMonth(Number(month[1]), Number(month[2]));
  const year = hash.match(/^\/(\d{4})$/);
  if (year) return renderYear(Number(year[1]));
  return renderHome();
}

function brand(title, subtitle, backHref = null) {
  return `
    <div class="top-simple">
      <div>
        ${backHref ? `<a class="muted small" href="${backHref}">← Retour</a>` : ""}
        <h1 style="margin-top:${backHref ? "0.25rem" : "0"}">${title}</h1>
        ${subtitle ? `<p class="muted small" style="margin:0.25rem 0 0">${subtitle}</p>` : ""}
      </div>
      <div class="mark-mini">JU</div>
    </div>
  `;
}

function renderHome() {
  const defaultYear = YEARS.includes(CURRENT_YEAR) ? CURRENT_YEAR : 2026;
  app.innerHTML = `
    <div class="hero">
      <div class="mark">JU</div>
      <h1>Justificatifs Ulys</h1>
      <p>Edouard Clemenceau · un dossier par mois</p>
    </div>
    <div class="card">
      <p class="muted small" style="margin-top:0">Choisissez l’année</p>
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
    <p class="footer-note">Astuce : ouvrez le mois, déposez vos PDF, copiez le lien à envoyer.</p>
  `;
}

async function renderYear(year) {
  if (!YEARS.includes(year)) {
    location.hash = "#/";
    return;
  }
  app.innerHTML = `${brand(String(year), "Chargement des mois…", "#/")}<div class="center muted">Chargement…</div>`;
  try {
    const totals = await monthTotals(year);
    app.innerHTML = `
      ${brand(String(year), "Choisissez le mois à justifier", "#/")}
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
  } catch (err) {
    app.innerHTML = `${brand(String(year), "Erreur", "#/")}<div class="card status err">${escapeHtml(err.message)}</div>`;
  }
}

async function renderMonth(year, month) {
  if (!YEARS.includes(year) || month < 1 || month > 12) {
    location.hash = "#/";
    return;
  }
  app.innerHTML = `${brand(`${MOIS[month]} ${year}`, "Chargement…", `#/${year}`)}<div class="center muted">Chargement…</div>`;
  try {
    const dossier = await getDossier(year, month);
    if (!dossier) throw new Error("Dossier du mois introuvable.");
    const stats = await getStats(dossier.id);
    const link = shareUrl(dossier.share_token);

    app.innerHTML = `
      ${brand(`${MOIS[month]} ${year}`, "Déposez vos PDF puis envoyez le lien", `#/${year}`)}

      <div class="drop" id="drop">
        <strong>Déposez vos reçus PDF ici</strong>
        <span>ou touchez pour choisir les fichiers</span>
        <input id="files" type="file" accept="application/pdf,.pdf" multiple />
      </div>
      <div class="field">
        <label for="motif">Motif (optionnel)</label>
        <input id="motif" value="Déplacement professionnel" />
      </div>
      <p class="status" id="status"></p>

      <div class="card">
        <p class="muted small" style="margin-top:0">Lien à envoyer (sans accès au compte Ulys)</p>
        <div class="share">
          <input id="shareUrl" readonly value="${escapeAttr(link)}" />
          <button class="btn btn-primary btn-lg" type="button" id="copyBtn">Copier le lien</button>
          <a class="btn btn-secondary" href="#/j/${escapeAttr(dossier.share_token)}">Voir comme eux</a>
        </div>
      </div>

      <div class="stats">
        <div class="stat"><span>Trajets</span><strong>${stats.count}</strong></div>
        <div class="stat"><span>Km</span><strong>${km(stats.total_km)}</strong></div>
        <div class="stat"><span>HT</span><strong>${euro(stats.total_ht)}</strong></div>
        <div class="stat"><span>TTC</span><strong>${euro(stats.total_ttc)}</strong></div>
      </div>

      <div class="card">
        ${
          stats.receipts.length
            ? stats.receipts
                .map(
                  (r) => `
            <div class="trip">
              <div class="row">
                <div class="main">${escapeHtml(r.entree || "?")} → ${escapeHtml(r.sortie || "?")}</div>
                <div class="amount">${euro(r.prix_ttc)}</div>
              </div>
              <div class="meta">${escapeHtml(r.date_raw || "—")} · ${km(r.km)} · ${escapeHtml(r.motif || "")}</div>
            </div>`
                )
                .join("")
            : `<p class="muted center" style="margin:0">Aucun reçu pour ce mois.</p>`
        }
      </div>
    `;

    const copyBtn = document.getElementById("copyBtn");
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = "Lien copié ✓";
    };

    const drop = document.getElementById("drop");
    const input = document.getElementById("files");
    const status = document.getElementById("status");
    const run = async (fileList) => {
      status.className = "status";
      status.textContent = "Analyse en cours…";
      drop.style.pointerEvents = "none";
      try {
        const motif =
          document.getElementById("motif").value.trim() || "Déplacement professionnel";
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
    app.innerHTML = `${brand(`${MOIS[month]} ${year}`, "Erreur", `#/${year}`)}<div class="card status err">${escapeHtml(err.message)}</div>`;
  }
}

async function renderPublic(shareToken) {
  app.innerHTML = `<div class="center muted" style="padding:2rem">Chargement…</div>`;
  try {
    const dossiers = await api(
      `dossiers?share_token=eq.${encodeURIComponent(shareToken)}&select=*`
    );
    const dossier = dossiers?.[0];
    if (!dossier) {
      app.innerHTML = `<div class="card center">Lien invalide.</div>`;
      return;
    }
    const stats = await getStats(dossier.id);
    const label =
      dossier.year && dossier.month
        ? `${MOIS[dossier.month]} ${dossier.year}`
        : dossier.title;
    app.innerHTML = `
      <div class="hero" style="margin-top:0.5rem">
        <div class="mark">JU</div>
        <h1>${escapeHtml(label)}</h1>
        <p>Justificatif Ulys · Edouard Clemenceau</p>
      </div>
      <div class="card">
        <div class="stats">
          <div class="stat"><span>Trajets</span><strong>${stats.count}</strong></div>
          <div class="stat"><span>Km</span><strong>${km(stats.total_km)}</strong></div>
          <div class="stat"><span>HT</span><strong>${euro(stats.total_ht)}</strong></div>
          <div class="stat"><span>TTC</span><strong>${euro(stats.total_ttc)}</strong></div>
        </div>
        ${
          stats.receipts
            .map(
              (r) => `
          <div class="trip">
            <div class="row">
              <div class="main">${escapeHtml(r.entree || "?")} → ${escapeHtml(r.sortie || "?")}</div>
              <div class="amount">${euro(r.prix_ttc)}</div>
            </div>
            <div class="meta">${escapeHtml(r.date_raw || "—")} · ${km(r.km)} · ${escapeHtml(r.motif || "")}</div>
            <div class="meta no-print" style="margin-top:0.45rem">
              <a class="btn btn-secondary" href="${publicPdfUrl(r.stored_filename)}" target="_blank" rel="noopener">Voir le reçu PDF</a>
            </div>
          </div>`
            )
            .join("") || `<p class="muted">Aucun trajet</p>`
        }
      </div>
      <div class="actions no-print" style="justify-content:center">
        <button class="btn btn-ghost" type="button" onclick="window.print()">Imprimer</button>
      </div>
      <p class="footer-note">Sans accès au compte Ulys. Montants issus des reçus informatifs.</p>
    `;
  } catch (err) {
    app.innerHTML = `<div class="card status err">${escapeHtml(err.message || String(err))}</div>`;
  }
}

window.addEventListener("hashchange", route);
route();
