# Justificatifs Ulys

Site personnel pour **uploader vos reçus PDF Ulys** (péages) et **partager un justificatif** clair — sans donner accès à votre compte Ulys.

## Fonctionnalités

- Connexion admin (mot de passe)
- Création de dossiers (notes de frais)
- Upload multi-PDF avec extraction automatique : date, entrée, sortie, km, HT/TVA/TTC
- Motif par trajet
- **Lien public** de justification (tableau + PDF + export récap)
- Aucune connexion au compte Ulys

## Lancer en local

Double-clic sur `start.bat`, ou :

```bash
cd Justificatifs-Ulys
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env   # puis éditez ADMIN_PASSWORD
uvicorn app:app --host 0.0.0.0 --port 8000
```

- Admin : http://127.0.0.1:8000  
- Mot de passe : valeur de `ADMIN_PASSWORD` dans `.env`

## Partager un justificatif (sans compte Ulys)

1. Connectez-vous en admin
2. Créez un dossier (ex. « Note de frais novembre »)
3. Uploadez vos PDF reçus Ulys
4. Ajoutez un motif si besoin
5. Copiez le **lien public** et envoyez-le (employeur, comptable…)

Ils voient le tableau, les totaux et les PDF — **aucun accès à votre compte Ulys**.

## Lien public temporaire (PC allumé)

`start-public.bat` lance le site + un tunnel Serveo.  
L’URL affichée dans le terminal est partageable tant que la fenêtre reste ouverte.

## Docker

```bash
docker compose up --build
```

## Sécurité

- Seul l’admin upload / gère les dossiers
- Le lien public utilise un token aléatoire long
- Les PDF sont validés (extension + en-tête `%PDF`)
- Ne commitez jamais le fichier `.env`
