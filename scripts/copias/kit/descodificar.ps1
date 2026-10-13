#Requires -Version 5.1
#
# descodificar.ps1 - descodifica el kit de copia de seguridad (Windows 10 y 11).
#
# Restaura todas las instantáneas del repositorio cifrado (repositorio\) en
# descodificado\, junto a este script. Los ficheros quedan sin cifrar y se
# pueden abrir con cualquier programa. Los pasos para recuperar los datos en un
# servidor nuevo están en LEEME.txt.
#
# Se lanza con doble clic en descodificar.bat, que ejecuta PowerShell con
# -ExecutionPolicy Bypass: así no depende de la política de ejecución del
# equipo. Funciona con Windows PowerShell 5.1 (el que trae Windows) y con
# PowerShell 7.
#
# Uso:  descodificar.bat [-y] [--ayuda]
#
# Codificación: este fichero va en UTF-8 con BOM. Sin BOM, Windows PowerShell
# 5.1 lo lee como ANSI y estropea los acentos de los mensajes.
#
# Contraseña: se pide una sola vez (Read-Host -AsSecureString, que la oculta al
# escribirla), se pasa a restic por la variable de entorno RESTIC_PASSWORD y se
# borra al terminar. Para poder probar y automatizar el script sin terminal,
# también se acepta si RESTIC_PASSWORD ya está definida en el entorno o, cuando
# la entrada está redirigida, en la primera línea de la entrada estándar. Las
# respuestas a las preguntas siguientes se leen de las líneas que vengan después.
#
# Códigos de salida: 0 correcto; 1 error o instantáneas con errores; 2 opción
# no reconocida; 12 contraseña incorrecta (el mismo código que usa restic);
# 130 interrumpido.

# Con 'Stop' y la redirección 2>&1, Windows PowerShell 5.1 lanza una excepción
# por cada línea que una orden nativa escribe en stderr, aunque termine bien.
# Por eso el resultado de restic se comprueba siempre con $LASTEXITCODE.
$ErrorActionPreference = 'Continue'

$VersionRestic = '0.19.1'
$UrlRestic = 'https://github.com/restic/restic/releases'
$Repo = 'repositorio'
$Destino = 'descodificado'
$AvisoWindows = @(
    'Aviso para Windows: algunos nombres de fichero de Linux (por ejemplo, los que',
    'contienen «:» u otros caracteres no permitidos), las rutas demasiado largas y',
    'los enlaces simbólicos pueden no restaurarse. Para una restauración completa,',
    'usa Linux o macOS.'
)

$CodificacionAnterior = $null

# ---------- mensajes ----------
function Salir {
    param([int]$Codigo)
    # La contraseña no debe quedarse en el entorno si el script se lanzó desde
    # una sesión de PowerShell que sigue abierta.
    Remove-Item Env:RESTIC_PASSWORD -ErrorAction SilentlyContinue
    if ($null -ne $script:CodificacionAnterior) {
        # Opcional: si la consola no permite cambiarla, no pasa nada.
        try { [Console]::OutputEncoding = $script:CodificacionAnterior } catch { }
    }
    exit $Codigo
}

function Aviso {
    param([string]$Texto)
    Write-Host ('Aviso: ' + $Texto) -ForegroundColor Yellow
}

# Fallo <código> <líneas>: muestra un error (una línea por elemento) y sale.
function Fallo {
    param([int]$Codigo, [string[]]$Lineas)
    $primera = $true
    foreach ($linea in $Lineas) {
        if ($primera) {
            Write-Host ('Error: ' + $linea) -ForegroundColor Red
            $primera = $false
        } else {
            Write-Host ('       ' + $linea) -ForegroundColor Red
        }
    }
    Salir $Codigo
}

