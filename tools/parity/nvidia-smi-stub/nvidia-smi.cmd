@echo off
rem Phase 1 fake nvidia-smi entry point (plan.md §2 Phase 1.3).
rem Forwards the whole argument line to nvidia-smi-stub.js next to this file and propagates its
rem exit code. Resolvable as plain `nvidia-smi` when this directory is on PATH (.CMD is in PATHEXT).
node "%~dp0nvidia-smi-stub.js" %*
exit /b %ERRORLEVEL%
