@echo off
cd /d "%~dp0"
echo Demarrage du serveur local...
start "Justificatifs-Ulys" cmd /c ".venv\Scripts\uvicorn.exe app:app --host 0.0.0.0 --port 8000"
timeout /t 3 /nobreak >nul
echo.
echo Ouverture du tunnel public Serveo (laissez cette fenetre ouverte)...
echo Une page d'avertissement Serveo peut s'afficher : cliquez Continue to Site.
echo.
ssh -o StrictHostKeyChecking=no -R 80:127.0.0.1:8000 serveo.net
