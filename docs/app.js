import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs";

const SUPABASE_URL = "https://lljycdhijeuizzizuceh.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsanljZGhpamV1aXp6aXp1Y2VoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MTgxNzQsImV4cCI6MjExMDQ5NDE3NH0.o-0oRw3lRvU3l_b4jt_LCRNTM7aqQa9ju0jmyOUSpUw";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById("app");

const euro = (v) =>
  v == null || Number.isNaN(Number(v))
    ? "—"
    : `${Number(v).toFixed(2).replace(".", ",")} €`;
const km = (v) =>
  v == null || Number.isNaN(Number(v))
    ? "—"
    : `${Number(v).toFixed(1).replace(".", ",")} km`;

function token() {
  const arr = new Uint8Array(18);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseUlysText(text, filename) {
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
  const classe = lines.find((l) => /^\d+$/.test(l)) || "";
  const formule =
    lines.find((l) => /classic|premium|liber-t/i.test(l) && !/formule/i.test(l)) ||
    "Classic";
  return {
    date_raw,
    date_iso,
    entree: plazas[0] || "",
    sortie: plazas[1] || "",
    km: kmLine ? parseFloat(kmLine.replace(",", ".")) : null,
    classe_tarif: classe,
    prix_ttc: money[0] ?? null,
    prix_ht: money[1] ?? null,
    tva: money[2] ?? null,
    formule,
    badge: badgeMatch ? badgeMatch[1] : "",
    original_filename: filename,
  };
}

async function extractPdfText(file) {
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

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const publicMatch = hash.match(/^\/j\/([^/]+)/);
  if (publicMatch) return renderPublic(publicMatch[1]);
  const dossierMatch = hash.match(/^\/dossiers\/(\d+)/);
  if (dossierMatch) return renderDossier(Number(dossierMatch[1]));
  return renderHome();
}

async function listDossiers() {
  const { data: dossiers, error } = await sb
    .from("dossiers")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const enriched = [];
  for (const d of dossiers || []) {
    const { data: receipts } = await sb
      .from("receipts")
      .select("prix_ttc, km")
      .eq("dossier_id", d.id);
    enriched.push({
      ...d,
      receipt_count: receipts?.length || 0,
      total_ttc: (receipts || []).reduce((s, r) => s + (r.prix_ttc || 0), 0),
    });
  }
  return enriched;
}

async function getStats(dossierId) {
  const { data } = await sb.from("receipts").select("*").eq("dossier_id", dossierId);
  const rows = data || [];
  return {
    count: rows.length,
    total_ttc: rows.reduce((s, r) => s + (r.prix_ttc || 0), 0),
    total_ht: rows.reduce((s, r) => s + (r.prix_ht || 0), 0),
    total_tva: rows.reduce((s, r) => s + (r.tva || 0), 0),
    total_km: rows.reduce((s, r) => s + (r.km || 0), 0),
    receipts: rows.sort((a, b) =>
      String(a.date_iso || a.created_at).localeCompare(String(b.date_iso || b.created_at))
    ),
  };
}

function shell(title, subtitle, body, actions = "") {
  app.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <div class="brand-mark">JU</div>
        <div>
          <h1>${title}</h1>
          <p>${subtitle}</p>
        </div>
      </div>
      <div class="actions">${actions}</div>
    </div>
    ${body}
  `;
}

async function renderHome() {
  shell(
    "Justificatifs Ulys",
    "Uploadez vos reçus · partagez un justificatif sans compte Ulys",
    `<div class="empty">Chargement…</div>`
  );
  try {
    const dossiers = await listDossiers();
    shell(
      "Justificatifs Ulys",
      "Uploadez vos reçus · partagez un justificatif sans compte Ulys",
      `
      <div class="grid-2">
        <section class="card">
          <h2 style="margin-top:0">Dossiers</h2>
          ${
            dossiers.length
              ? `<div class="table-wrap"><table>
                <thead><tr><th>Titre</th><th>Trajets</th><th>Total TTC</th><th></th></tr></thead>
                <tbody>
                  ${dossiers
                    .map(
                      (d) => `<tr>
                    <td><a href="#/dossiers/${d.id}"><strong>${escapeHtml(d.title)}</strong></a>
                      ${d.description ? `<div class="muted small">${escapeHtml(d.description.slice(0, 80))}</div>` : ""}
                    </td>
                    <td><span class="pill">${d.receipt_count}</span></td>
                    <td>${euro(d.total_ttc)}</td>
                    <td><a class="btn btn-secondary" href="#/dossiers/${d.id}">Ouvrir</a></td>
                  </tr>`
                    )
                    .join("")}
                </tbody></table></div>`
              : `<div class="empty">Aucun dossier pour l’instant. Créez-en un à droite.</div>`
          }
        </section>
        <section class="card">
          <h2 style="margin-top:0">Nouveau dossier</h2>
          <p class="muted small">Ex. « Note de frais novembre 2026 ».</p>
          <form id="createForm">
            <div class="field"><label>Titre</label><input name="title" required placeholder="Note de frais — Novembre 2026" /></div>
            <div class="field"><label>Contexte (visible publiquement)</label><textarea name="description" placeholder="Déplacements professionnels A63…"></textarea></div>
            <button class="btn btn-primary" type="submit">Créer le dossier</button>
          </form>
        </section>
      </div>`
    );
    document.getElementById("createForm").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const { data, error } = await sb
        .from("dossiers")
        .insert({
          title: String(fd.get("title")).trim(),
          description: String(fd.get("description") || "").trim(),
          share_token: token(),
        })
        .select()
        .single();
      if (error) return alert(error.message);
      location.hash = `#/dossiers/${data.id}`;
    };
  } catch (err) {
    shell("Justificatifs Ulys", "Erreur", `<div class="error">${escapeHtml(err.message)}</div>`);
  }
}

