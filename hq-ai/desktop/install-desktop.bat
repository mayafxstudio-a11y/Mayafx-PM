@echo off
title Mayafx HQ - Desktop setup
cd /d "%~dp0"
where docker >nul 2>nul || ( echo Install Docker Desktop first: docker.com & pause & exit /b )
if not exist "..\.env" (
  copy "..\.env.example" "..\.env" >nul
  echo Fill in the .env file that just opened, save it, then run this again.
  notepad "..\.env"
  pause & exit /b
)
echo [1/4] Starting HQ AI, n8n and the backup AI...
docker compose --profile tunnel up -d || ( echo Open Docker Desktop first. & pause & exit /b )
echo [2/4] Downloading AI model (about 2.5 GB, one time)...
docker exec mayafx-ollama ollama pull qwen3:4b
echo [3/4] Building the mayafx-hq brain...
docker exec mayafx-ollama ollama create mayafx-hq -f /hq/Modelfile
echo [4/4] Importing the HQ workflows into n8n...
timeout /t 15 >nul
docker exec mayafx-n8n n8n import:workflow --separate --input=/workflows
echo.
echo DONE. Test: http://localhost:8787/api/health
start http://localhost:5678
pause
