@echo off
rem Double-click to test the new task locally: starts a small web server and opens the task in the browser.
rem Close this window to stop the server.
cd /d "%~dp0"
start "" "http://127.0.0.1:8000/goal_task.html"
python -m http.server 8000 --bind 127.0.0.1
