@echo off
title Mayafx HQ - Laptop AI setup
cd /d "%~dp0"
where docker >nul 2>nul || ( echo Install Docker Desktop first: docker.com & pause & exit /b )
echo [1/4] Starting AI + chat page...
docker compose up -d || ( echo Open Docker Desktop first. & pause & exit /b )
echo [2/4] Downloading AI model (about 2.5 GB)...
docker exec mayafx-ollama ollama pull qwen3:4b
echo [3/4] Downloading knowledge-search model...
docker exec mayafx-ollama ollama pull nomic-embed-text
echo [4/4] Building the mayafx-hq brain...
docker exec mayafx-ollama ollama create mayafx-hq -f /hq/Modelfile
echo.
echo Your laptop's Wi-Fi address (put it in .env as LAPTOP_OLLAMA_URL=http://THIS-IP:11434):
ipconfig | findstr /i "IPv4"
echo If Windows Firewall asks, click Allow (private networks).
start http://localhost:3000
pause
