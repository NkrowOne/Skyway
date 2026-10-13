# Copias externas (S3)

Copia de seguridad cifrada de **todo el servidor** fuera de él, cada noche:
el panel de Skyway, todos sus proyectos y webs, y Mailway. Se restaura todo o
solo una parte, de cualquier fecha guardada, aunque Skyway o Mailway no
arranquen. Y se puede descargar un **kit** (un ZIP) para guardar en local y
abrirlo con la contraseña.

Las copias de la pestaña Backups de un servicio y las del panel (Ajustes →
Copias de seguridad) siguen existiendo, pero viven en el mismo disco que los
datos: protegen de un error, no de perder el servidor. Las externas sí.

Destino: cualquier almacenamiento compatible con S3. La guía usa
[Cubbit](https://www.cubbit.io) (DS3 Cloud, en Europa, sin coste por
descargar), pero vale igual Backblaze B2, Wasabi, Hetzner Object Storage,
AWS S3 o un MinIO propio.

## Índice

1. [Puesta en marcha](#1-puesta-en-marcha)
2. [Qué se copia y cómo](#2-qué-se-copia-y-cómo)
3. [Restaurar](#3-restaurar)
4. [Servidor nuevo: restaurar.sh](#4-servidor-nuevo-restaurarsh)
5. [El kit para guardar en local](#5-el-kit-para-guardar-en-local)
6. [El panel: Ajustes → Copias externas](#6-el-panel-ajustes--copias-externas)
7. [Versiones y compatibilidad](#7-versiones-y-compatibilidad)
8. [Retención, espacio y comprobaciones](#8-retención-espacio-y-comprobaciones)
9. [Seguridad y bloqueo de objetos](#9-seguridad-y-bloqueo-de-objetos)
10. [Configuración](#10-configuración)
11. [Problemas frecuentes](#11-problemas-frecuentes)
12. [Para desarrollar](#12-para-desarrollar)

## 1. Puesta en marcha

En el servidor donde corre Skyway, con `sudo`. Hace falta `jq`, `git` y `curl`
(y `zip` o `python3` para el kit); restic y la CLI de AWS corren en
contenedores con versión exacta.

### 1.1 El bucket en Cubbit

1. En la consola de Cubbit, crea un bucket con **Object Lock** activado. Solo
   se puede activar al crearlo. Retención por defecto: **30 días, modo
   GOVERNANCE**. (Si lo prefieres, `configurar` lo crea por ti con la clave
   de administración; la de diario no puede.)
2. Crea una clave de acceso (*service account*) solo para este servidor, con
   permiso de leer, escribir, listar y borrar objetos del bucket, pero **sin**
   `s3:BypassGovernanceRetention` ni permisos sobre la configuración del
   bucket. Así, quien entrara en el servidor no podría borrar las copias
   (§9).
3. Endpoint: `https://s3.cubbit.eu`; región: `eu-west-1`.

### 1.2 Configurar y activar

```bash
sudo skyway copias configurar          # destino, clave, contraseña; comprueba el bucket y lo prueba
sudo skyway copias activar             # copia diaria a las 03:30 (o --hora HH:MM)
sudo skyway copias copia               # la primera, ahora (sube todo; las siguientes, solo lo nuevo)
```

`configurar`:

- pide endpoint, región, bucket, carpeta (una por servidor; por defecto, su
  nombre) y la clave;
- comprueba el bucket: si no existe, ofrece crearlo con bloqueo de objetos;
  si el bloqueo no tiene retención por defecto, ofrece fijar 30 días; si no
  hay regla de ciclo de vida, ofrece borrar las versiones antiguas a los 31
  días (para no llenar el espacio, §8);
- genera la contraseña de las copias (o la escribes tú, mínimo 16
  caracteres);
- inicia el repositorio y **prueba de verdad** a escribir y a retirar una
  instantánea: si el proveedor o la clave fallan, se sabe en ese momento y no
  a las tres de la mañana;
- muestra los **datos de recuperación**.

> **Guarda los datos de recuperación fuera del servidor** (en tu gestor de
> contraseñas). Sin la contraseña, las copias no se pueden leer: nadie puede
> recuperarla. Se vuelven a ver con `sudo skyway copias datos-recuperacion`.

`activar` instala un temporizador de systemd (`skyway-copias.timer`, con hasta
10 minutos de margen aleatorio y que recupera la ejecución perdida si el
servidor estaba apagado) y la unidad que atiende las peticiones del panel
(`skyway-copias-peticiones.path`). `desactivar` los retira; las copias del
bucket se conservan.

### 1.3 Avisos

- Si una copia falla o queda incompleta, se avisa por los canales de Ajustes
  → Alertas, y el panel muestra el fallo.
- El panel avisa además si la última copia correcta tiene **más de 26 horas**
  (alerta `copias_externas_atrasadas`): cubre el caso de que el temporizador
  deje de funcionar sin decir nada.
- **Vigilante externo** (recomendado): un servicio como
  [healthchecks.io](https://healthchecks.io) avisa si no recibe noticias en
  26 horas, aunque el servidor entero haya caído. Pon su URL en
  `AVISO_URL=` de `/etc/skyway-copias/config`: cada copia correcta la llama y
  una fallida llama a `<URL>/fail`.

### 1.4 Antes de cada actualización

`skyway update` (también la automática) hace una copia del panel de Skyway
(alcance `skyway`) justo antes de aplicar una versión nueva, y `mailway update`
una del correo (alcance `correo`). Si la versión nueva estropeara algo, se
vuelve a ese momento con `restaurar skyway` o `restaurar correo`. Si esa copia
falla, la actualización nocturna sigue (la copia de esa noche existe) y a mano
se pregunta.

## 2. Qué se copia y cómo

Cada elemento es una **instantánea de restic** con su ruta y sus etiquetas,
cifrada y deduplicada: cada noche solo se sube lo que ha cambiado. Una
**ejecución** (`AAAAMMDD-HHMMSS`, hora UTC) agrupa los elementos de una copia;
su **manifiesto**, lo último que se sube, dice qué versión había de cada cosa
y qué instantánea es cada elemento.

| Elemento | Ruta en la copia | Qué es |
| --- | --- | --- |
| Configuración | `/elementos/config` | `.env` y `docker-compose.override.yml` de Skyway, `deploy/.env` de Mailway, estado de git y parche con los cambios locales de cada repositorio, configuración de las copias (sin secretos) y datos del servidor |
| Código | `/elementos/codigo` | `git bundle` de Skyway y de Mailway en su commit, y `scripts/copias/` suelto (es lo que restaura esa copia, §7) |
| Volúmenes | `/volumenes/<nombre>` | **Todos** los volúmenes de Docker: los datos del panel (`skyway.db`, sin `builds/` ni `copias/`), los certificados de Traefik (`acme.json`), los de cada servicio (bases, subidas, rutas persistentes, pilas como WordPress o n8n), los de Mailway y cualquier otro |
| Volcados | `/volcados/<svc_id>/volcado.sql.gz` | Volcado SQL de cada base PostgreSQL, MySQL o MongoDB en marcha (las mismas órdenes que la copia de su pestaña Backups) |
| Imágenes | `/imagenes/<svc_id>/imagen.tar` | La imagen que corre en cada servicio de repositorio: al restaurar se vuelve a ella **sin GitHub** y sin compilar |
| Manifiesto | `/elementos/manifiesto/manifiesto.json` | Versiones, inventario de Skyway y de Mailway, y cada elemento con su instantánea |

### 2.1 Coherencia: dos pasadas

Un volumen en uso no se puede copiar «en caliente» sin riesgo: una base de
datos cambia mientras se lee. Cada volumen se copia en dos pasadas:

1. **En caliente**, con todo en marcha: sube casi todo.
2. Con sus contenedores **en pausa** (`docker pause`; el motor de correo,
   **parado** para que RocksDB cierre limpio), otra pasada que solo lee lo
   que ha cambiado desde la primera. Dura segundos.

El resultado es el de un corte de luz en ese instante, del que cualquier base
de datos (PostgreSQL, MySQL, SQLite, Redis, RocksDB) sabe recuperarse. Si la
segunda pasada tarda más de `PAUSA_MAXIMA` (15 minutos), se corta, los
servicios se reanudan y queda la primera con un aviso. Ningún contenedor se
queda en pausa ni parado aunque la copia falle o se interrumpa. Mientras el
motor de correo está parado, el panel de Mailway pasa a modo mantenimiento
para que su vigilante no lo tome por una caída.

### 2.2 Lo nuevo entra solo

- **Skyway** dice qué tiene cada proyecto con su herramienta interna
  (`tools/copias.ts inventario`): los volúmenes salen de `serviceVolumeNames`,
  la misma lista que mide el disco y que borra el borrado del servicio.
- **Mailway** declara lo suyo en `deploy/copias.sh` (volumen, papel y cómo
  copiarlo). Su CI (`deploy/prueba-copias.sh`) falla si un volumen de sus
  compose no tiene regla.
- Cualquier volumen que nadie declara se copia igualmente (consistencia por
  pausa) y la copia avisa: «Volumen sin regla copiado». Solo se excluyen la
  caché de restic, la de BuildKit, los volúmenes anónimos y los de
  `EXCLUIR=`.
- Si el panel de Skyway no responde, la copia se hace igual con lo que se ve
  en Docker (etiquetas `skyway.project`/`skyway.service`), sin nombres ni
  volcados, y lo avisa.

## 3. Restaurar

Todo con `sudo skyway copias restaurar …` (o el menú `sudo skyway copias`).
Por defecto, de la **última copia válida** que incluye lo pedido; si no,
`--ejecucion AAAAMMDD-HHMMSS` o `--fecha AAAA-MM-DD` (la última de ese día,
UTC). Sin `-y`, enseña la copia y pregunta antes de tocar nada.

```bash
sudo skyway copias lista                                   # copias disponibles
sudo skyway copias ver 20261013-033000                     # qué hay en una

sudo skyway copias restaurar proyecto web-acme             # un proyecto (sus volúmenes)
sudo skyway copias restaurar servicio web-acme/db          # un servicio
sudo skyway copias restaurar servicio web-acme/db --volcados   # una base desde su volcado SQL
sudo skyway copias restaurar correo                        # solo Mailway
sudo skyway copias restaurar skyway                        # solo el panel de Skyway
sudo skyway copias restaurar volumen <nombre>              # un volumen cualquiera
sudo skyway copias restaurar todo                          # todo (también en el mismo servidor)
sudo skyway copias extraer /root/recuperado --elemento /volumenes/skyway-web-acme-web-data
```

| Orden | Qué vuelve a la fecha de la copia | Qué no cambia |
| --- | --- | --- |
| `proyecto <x>` | Los volúmenes de sus servicios (bases y ficheros). Se paran sus contenedores, se restaura y se vuelven a arrancar | El panel (variables, dominios…) y los demás proyectos |
| `servicio <x>` | Igual, solo ese servicio (`proyecto/servicio`, nombre o id) | Lo demás |
| `--volcados` | Las bases con volcado se vacían y se cargan desde él (la imagen crea una base nueva con las credenciales del servicio); las aplicaciones siguen paradas hasta que termina. Sirve para pasar a una versión más nueva del motor | — |
| `correo` | Buzones y su correo, alias, dominios con sus claves DKIM, webmail, Bulwark, el panel de Mailway y su `deploy/.env` (el anterior se guarda como `.env.antes-de-restaurar-<fecha>`) | Skyway y sus proyectos |
| `skyway` | Proyectos, servicios, variables, usuarios y ajustes del panel (`skyway.db`); con `--con-config`, también su `.env` | Los datos de las webs y bases |
| `volumen <x>` | Ese volumen, exactamente como estaba (lo que sobra se borra) | Lo demás |
| `todo` | Todo lo anterior y el código de Skyway y Mailway en su commit | — |
| `extraer <carpeta>` | Nada: deja los ficheros en la carpeta para sacar lo que haga falta (una factura, una foto) | Todo |

Restaurar un proyecto que ya no existe en el panel no recrea sus servicios:
la copia lo dice y propone restaurar antes el panel de esa fecha.

## 4. Servidor nuevo: restaurar.sh

Con el servidor perdido, en uno nuevo (Ubuntu o Debian, con el DNS aún
apuntando al anterior o no, da igual):

```bash
curl -fsSLO https://raw.githubusercontent.com/NkrowOne/Skyway/main/scripts/copias/restaurar.sh
sudo bash restaurar.sh                       # pide los datos de recuperación
sudo bash restaurar.sh --datos datos.txt     # o los lee de un fichero (el formato de «datos-recuperacion»)
sudo bash restaurar.sh --kit kit-….zip       # o desde un kit (§5)
```

`restaurar.sh` también va dentro de cada kit. Lo que hace:

1. Instala Docker (con su instalador oficial) y `jq`, `git` y `curl` si
   faltan, preguntando antes.
2. Se conecta con las copias, enseña las completas y restaura la elegida
   (por defecto, la última).
3. Saca de esa copia **su propio** `copias.sh` y le pasa el trabajo, que:
   - recupera el código de Skyway y Mailway del paquete de git de la copia,
     en su commit y en la misma carpeta, siguiendo otra vez la rama de GitHub;
   - repone los `.env` y los cambios locales;
   - crea todos los volúmenes con su nombre y sus etiquetas de Compose, y
     los restaura;
   - carga las imágenes de las webs;
   - arranca Skyway (`docker compose up -d --build`);
   - si la IP es otra, la cambia en Ajustes y en **todos los registros A de
     Cloudflare** que apuntaban a la anterior (los de Skyway y los del
     correo, si están en la cuenta conectada), enseñando antes la lista;
   - vuelve a desplegar todos los servicios: primero las bases, después las
     webs, que vuelven a su imagen de la copia (sin GitHub);
   - aplica Mailway con su `reaplicar` (`instalar.sh --actualizar`, con la IP
     nueva);
   - deja las copias configuradas y ofrece activar la copia diaria.

Pendiente a mano si la IP ha cambiado:

- **DNS inverso (PTR)** de la IP nueva con el nombre del servidor de correo
  (`MAIL_HOSTNAME`), en el panel del proveedor. El nombre del servidor de
  correo no cambia: los MX de los clientes siguen valiendo.
- Los dominios cuyo DNS no está en la cuenta de Cloudflare conectada:
  registro A a la IP nueva.
- El puerto 25 de salida en el proveedor nuevo (`mailway comprobar`).

## 5. El kit para guardar en local

Un ZIP con una copia concreta, para guardarla fuera del servidor y del S3
(en un disco, en tu ordenador): la regla 3-2-1.

- Desde el panel: Ajustes → Copias externas → «Preparar kit» y, cuando esté
  listo, «Descargar». Se borra del servidor a las 24 horas.
- Desde la terminal: `sudo skyway copias kit [todo|skyway|correo|proyecto <x>] [--ejecucion ID]`
  (queda en la carpeta del panel; la orden indica la ruta y el `scp` para
  bajarlo).

Contenido:

```
kit-<ejecución>-<alcance>/
  LEEME.txt                 qué es y cómo se abre
  descodificar.bat / .ps1   Windows: doble clic en el .bat
  descodificar.sh           macOS y Linux: bash descodificar.sh
  restaurar.sh              para montar un servidor nuevo desde el kit
  contenido.txt             fecha, proyectos y versiones (sin secretos)
  repositorio/              los datos, cifrados (un repositorio de restic)
  bin/                      restic para Linux, macOS y Windows
```

Al descodificar, se pide la contraseña de las copias y todo aparece legible en
`descodificado/`: los volúmenes con sus ficheros, los volcados SQL
(`.sql.gz`), la configuración y el código. Para restaurar un servidor entero
desde el kit, hace falta uno de alcance `todo`: `sudo bash restaurar.sh --kit kit-….zip`.

## 6. El panel: Ajustes → Copias externas

Solo administradores. Sin configurar, explica los pasos. Configuradas,
muestra la última copia (fecha, resultado, duración, tamaño nuevo y avisos),
la última correcta, la próxima, la última comprobación y lo que está en
curso; permite «Hacer copia ahora», «Comprobar copias» y preparar, descargar
o borrar un kit (de todo, solo de Skyway, solo del correo o de un proyecto); y
enseña, por cada copia, las órdenes para restaurarla.

El panel **nunca ejecuta nada en el servidor**: lee el estado que escribe el
script en `<datos de Skyway>/copias/` y deja peticiones en
`copias/peticiones/`, que atiende la unidad `skyway-copias-peticiones` (solo
copia, comprobación y kit; restaurar se hace siempre desde la terminal).
Detalle de las rutas en [FUNCIONALIDAD.md](FUNCIONALIDAD.md) §7.8.

## 7. Versiones y compatibilidad

Skyway y Mailway cambian; las copias se pensaron para eso:

- **Cada copia guarda sus versiones** (Skyway, Mailway, serie del motor de
  correo, restic, formato de la copia) en su manifiesto.
- **Cada copia lleva su propio código de copias.** `restaurar.sh` es mínimo y
  estable: saca de la copia elegida su `copias.sh` y es ese el que restaura.
  Una copia de hace dos años se restaura con las herramientas de hace dos
  años, y el código de Skyway y Mailway de esa fecha.
- **Restaurar y después actualizar.** En un servidor nuevo todo vuelve en su
  versión; luego `skyway update` y `mailway update` lo llevan a la actual con
  sus migraciones, que solo avanzan. Una copia con el motor de correo 0.15
  vuelve con la 0.15; después, `mailway migrar-motor`.
- **Copia más nueva que el código instalado:** `restaurar skyway` y
  `restaurar correo` se niegan y explican qué actualizar antes (una base de
  datos de una versión nueva no funciona con un código anterior). `restaurar
  todo` no tiene ese problema: trae su código.
- **Bases en SQL:** además del volumen, cada base PostgreSQL, MySQL o MongoDB
  se guarda como volcado SQL, que se carga en una versión más nueva del motor
  (`--volcados`).
- **Formato:** `FORMATO` de `copias.sh` sube con un cambio incompatible; un
  `copias.sh` antiguo que encuentra una copia más nueva lo dice y no la toca.

## 8. Retención, espacio y comprobaciones

- Se conservan **ejecuciones enteras**, no instantáneas sueltas: siempre la
  última completa, la última de cada uno de los últimos `RETENCION_DIARIAS`
  días (7), de las últimas `RETENCION_SEMANALES` semanas (4) y de los últimos
  `RETENCION_MENSUALES` meses (6). Las parciales (antes de actualizar, de un
  proyecto) se guardan 14 días.
- Una vez por semana, tras la copia, se limpian los datos que ya no usa
  ninguna copia (`restic prune`) y se comprueba el repositorio
  (`restic check`); una vez al mes, leyendo además el 5 % de los datos.
- **Restauración de prueba mensual:** la copia programada restaura una vez al
  mes, en una carpeta temporal, la base del panel de la última copia completa
  y comprueba que se abre (integridad de SQLite). Si falla, avisa. El panel
  muestra la última.
- `sudo skyway copias comprobar` hace las dos cosas a demanda.
- Con el bloqueo de objetos, lo que se retira no se borra al momento: queda
  como versión antigua hasta que la regla de ciclo de vida la borra (31 días).
  Cuenta en el espacio usado durante ese tiempo.
- Orientación: la primera copia ocupa algo menos que los datos (restic
  comprime); cada noche se suma solo lo nuevo.

## 9. Seguridad y bloqueo de objetos

- **Cifrado:** restic cifra todo (AES-256) con la contraseña de las copias
  antes de salir del servidor. El proveedor solo ve ficheros con nombres
  aleatorios.
- **Secretos en el servidor:** `/etc/skyway-copias/` (700) guarda la
  configuración, las credenciales del S3 (`s3.env`) y la contraseña
  (`contrasena`), los tres de root con permisos 600. Nunca salen en registros,
  estado del panel ni manifiestos.
- **Lo que hay dentro de una copia:** los `.env` y la base del panel llevan
  secretos (tokens, claves). Por eso la copia va cifrada y la descarga del kit
  desde el panel exige sesión de administrador en el navegador.
- **Bloqueo de objetos:** con Object Lock, borrar o sobrescribir solo añade
  marcas y versiones nuevas; lo anterior queda bloqueado 30 días. Si alguien
  con acceso al servidor borrara las copias, se deshace con la clave de
  **administración** del bucket (no se guarda):

  ```bash
  sudo skyway copias recuperar-bucket --desde 2026-10-10
  ```

  Devuelve la carpeta de las copias a como estaba en esa fecha (las copias
  posteriores también desaparecen) y comprueba el repositorio.
- **Clave del servidor sin permisos de más:** sin `BypassGovernanceRetention`
  ni permisos sobre el bucket (§1.1). En modo COMPLIANCE nadie, ni la
  administración, puede borrar antes de que caduque el bloqueo.

## 10. Configuración

`/etc/skyway-copias/config`, una clave por línea (`CLAVE=valor`, sin
comillas). La escribe `configurar`; se puede editar a mano.

| Clave | Por defecto | Qué es |
| --- | --- | --- |
| `S3_ENDPOINT` | — | `https://s3.cubbit.eu` |
| `S3_REGION` | — | `eu-west-1` |
| `S3_BUCKET` | — | Bucket |
| `S3_PREFIJO` | nombre del servidor | Carpeta dentro del bucket: una por servidor |
| `S3_ESTILO` | `auto` | `path` o `dns` si el proveedor lo exige |
| `HORA` | `03:30` | Hora de la copia diaria (`activar` la aplica) |
| `RETENCION_DIARIAS` / `_SEMANALES` / `_MENSUALES` | 7 / 4 / 6 | §8 |
| `AVISO_URL` | — | Vigilante externo (§1.3) |
| `IMAGENES` | `si` | `no` para no copiar las imágenes de las webs |
| `EXCLUIR` | — | Volúmenes que no se copian, separados por espacios |
| `PAUSA_MAXIMA` | `900` | Segundos máximos de pausa en la segunda pasada |
| `SKYWAY_DIR` / `MAILWAY_DIR` | detectados | Carpetas de los repositorios (`MAILWAY_DIR=no`: sin Mailway) |

Estado y temporales en `/var/lib/skyway-copias/` (manifiestos de las copias
hechas desde aquí, caché de los binarios de restic del kit, cerrojo). La caché
de restic, en el volumen `skyway-copias-cache`.

Horarios por defecto: actualización de Mailway 03:00, **copias 03:30**,
copias internas del panel 04:00, actualización de Skyway 04:30.

## 11. Problemas frecuentes

- **«No se puede conectar con …»:** el servidor no llega al endpoint (red,
  cortafuegos, endpoint mal escrito). La copia programada lo reintenta 5
  minutos antes de darla por fallida.
- **«La contraseña de las copias no abre el repositorio»:** se ha cambiado
  `/etc/skyway-copias/contrasena`. Ponla de nuevo desde tus datos de
  recuperación.
- **La prueba de escritura falla al configurar:** la clave no tiene permisos
  de escritura en el bucket, o el proveedor exige algo con el bloqueo de
  objetos que restic no envía. El mensaje de restic lo dice.
- **«Volumen sin regla copiado»:** un volumen que no declara ni Skyway ni
  Mailway (uno creado a mano, de otro compose). Se copia igual; si no hace
  falta, añádelo a `EXCLUIR=`.
- **«Ya hay otra operación de copias en curso»:** una copia, kit o
  restauración a la vez. `sudo skyway copias estado` muestra cuál.
- **Una copia se quedó a medias** (apagón): la siguiente lo arregla; las
  instantáneas sueltas sin manifiesto se retiran a los 2 días.

## 12. Para desarrollar

- `scripts/copias/copias.sh`: el orquestador (bash; Docker, jq, git, curl).
- `scripts/copias/restaurar.sh`: arranque en limpio, mínimo y estable.
- `scripts/copias/kit/`: plantillas del kit (`descodificar.*`, `LEEME.txt`).
- `server/src/tools/copias.ts`: `inventario` (proyectos, servicios,
  volúmenes, órdenes de volcado, despliegue en marcha) y `repuntar` (cambio
  de IP en Ajustes y en Cloudflare). Formato en FUNCIONALIDAD.md §9.
- `server/src/copiasexternas.ts` y `server/src/routes/copias.ts`: el panel.
- Mailway: `deploy/copias.sh` (`inventario`, `parar`, `arrancar`,
  `reaplicar`, `mantenimiento on|off`).
- `scripts/copias/prueba-real.sh`: prueba completa con Docker, restic y un S3
  local con bloqueo de objetos (versitygw): copia, restauraciones por partes,
  volcados, kit y descodificación, peticiones del panel, S3 caído, retención
  y un servidor nuevo desde cero con `restaurar.sh`. La ejecuta la CI
  (`.github/workflows/copias.yml`).

**Regla:** todo estado nuevo debe quedar cubierto. Un volumen de un servicio
va en `serviceVolumeNames`; uno del `docker-compose.yml` de Skyway, en
`copias.sh` (la prueba `server/test/copias-cobertura.test.ts` lo exige); uno de
Mailway, en su `deploy/copias.sh` (lo exige `deploy/prueba-copias.sh`).