async function renderDossier(id) {
  shell("Dossier", "Chargement…", `<div class="empty">Chargement…</div>`);
  const { data: dossier, error } = await sb.from("dossiers").select("*").eq("id", id).single();
  if (error || !dossier) {
    shell("Introuvable", "", `<div class="error">Dossier introuvable. <a href="#/">Retour</a></div>`);
    return;
  }
  const stats = await getStats(id);
  const shareUrl = `${location.origin}${location.pathname}#/j/${dossier.share_token}`;

  shell(
    escapeHtml(dossier.title),
    `<a href="#/">← Tous les dossiers</a>`,
    `
    <div class="notice">Partagez le lien ci-dessous. Aucun accès au compte Ulys n’est requis.</div>
    <section class="card" style="margin-bottom:1rem">
      <h2 style="margin-top:0">Lien public de justification</h2>
      <div class="share-box">
        <input id="shareUrl" readonly value="${escapeAttr(shareUrl)}" />
        <button class="btn btn-secondary" type="button" id="copyBtn">Copier</button>
        <a class="btn btn-accent" href="#/j/${dossier.share_token}" target="_blank">Voir le justificatif</a>
      </div>
    </section>
    <div class="stats">
      <div class="stat"><span>Trajets</span><strong>${stats.count}</strong></div>
      <div class="stat"><span>Kilomètres</span><strong>${km(stats.total_km)}</strong></div>
      <div class="stat"><span>Total HT</span><strong>${euro(stats.total_ht)}</strong></div>
      <div class="stat"><span>Total TTC</span><strong>${euro(stats.total_ttc)}</strong></div>
    </div>
    <div class="grid-2">
      <section class="card">
        <h2 style="margin-top:0">Ajouter des reçus Ulys (PDF)</h2>
        <p class="muted small">Extraction automatique de la date, trajet, km et montants.</p>
        <form id="uploadForm">
          <div class="field"><label>Fichiers PDF</label><input name="files" type="file" accept="application/pdf,.pdf" multiple required /></div>
          <div class="field"><label>Motif par défaut</label><input name="motif" placeholder="Déplacement professionnel" /></div>
          <button class="btn btn-primary" type="submit">Importer et analyser</button>
          <p id="uploadStatus" class="muted small"></p>
        </form>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Infos du dossier</h2>
        <form id="editForm">
          <div class="field"><label>Titre</label><input name="title" value="${escapeAttr(dossier.title)}" required /></div>
          <div class="field"><label>Description</label><textarea name="description">${escapeHtml(dossier.description || "")}</textarea></div>
          <div class="actions">
            <button class="btn btn-secondary" type="submit">Enregistrer</button>
            <button class="btn btn-danger" type="button" id="deleteDossier">Supprimer</button>
          </div>
        </form>
      </section>
    </div>
    <section class="card" style="margin-top:1rem">
      <h2 style="margin-top:0">Trajets importés</h2>
      ${
        stats.receipts.length
          ? `<div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Trajet</th><th>Km</th><th>TTC</th><th>Motif</th><th>Reçu</th><th></th></tr></thead>
            <tbody>
              ${stats.receipts
                .map(
                  (r) => `<tr>
                <td>${escapeHtml(r.date_raw || "—")}</td>
                <td class="route">${escapeHtml(r.entree || "?")} <span>→</span> ${escapeHtml(r.sortie || "?")}</td>
                <td>${km(r.km)}</td>
                <td><strong>${euro(r.prix_ttc)}</strong></td>
                <td>
                  <form class="motif-inline" data-id="${r.id}">
                    <input name="motif" value="${escapeAttr(r.motif || "")}" />
                    <button class="btn btn-secondary" type="submit">OK</button>
                  </form>
                </td>
                <td><a href="${publicPdfUrl(r.stored_filename)}" target="_blank" rel="noopener">PDF</a></td>
                <td><button class="btn btn-danger" data-del="${r.id}" type="button">×</button></td>
              </tr>`
                )
                .join("")}
            </tbody></table></div>`
          : `<div class="empty">Importez vos PDF Ulys pour constituer le justificatif.</div>`
      }
    </section>`,
    ""
  );

  document.getElementById("copyBtn").onclick = async () => {
    await navigator.clipboard.writeText(shareUrl);
    document.getElementById("copyBtn").textContent = "Copié";
  };

  document.getElementById("editForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await sb
      .from("dossiers")
      .update({
        title: String(fd.get("title")).trim(),
        description: String(fd.get("description") || "").trim(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    route();
  };

  document.getElementById("deleteDossier").onclick = async () => {
    if (!confirm("Supprimer ce dossier et tous ses PDF ?")) return;
    for (const r of stats.receipts) {
      await sb.storage.from("receipts").remove([r.stored_filename]);
    }
    await sb.from("dossiers").delete().eq("id", id);
    location.hash = "#/";
  };

  document.querySelectorAll("form.motif-inline").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const rid = Number(form.dataset.id);
      await sb.from("receipts").update({ motif: form.motif.value.trim() }).eq("id", rid);
      route();
    };
  });

  document.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Supprimer ce reçu ?")) return;
      const rid = Number(btn.dataset.del);
      const r = stats.receipts.find((x) => x.id === rid);
      if (r) await sb.storage.from("receipts").remove([r.stored_filename]);
      await sb.from("receipts").delete().eq("id", rid);
      route();
    };
  });

  document.getElementById("uploadForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const files = [...fd.getAll("files")].filter((f) => f && f.name);
    const motif = String(fd.get("motif") || "").trim();
    const status = document.getElementById("uploadStatus");
    let ok = 0;
    for (const file of files) {
      status.textContent = `Analyse de ${file.name}…`;
      if (!file.name.toLowerCase().endsWith(".pdf")) continue;
      try {
        const text = await extractPdfText(file);
        const parsed = parseUlysText(text, file.name);
        const stored = `${crypto.randomUUID()}.pdf`;
        const { error: upErr } = await sb.storage
          .from("receipts")
          .upload(stored, file, { contentType: "application/pdf", upsert: false });
        if (upErr) throw upErr;
        const { error: insErr } = await sb.from("receipts").insert({
          dossier_id: id,
          stored_filename: stored,
          original_filename: file.name,
          date_raw: parsed.date_raw,
          date_iso: parsed.date_iso,
          entree: parsed.entree,
          sortie: parsed.sortie,
          km: parsed.km,
          classe_tarif: parsed.classe_tarif,
          prix_ht: parsed.prix_ht,
          tva: parsed.tva,
          prix_ttc: parsed.prix_ttc,
          formule: parsed.formule,
          badge: parsed.badge,
          motif,
        });
        if (insErr) throw insErr;
        ok += 1;
      } catch (err) {
        console.error(err);
        status.textContent = `Erreur sur ${file.name}: ${err.message || err}`;
      }
    }
    await sb.from("dossiers").update({ updated_at: new Date().toISOString() }).eq("id", id);
    status.textContent = `${ok} reçu(s) importé(s).`;
    route();
  };
}

function publicPdfUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/receipts/${path}`;
}

async function renderPublic(shareToken) {
  shell("Justificatif", "Chargement…", `<div class="empty">Chargement…</div>`);
  const { data: dossier } = await sb
    .from("dossiers")
    .select("*")
    .eq("share_token", shareToken)
    .single();
  if (!dossier) {
    shell("Lien invalide", "", `<div class="error">Ce justificatif est introuvable.</div>`);
    return;
  }
  const stats = await getStats(dossier.id);
  shell(
    "Justificatif de frais de péage",
    "Document partagé · aucune connexion Ulys requise",
    `
    <section class="card">
      <h2 style="margin:0 0 0.35rem">${escapeHtml(dossier.title)}</h2>
      ${dossier.description ? `<p class="muted" style="white-space:pre-wrap;margin-top:0">${escapeHtml(dossier.description)}</p>` : ""}
      <div class="stats">
        <div class="stat"><span>Trajets</span><strong>${stats.count}</strong></div>
        <div class="stat"><span>Kilomètres</span><strong>${km(stats.total_km)}</strong></div>
        <div class="stat"><span>Total HT</span><strong>${euro(stats.total_ht)}</strong></div>
        <div class="stat"><span>Total TTC</span><strong>${euro(stats.total_ttc)}</strong></div>
      </div>
      ${
        stats.receipts.length
          ? `<div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Entrée</th><th>Sortie</th><th>Km</th><th>HT</th><th>TVA</th><th>TTC</th><th>Motif</th><th class="no-print">Pièce</th></tr></thead>
            <tbody>
              ${stats.receipts
                .map(
                  (r) => `<tr>
                <td>${escapeHtml(r.date_raw || "—")}</td>
                <td>${escapeHtml(r.entree || "—")}</td>
                <td>${escapeHtml(r.sortie || "—")}</td>
                <td>${km(r.km)}</td>
                <td>${euro(r.prix_ht)}</td>
                <td>${euro(r.tva)}</td>
                <td><strong>${euro(r.prix_ttc)}</strong></td>
                <td>${escapeHtml(r.motif || "—")}</td>
                <td class="no-print"><a class="btn btn-secondary" href="${publicPdfUrl(r.stored_filename)}" target="_blank" rel="noopener">Reçu PDF</a></td>
              </tr>`
                )
                .join("")}
            </tbody></table></div>`
          : `<div class="empty">Aucun trajet.</div>`
      }
    </section>
    <p class="muted small" style="margin-top:1rem">
      Montants issus des reçus informatifs Ulys. La facture mensuelle Ulys reste la référence comptable.
      Ce lien ne donne aucun accès au compte Ulys du titulaire.
    </p>`,
    `<button class="btn btn-ghost no-print" type="button" onclick="window.print()">Imprimer</button>`
  );
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

window.addEventListener("hashchange", route);
route();
