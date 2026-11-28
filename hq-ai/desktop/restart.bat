@echo off
cd /d "%~dp0"
docker compose --profile tunnel up -d --force-recreate hq-ai tunnel
echo Mayafx HQ AI restarted.
pause
