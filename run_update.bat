@echo off
chcp 65001 > nul
echo 山椒圃場モニター データ更新中...
cd /d "%~dp0"
python scripts/fetch_local.py
