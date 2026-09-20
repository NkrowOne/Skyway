# Guía de estilo de textos de Skyway (registro profesional)

Objetivo: que todo texto visible por el usuario suene como el software profesional en español de toda la vida (Microsoft, SAP, Sage, Adobe): claro, neutro, sin gracietas ni metáforas. Se aplica a: textos de interfaz (etiquetas, botones, títulos, descripciones, placeholders, tooltips, estados vacíos, toasts), mensajes de error y de éxito del servidor, avisos y alertas, líneas de registro de despliegue, preguntas y respuestas de la FAQ, respuestas del asistente y textos de diagnóstico. NO se aplica a comentarios del código ni a identificadores.

## Registro
- Tratamiento de **usted** en las instrucciones dirigidas al usuario: «Compruebe», «Seleccione», «Revise», «Introduzca», «Vuelva a intentarlo». Nunca «tú» («comprueba», «tu servicio», «pega», «mira»).
- Preferir construcciones **impersonales** cuando no haga falta dirigirse al usuario: «No se ha podido cargar el registro», «Se han importado 3 variables», «Es necesario volver a desplegar el servicio», «El servicio no responde».
- Acciones de botones y menús en **infinitivo**: «Importar», «Guardar cambios», «Volver a desplegar», «Ver registro», «Consultar». Diálogos con «Aceptar» / «Cancelar».
- Frases completas, con punto final en descripciones y mensajes; sin punto en etiquetas y botones.
- Sin primera persona en el sistema: nunca «He revisado…», «te aviso», «no encuentro». En su lugar: «Se ha revisado el servicio…», «No se ha encontrado…».
- Sin humor, sin exclamaciones, sin emojis, sin preguntas retóricas, sin muletillas («ojo», «vaya», «de verdad», «a secas», «sin más», «y ya», «de golpe», «a pelo», «a ojo», «total», «pues»).
- Sin metáforas ni coloquialismos: «delata» → «indica», «huele a» → «parece», «pista» → «detalle», «revienta» → «falla», «se traga» → «bloquea», «tirar abajo» → «detener», «clavado» → «bloqueado», «se queda colgado» → «no responde», «pisar» → «sobrescribir», «machacar» → «sobrescribir», «cablear» → «conectar», «chocar» → «entrar en conflicto», «la web de detrás» → «la página».
- Sin diminutivos ni intensificadores («un poquito», «muy muy», «súper»).
- Puntos suspensivos solo en acciones en curso («Cargando…», «Importando…»).
- Comillas latinas «» para nombres de elementos de la interfaz cuando haga falta citarlos: la pestaña «Variables», el botón «Volver a desplegar».

## Terminología fija
- registro (no «logs» cuando sea texto corrido; «Registro» como nombre de pestaña se mantiene si ya existe como «Logs» en la navegación: no renombrar pestañas ni rutas existentes)
- despliegue, volver a desplegar, compilación (build), imagen, contenedor, réplica
- variable de entorno, valor, clave, referencia
- dominio, certificado TLS, registro DNS
- base de datos, copia de seguridad, restaurar
- cuenta, usuario, rol, permisos, iniciar sesión, cerrar sesión, contraseña, correo electrónico
- «Causa» / «Solución recomendada» / «Detalle del registro» / «Acciones» como rótulos de un diagnóstico
- Gravedad: «Crítico», «Advertencia», «Información»
- «Se recomienda…», «Es necesario…», «No es posible…», «No se ha podido…», «Se ha producido un error al…»

## Ejemplos
- ✗ «Línea que lo delata» → ✓ «Detalle del registro»
- ✗ «He revisado laravel y he encontrado un problema.» → ✓ «Se ha revisado el servicio «laravel» y se ha detectado 1 problema.»
- ✗ «Cómo arreglarlo» → ✓ «Solución recomendada»
- ✗ «Mira las últimas líneas del log: ahí está el error de tu app.» → ✓ «Consulte las últimas líneas del registro: contienen el error de la aplicación.»
- ✗ «Sin logs todavía…» → ✓ «No hay registros disponibles.»
- ✗ «Añade una, o pega un .env entero en cualquier campo: se reparte solo.» → ✓ «Añada una variable o pegue el contenido de un archivo .env en cualquier campo; las variables se separarán automáticamente.»
- ✗ «Pregunta en tus palabras, deja que el asistente revise tus servicios cuando algo falla» → ✓ «Consulte la documentación o solicite una revisión del estado de sus servicios.»
- ✗ «El asistente es determinista: se basa en la documentación y en lo que ve de tus servicios, sin enviar nada fuera.» → ✓ «Las respuestas se generan a partir de la documentación y del estado de sus servicios. No se envía información a terceros.»
- ✗ «Variables: 2 pendientes de valor (A, B): rellénalas en la pestaña Variables.» → ✓ «Variables: 2 pendientes de valor (A, B). Complete su valor en la pestaña «Variables».»
- ✗ «Te avisamos por la campana» → ✓ «Se ha creado un aviso en el panel de notificaciones.»