function Mostrar-Ayuda {
    Write-Host @'
Descodifica el kit de copia de seguridad.

Restaura todas las instantáneas del repositorio cifrado («repositorio») en la
carpeta «descodificado», junto a este script. Los ficheros quedan sin cifrar y
se pueden abrir con cualquier programa.

Uso:
  descodificar.bat [opciones]

Opciones:
  -y, --yes      Continuar sin preguntar si «descodificado» ya contiene ficheros
  -h, --ayuda    Mostrar esta ayuda

La contraseña de las copias se pide una sola vez y se oculta al escribirla. Si
la variable de entorno RESTIC_PASSWORD ya está definida, se usa sin preguntar.
Si la entrada está redirigida, la contraseña se lee de la primera línea de la
entrada estándar.

El programa restic se toma de la carpeta «bin» (bin\restic-windows-amd64.exe) o,
si no está, del PATH.

Códigos de salida: 0 correcto; 1 error o instantáneas restauradas con errores;
2 opción no reconocida; 12 contraseña incorrecta.
'@
}

# Lee una respuesta. Con la entrada redirigida (pruebas, automatización) se lee
# directamente de ella, igual que la contraseña: Read-Host -AsSecureString
# necesita una consola para leer las teclas.
function Leer-Linea {
    param([string]$Indicador)
    if ([Console]::IsInputRedirected) {
        Write-Host ($Indicador + ' ') -NoNewline
        $linea = [Console]::In.ReadLine()
        Write-Host ''
        if ($null -eq $linea) { return '' }
        return $linea.TrimEnd("`r")
    }
    return (Read-Host -Prompt $Indicador)
}

# Devuelve $true solo si la respuesta es afirmativa; vacía o agotada es «no».
function Confirmar-Accion {
    param([string]$Pregunta)
    $respuesta = Leer-Linea ($Pregunta + ' [s/N]')
    return ($respuesta.Trim() -match '^(s|si|sí|y|yes)$')
}

