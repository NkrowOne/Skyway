@echo off
rem Descodifica el kit de copia de seguridad: lanza descodificar.ps1 con doble clic.
rem
rem -ExecutionPolicy Bypass hace que no dependa de la politica de ejecucion de
rem PowerShell del equipo, y -NoProfile evita cargar el perfil del usuario.
rem El fichero es solo ASCII a proposito: cmd lo lee con la pagina de codigos
rem del sistema y los acentos se estropearian. Los mensajes con acentos los
rem escribe descodificar.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0descodificar.ps1" %*
set "CODIGO=%ERRORLEVEL%"
echo.
rem La pausa evita que la ventana se cierre sola al terminar y no deje leer el resultado.
pause
exit /b %CODIGO%
