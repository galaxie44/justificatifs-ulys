@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\uvicorn.exe (
  python -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
echo.
echo  Justificatifs Ulys
echo  Admin : http://127.0.0.1:8000
echo  Mot de passe : voir fichier .env (ADMIN_PASSWORD)
echo.
.venv\Scripts\uvicorn.exe app:app --host 0.0.0.0 --port 8000
