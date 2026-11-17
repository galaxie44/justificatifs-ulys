const SUPABASE_URL = "https://lljycdhijeuizzizuceh.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsanljZGhpamV1aXp6aXp1Y2VoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MTgxNzQsImV4cCI6MjExMDQ5NDE3NH0.o-0oRw3lRvU3l_b4jt_LCRNTM7aqQa9ju0jmyOUSpUw";

const app = document.getElementById("app");

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

function newToken() {
  const arr = new Uint8Array(18);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

function autoTitle() {
  const d = new Date();
  return `Note de frais — ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

async function importFiles(files, { dossierId = null, motif = "Déplacement professionnel", title = null } = {}) {
  const pdfs = [...files].filter((f) => f && f.name && f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) throw new Error("Choisissez au moins un PDF Ulys.");

  let dossier = null;
  if (dossierId) {
    const rows = await api(`dossiers?id=eq.${dossierId}&select=*`);
    dossier = rows?.[0];
    if (!dossier) throw new Error("Dossier introuvable.");
  } else {
    const created = await api("dossiers", {
      method: "POST",
      body: JSON.stringify({
        title: title || autoTitle(),
        description: "Justificatif de frais de péage Ulys.",
        share_token: newToken(),
      }),
    });
    dossier = created[0];
  }

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

  return { dossier, ok };
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const pub = hash.match(/^\/j\/([^/]+)/);
  if (pub) return renderPublic(decodeURIComponent(pub[1]));
  const dos = hash.match(/^\/d\/(\d+)/);
  if (dos) return renderResult(Number(dos[1]));
  return renderHome();
}

function renderHome() {
  app.innerHTML = `
    <div class="hero">
      <div class="mark">JU</div>
      <h1>Justificatif Ulys</h1>
      <p>1. Déposez vos PDF&nbsp;&nbsp;2. Copiez le lien</p>
    </div>

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
    <p class="footer-note">Vos destinataires voient le récapitulatif et les PDF.<br/>Ils n’ont pas besoin de votre compte Ulys.</p>
  `;

  const drop = document.getElementById("drop");
  const input = document.getElementById("files");
  const status = document.getElementById("status");

  const run = async (fileList) => {
    status.className = "status";
    status.textContent = "Analyse en cours…";
    drop.style.pointerEvents = "none";
    try {
      const motif = document.getElementById("motif").value.trim() || "Déplacement professionnel";
      const { dossier, ok } = await importFiles(fileList, { motif });
      status.className = "status ok";
      status.textContent = `${ok} reçu(s) prêt(s)`;
      location.hash = `#/d/${dossier.id}`;
    } catch (err) {
      status.className = "status err";
      status.textContent = err.message || String(err);
      drop.style.pointerEvents = "";
    }
  };

  drop.onclick = () => input.click();
  input.onchange = () => {
    if (input.files?.length) run(input.files);
  };
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
}

async function renderResult(id) {
  app.innerHTML = `<div class="center muted" style="padding:2rem">Chargement…</div>`;
  try {
    const rows = await api(`dossiers?id=eq.${id}&select=*`);
    const dossier = rows?.[0];
    if (!dossier) {
      app.innerHTML = `<div class="card center"><p>Introuvable.</p><a class="btn btn-primary" href="#/">Recommencer</a></div>`;
      return;
    }
    const stats = await getStats(id);
    const link = shareUrl(dossier.share_token);

    app.innerHTML = `
      <div class="top-simple">
        <h1>C’est prêt</h1>
        <a class="btn btn-ghost no-print" href="#/">Nouveau</a>
      </div>

      <div class="card">
        <p class="muted small" style="margin-top:0">Envoyez ce lien — sans accès à votre compte Ulys</p>
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
            : `<p class="muted center">Aucun trajet</p>`
        }
      </div>

      <div class="card no-print">
        <strong>Ajouter d’autres PDF</strong>
        <div class="drop" id="dropMore" style="margin-top:0.8rem;padding:1.4rem">
          <strong style="font-size:1rem">Déposer ici</strong>
          <span>ou toucher pour choisir</span>
          <input id="moreFiles" type="file" accept="application/pdf,.pdf" multiple />
        </div>
        <p class="status" id="status"></p>
      </div>
    `;

    const copyBtn = document.getElementById("copyBtn");
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = "Lien copié ✓";
    };

    const drop = document.getElementById("dropMore");
    const input = document.getElementById("moreFiles");
    const status = document.getElementById("status");
    const run = async (fileList) => {
      status.className = "status";
      status.textContent = "Ajout…";
      try {
        const { ok } = await importFiles(fileList, { dossierId: id });
        status.className = "status ok";
        status.textContent = `${ok} ajouté(s)`;
        route();
      } catch (err) {
        status.className = "status err";
        status.textContent = err.message || String(err);
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
    app.innerHTML = `<div class="card"><div class="status err">${escapeHtml(err.message || String(err))}</div><a href="#/">Retour</a></div>`;
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
    app.innerHTML = `
      <div class="hero" style="margin-top:0.5rem">
        <div class="mark">JU</div>
        <h1>Justificatif de péage</h1>
        <p>Sans connexion au compte Ulys</p>
      </div>

      <div class="card">
        <h2 style="margin:0 0 0.35rem;font-size:1.15rem">${escapeHtml(dossier.title)}</h2>
        <p class="muted small" style="margin-top:0">${escapeHtml(dossier.description || "")}</p>
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

      <div class="actions no-print" style="justify-content:center;margin-top:0.5rem">
        <button class="btn btn-ghost" type="button" onclick="window.print()">Imprimer</button>
      </div>
      <p class="footer-note">Montants issus des reçus Ulys. La facture mensuelle reste la référence comptable.</p>
    `;
  } catch (err) {
    app.innerHTML = `<div class="card"><div class="status err">${escapeHtml(err.message || String(err))}</div></div>`;
  }
}

window.addEventListener("hashchange", route);
route();
