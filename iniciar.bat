@echo off
title Sistema Al Cine Con Papa - Iniciar Servicio
echo ==========================================================
echo       INICIANDO SISTEMA "AL CINE CON PAPA"
echo ==========================================================
echo.

:: Asegurar que Node.js este en el PATH
set PATH=C:\Program Files\nodejs;%PATH%

:: Cerrar procesos anteriores en el puerto 3000
echo [+] Cerrando cualquier servidor anterior en el puerto 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /F /PID %%a 2>nul
)
echo.

:: Iniciar el servidor Node.js
echo [+] Iniciando servidor Node.js en una ventana secundaria...
start "Servidor Backend - Al Cine Con Papa" cmd /k "node server.js"

:: Esperar a que el servidor inicialice
echo [+] Esperando 3 segundos a que el servidor este listo...
timeout /t 3 /nobreak > nul
echo.

:: Iniciar el tunel de Cloudflare
echo [+] Generando enlace publico con Cloudflare Tunnel...
echo [*] Busca la linea que dice: "Your quick Tunnel has been created! Visit it at:"
echo [*] Ahi encontraras el link publico de internet para usar en los celulares.
echo.
npx -y cloudflared tunnel --url http://localhost:3000

pause