# Comprueba que el programa arranca en este sistema: un .exe bloqueado por el
# sistema o dañado no sirve.
function Probar-Restic {
    param([string]$Ruta)
    try {
        $null = & $Ruta version 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# Extrae el mensaje de los errores JSON de restic ({"message_type":"exit_error",
# "message":"..."}); si una línea no es JSON, la devuelve tal cual.
function Obtener-Detalle {
    param([string[]]$Lineas)
    $partes = @()
    foreach ($linea in $Lineas) {
        if ([string]::IsNullOrWhiteSpace($linea)) { continue }
        $texto = $linea
        try {
            $objeto = ConvertFrom-Json -InputObject $linea
            if ($objeto -and $objeto.message) { $texto = [string]$objeto.message }
        } catch { }
        $partes += $texto
    }
    return ($partes -join ' ')
}

# ---------- opciones ----------
$AsumirSi = $false
foreach ($argumento in $args) {
    if ($argumento -match '^(-y|--yes|-yes|-si)$') {
        $AsumirSi = $true
    } elseif ($argumento -match '^(-h|--ayuda|--help|-ayuda|-help|-\?|/\?)$') {
        Mostrar-Ayuda
        exit 0
    } else {
        Fallo 2 @(('Opción no reconocida: {0}.' -f $argumento), 'Consulta las opciones con «descodificar.bat --ayuda».')
    }
}

try {
    # ---------- carpeta del kit ----------
    # Todo cuelga de la carpeta del script, se ejecute desde donde se ejecute.
    # Se usan rutas absolutas y no Set-Location: así no se depende de la carpeta
    # de trabajo con la que PowerShell lance restic (una ruta de red no vale) y,
    # si el script se ejecuta desde una sesión abierta, no se la deja cambiada.
    $Raiz = $PSScriptRoot
    if ([string]::IsNullOrEmpty($Raiz)) { $Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $RutaRepo = Join-Path $Raiz $Repo
    $RutaDestino = Join-Path $Raiz $Destino

    # restic escribe en UTF-8; sin esto, la consola de Windows (página de
    # códigos OEM) muestra mal los acentos de sus mensajes y de los nombres de fichero.
    try {
        $CodificacionAnterior = [Console]::OutputEncoding
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    } catch { }

    if (-not (Test-Path -LiteralPath $RutaRepo -PathType Container)) {
        Fallo 1 @(
            ('No se ha encontrado la carpeta «{0}» junto a este script.' -f $Repo),
            'Extrae primero todo el contenido del ZIP (clic derecho y «Extraer todo…») y ejecuta descodificar.bat desde la carpeta extraída, no desde dentro del ZIP.'
        )
    }
    if (-not (Test-Path -LiteralPath (Join-Path $RutaRepo 'config') -PathType Leaf)) {
        Fallo 1 @(
            ('La carpeta «{0}» está incompleta: falta el fichero «config».' -f $Repo),
            'Vuelve a extraer el ZIP completo.'
        )
    }

    # ---------- programa restic ----------
    $Restic = $null
    $Candidato = Join-Path (Join-Path $Raiz 'bin') 'restic-windows-amd64.exe'
    if (Test-Path -LiteralPath $Candidato -PathType Leaf) {
        # Un ZIP descargado de Internet marca sus ficheros como bloqueados y
        # Windows puede pedir confirmación o impedir su ejecución.
        try { Unblock-File -LiteralPath $Candidato -ErrorAction Stop } catch { }
        if (Probar-Restic $Candidato) {
            $Restic = $Candidato
        } else {
            Aviso 'No se ha podido ejecutar «bin\restic-windows-amd64.exe» en este sistema.'
        }
    }
    if (-not $Restic) {
        $enPath = Get-Command restic -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($enPath -and (Probar-Restic $enPath.Source)) {
            $Restic = $enPath.Source
        }
    }
    if (-not $Restic) {
        Fallo 1 @(
            'No se ha encontrado el programa restic para este sistema.',
            ('Este kit necesita restic {0}. Hay dos opciones:' -f $VersionRestic),
            ('  1. Descarga restic {0} de {1}' -f $VersionRestic, $UrlRestic),
            ('     (fichero restic_{0}_windows_amd64.zip), descomprímelo y guarda el programa' -f $VersionRestic),
            '     como bin\restic-windows-amd64.exe dentro de esta carpeta.',
            '  2. Instala restic en el sistema de modo que la orden «restic» funcione en PowerShell.',
            'Después, vuelve a ejecutar descodificar.bat.'
        )
    }

    # Solo informativo: si falla, se muestra únicamente «restic».
    $VersionUsada = ''
    try { $VersionUsada = [string](& $Restic version 2>$null | Select-Object -First 1) } catch { }
    $VersionUsada = ($VersionUsada -replace ' compiled.*$', '').Trim()
    if (-not $VersionUsada) { $VersionUsada = 'restic' }

    # La configuración de restic de quien ejecuta el script (otro repositorio u
    # otro origen de la contraseña) no debe interferir con la de este kit: el
    # fichero o la orden de contraseña tienen prioridad sobre RESTIC_PASSWORD, y
    # un fichero de repositorio choca con -r.
    foreach ($nombre in 'RESTIC_REPOSITORY', 'RESTIC_REPOSITORY_FILE', 'RESTIC_PASSWORD_FILE', 'RESTIC_PASSWORD_COMMAND', 'RESTIC_KEY_HINT') {
        Remove-Item -Path ('Env:' + $nombre) -ErrorAction SilentlyContinue
    }

    # Opciones comunes: --no-lock evita escribir en la carpeta del kit (puede
    # estar en un medio de solo lectura) y --no-cache evita dejar una caché en
    # el perfil del usuario, que en un repositorio local no aporta nada.
    $base = @('-r', $RutaRepo, '--no-cache', '--no-lock')

    Write-Host 'Descodificación del kit de copia de seguridad'
    Write-Host ('Carpeta del kit: {0}' -f $Raiz)
    Write-Host ('Programa: {0} ({1})' -f $VersionUsada, $Restic)
    Write-Host ''

    # ---------- contraseña ----------
    if ([string]::IsNullOrEmpty($env:RESTIC_PASSWORD)) {
        if ([Console]::IsInputRedirected) {
            $leida = [Console]::In.ReadLine()
            if ($null -ne $leida) { $env:RESTIC_PASSWORD = $leida.TrimEnd("`r") }
        } else {
            $segura = Read-Host -Prompt 'Introduce la contraseña de las copias (se oculta al escribirla)' -AsSecureString
            $puntero = [IntPtr]::Zero
            try {
                $puntero = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura)
                $env:RESTIC_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($puntero)
            } finally {
                if ($puntero -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($puntero) }
            }
        }
    }
    if ([string]::IsNullOrEmpty($env:RESTIC_PASSWORD)) {
        Fallo 1 @('No se ha introducido ninguna contraseña.')
    }

    # ---------- comprobar la contraseña y obtener las instantáneas ----------
    # Un solo acceso al repositorio sirve para las dos cosas: si la contraseña
    # es incorrecta, restic termina con el código 12 antes de listar nada. Con
    # --json los errores de restic salen en JSON por stderr (ErrorRecord con 2>&1).
    Write-Host 'Comprobando la contraseña…'
    $resultado = @(& $Restic @base snapshots --json 2>&1)
    $codigo = $LASTEXITCODE
    $lineasSalida = New-Object System.Collections.Generic.List[string]
    $lineasError = New-Object System.Collections.Generic.List[string]
    foreach ($elemento in $resultado) {
        if ($elemento -is [System.Management.Automation.ErrorRecord]) {
            [void]$lineasError.Add($elemento.ToString())
        } else {
            [void]$lineasSalida.Add([string]$elemento)
        }
    }
    if ($codigo -ne 0) {
        $detalle = Obtener-Detalle (@($lineasError) + @($lineasSalida))
        switch ($codigo) {
            12 {
                Fallo 12 @(
                    'La contraseña no es correcta.',
                    'Comprueba que es la contraseña de las copias (la misma con la que se cifró este kit),',
                    'escrita exactamente igual, y vuelve a ejecutar descodificar.bat.'
                )
            }
            10 {
                Fallo 1 @(
                    ('La carpeta «{0}» no contiene un repositorio de copias válido.' -f $Repo),
                    'Vuelve a extraer el ZIP completo.'
                )
            }
            130 {
                Fallo 130 @('Descodificación interrumpida.')
            }
            default {
                Fallo 1 @(('No se ha podido abrir el repositorio (código {0}).' -f $codigo), $detalle)
            }
        }
    }
    Write-Host 'Contraseña correcta.'

    # restic lista las instantáneas de la más antigua a la más reciente, y se
    # restauran en ese orden: si una ruta tiene varias, prevalece el contenido
    # de la última. ConvertFrom-Json devuelve la lista como un solo objeto en
    # Windows PowerShell 5.1 y desenrollada en PowerShell 7; el doble foreach
    # sirve para las dos formas.
    $ids = New-Object System.Collections.Generic.List[string]
    $json = ($lineasSalida -join "`n")
    $datos = $null
    try {
        $datos = ConvertFrom-Json -InputObject $json
    } catch {
        Fallo 1 @('No se ha podido interpretar la lista de instantáneas del repositorio.', $_.Exception.Message)
    }
    foreach ($elemento in $datos) {
        foreach ($instantanea in @($elemento)) {
            if ($null -ne $instantanea -and ([string]$instantanea.id) -match '^[0-9a-f]{64}$') {
                [void]$ids.Add([string]$instantanea.id)
            }
        }
    }
    $total = $ids.Count
    if ($total -eq 0) {
        Fallo 1 @('El repositorio no contiene ninguna instantánea.')
    }
    if ($total -eq 1) {
        Write-Host 'Se ha encontrado 1 instantánea.'
    } else {
        Write-Host ('Se han encontrado {0} instantáneas.' -f $total)
    }

    # ---------- carpeta de destino ----------
    if (Test-Path -LiteralPath $RutaDestino -PathType Leaf) {
        Fallo 1 @(
            ('Existe un fichero llamado «{0}» que no es una carpeta.' -f $Destino),
            'Cámbiale el nombre o elimínalo y vuelve a ejecutar el script.'
        )
    }
    if ((Test-Path -LiteralPath $RutaDestino -PathType Container) -and ($null -ne (Get-ChildItem -LiteralPath $RutaDestino -Force | Select-Object -First 1))) {
        if ($AsumirSi) {
            Write-Host ('La carpeta «{0}» ya contiene ficheros: se sobrescribirán los que tengan el mismo nombre.' -f $Destino)
        } else {
            Write-Host ''
            Write-Host ('La carpeta «{0}» ya contiene ficheros. Si continúas, se sobrescribirán los que tengan el mismo nombre.' -f $Destino)
            if (-not (Confirmar-Accion '¿Continuar?')) {
                Write-Host 'Operación cancelada. No se ha modificado nada.'
                Write-Host ('Para empezar de cero, cambia el nombre de la carpeta «{0}» o elimínala.' -f $Destino)
                Write-Host 'Con la opción -y el script continúa sin preguntar.'
                Salir 1
            }
        }
    }
    try {
        New-Item -ItemType Directory -Path $RutaDestino -Force -ErrorAction Stop | Out-Null
    } catch {
        Fallo 1 @(
            ('No se ha podido crear la carpeta «{0}» en {1}.' -f $Destino, $Raiz),
            'Copia el kit a una carpeta con permiso de escritura y vuelve a intentarlo.'
        )
    }

    # ---------- restauración ----------
    Write-Host ''
    Write-Host 'La restauración puede tardar varios minutos, según el tamaño del kit.'
    $n = 0
    $fallos = 0
    foreach ($id in $ids) {
        $n++
        Write-Host ''
        Write-Host ('[{0}/{1}] Restaurando la instantánea {2}…' -f $n, $total, $id.Substring(0, 8))
        & $Restic @base restore $id --target $RutaDestino
        $codigo = $LASTEXITCODE
        if ($codigo -eq 130) {
            Fallo 130 @('Descodificación interrumpida.')
        } elseif ($codigo -ne 0) {
            $fallos++
            Aviso ('La instantánea {0} no se ha restaurado por completo (código {1}).' -f $id.Substring(0, 8), $codigo)
        }
    }

    # ---------- resumen ----------
    Write-Host ''
    if ($fallos -gt 0) {
        Aviso ('{0} de {1} instantáneas se han restaurado con errores. Revisa los mensajes anteriores.' -f $fallos, $total)
    } else {
        Write-Host 'Descodificación terminada.'
    }
    Write-Host ''
    Write-Host 'Los ficheros están en:'
    Write-Host ('  {0}' -f $RutaDestino)
    Write-Host ''
    Write-Host 'Contenido:'
    $areas = @(
        @('volumenes', 'datos de los volúmenes de cada servicio'),
        @('volcados', 'volcados de las bases de datos (SQL comprimido, volcado.sql.gz)'),
        @('elementos', 'configuración (config), código (codigo) y manifiesto de la copia'),
        @('imagenes', 'imágenes de Docker de los servicios (imagen.tar)')
    )
    foreach ($area in $areas) {
        if (Test-Path -LiteralPath (Join-Path $RutaDestino $area[0]) -PathType Container) {
            Write-Host ('  {0,-12} {1}' -f ($area[0] + '\'), $area[1])
        }
    }
    Write-Host ''
    Write-Host 'Los ficheros ya no están cifrados y pueden incluir contraseñas y claves (por'
    Write-Host ('ejemplo, en la configuración). Guárdalos en un sitio seguro y elimina la carpeta')
    Write-Host ('«{0}» cuando dejes de necesitarla.' -f $Destino)
    Write-Host 'Para recuperar los datos en un servidor nuevo, consulta LEEME.txt.'
    Write-Host ''
    foreach ($linea in $AvisoWindows) { Write-Host $linea -ForegroundColor Yellow }

    if ($fallos -gt 0) { Salir 1 }
    Salir 0
} finally {
    Remove-Item Env:RESTIC_PASSWORD -ErrorAction SilentlyContinue
}
