# Gastos — Recreo & Pablo

PWA en JavaScript vanilla (sin build, sin frameworks) para que los 3 socios de
dos negocios (**Pancho Recreo** 🌭 y **Heladería Pablo** 🍦) registren gastos
compartidos, vean cuánto puso cada uno, sepan quién le debe a quién, y anoten
cuánto se facturó cada día. Corre en el celular de cada socio como app
instalada (Firestore la mantiene sincronizada entre todos los dispositivos en
tiempo real, con soporte offline).

## Stack

- **Sin build ni npm.** HTML/CSS/JS servidos tal cual — se puede abrir
  editando y recargando el navegador.
- **Firebase** (cargado por CDN, no está en `node_modules` ni en el repo):
  - **Firestore** — base de datos en tiempo real (`onSnapshot`) para gastos,
    facturación y configuración de socios.
  - **Auth anónima** — cada dispositivo se autentica sin login/contraseña;
    solo sirve para que las reglas de seguridad de Firestore exijan
    `request.auth != null`.
  - **Storage** — fotos de facturas (se comprimen en el navegador antes de
    subir, ver `compressImage` en [app.js](app.js)).
- **Service worker** ([service-worker.js](service-worker.js)) — cachea el
  app shell (HTML/CSS/JS/íconos) para que abra offline; todo lo que es
  Firebase pasa siempre directo a la red, nunca se cachea. Estrategia
  **red primero, caché como respaldo offline** (no al revés) — así cualquier
  deploy nuevo se ve apenas hay internet, sin que el celular quede pegado a
  una versión vieja. Si se cambia el shell y por algún motivo un celular
  sigue viendo lo viejo, subir el número de `CACHE_NAME` fuerza un reset
  limpio.
- **manifest.json** — permite "Agregar a pantalla de inicio" como app nativa.

## Archivos

| Archivo | Contenido |
|---|---|
| [index.html](index.html) | Todas las pantallas y modales del DOM (ver abajo). Un solo archivo, se muestra/oculta con clases `.screen`/`.active`. |
| [app.js](app.js) | Toda la lógica: estado en memoria, Firebase, render, event listeners. Sin framework — manipulación directa del DOM. |
| [styles.css](styles.css) | Diseño con variables CSS (`:root`) para tema claro/oscuro automático (`prefers-color-scheme`). |
| [manifest.json](manifest.json) / [service-worker.js](service-worker.js) | Configuración PWA. |
| [icons/](icons/) | Íconos de la app (192/512/maskable). |

## Modelo de datos (Firestore)

No hay backend propio: el navegador habla directo con Firestore usando las
credenciales públicas del proyecto (`firebaseConfig`), protegido por reglas de
seguridad que exigen autenticación anónima.

- **`config/socios`** (un solo documento) —
  `{ socios: [string, string, string], colaboradores: string[], colaboradorNegocio: { [nombre]: "pancho"|"heladeria" }, admins: string[], pins: { [nombre]: "1234" } }`.
  Se crea una única vez, la primera vez que alguien conecta el negocio (ver
  `handleSetupGuardar`). El resto de los dispositivos lo leen y ya no lo
  vuelven a pedir. `admins` y `pins` se explican en la sección de abajo.
  `colaboradorNegocio` se explica en "Acceso restringido por negocio" más
  abajo — un colaborador que no aparece ahí ve los 2 negocios.
- **`gastos`** (colección) — un doc por gasto:
  `{ importe, descripcion, categoria, pagadoPor, negocio, fecha, creadoEn, fotoUrl?, fotoPath? }`.
  `negocio` es `"pancho"` o `"heladeria"` (ver `NEGOCIOS` en app.js) — **ambos
  negocios comparten la misma colección**, se filtran en memoria con
  `gastosDelNegocio()`.
- **`facturacion`** (colección) — un doc por cierre diario:
  `{ importe, registradoPor, negocio, fecha, creadoEn }`. Mismo patrón que
  `gastos`.
- **`ideas`** (colección) — un doc por idea: `{ texto, estado, votos, propuestoPor, creadoEn }`.
  **A propósito NO tiene campo `negocio`** — son compartidas entre Pancho Recreo
  y Heladería Pablo, porque los 3 socios son dueños de ambos. `estado` es
  `"pendiente"` o `"concretada"`. `votos` es un array de nombres (como un
  "me interesa" — `toggleVoto()` usa `arrayUnion`/`arrayRemove`); las
  pendientes se ordenan por cantidad de votos, así se ve qué le importa más
  al equipo sin que nadie decida solo. Cualquiera puede crear una idea,
  votarla y tildarla como concretada (todo libre, sin admin); solo el admin
  puede borrarla (`deleteIdea()`). Tiene su **propia pantalla** (`screen-ideas`),
  accesible desde un botón arriba de todo en `screen-negocio` — justamente
  porque no depende de qué negocio estés mirando, no vive adentro de `screen-app`.
- **Storage**: fotos de facturas en `recibos/{negocio}/{timestamp}_{random}.jpg`.
  Se borran solas a los 4 meses (`FOTO_RETENCION_DIAS`) vía
  `limpiarFotosVencidas()` — **el gasto nunca se borra, solo la foto**.

Los 3 socios entran en el reparto de deudas; los `colaboradores` (ej. una
encargada) pueden cargar gastos y aparecer como "quién pagó", pero quedan
afuera del cálculo de balance entre socios (`renderColaboradoresTotales` los
muestra aparte, solo informativo).

## Flujo de arranque (3 caminos posibles en `app.js`)

1. **`attemptReconnect()`** — se llama siempre al abrir la app. Si ya hay
   `firebaseConfig` guardada en `localStorage`, reconecta directo sin pedir
   nada (usa el caché de socios mientras espera confirmación de Firestore).
2. **`handleSetupConnect()`** — primera vez que se abre la app en un
   dispositivo nuevo: pantalla de setup, pide pegar el `firebaseConfig`. Si el
   negocio ya tiene socios cargados en Firestore, entra directo. Si no, pasa
   al paso 2.
3. **`handleSetupGuardar()`** — solo se ve la primerísima vez que alguien
   conecta el negocio (todavía no existe `config/socios`): pide los 3 nombres
   y colaboradores opcionales, los guarda, y arranca la app.

Los tres terminan llamando a `bootApp()`, que dispara los listeners en tiempo
real (`listenGastos`, `listenFacturacion`, `listenSocios`) y llama a
`resumeSession()`.

## Identidad y permisos (PIN + admin)

Además de la config de Firebase (por celular), cada persona se identifica una
vez con su nombre + un PIN de 4 dígitos:

- **`resumeSession()`** — si el celular ya tiene un usuario guardado
  (`localStorage["gn_current_user"]`), entra directo. Si no, muestra
  **"¿Quién sos?"** (`screen-quien-sos`) con un botón por cada socio/colaborador.
- Al tocar un nombre, `openPinModal()` decide el modo según si esa persona ya
  tiene PIN en `pins`: **crear** (primera vez, pide el PIN dos veces) o
  **verificar** (ya tiene uno, lo valida contra Firestore).
- Una vez identificado, se recuerda en ese celular igual que la config —
  no se vuelve a pedir salvo que se use **"Cambiar de usuario"** en Ajustes
  (`cambiarUsuario()`, solo borra la identidad local, no la conexión).
- **`admins`** (subconjunto de `socios`, elegido con los checkboxes del setup
  inicial) puede editar y borrar gastos/cierres ya cargados — ver botones ✏️/🗑️
  en `renderGastos()`/`renderFacturado()`, y `deleteGasto()`/`deleteCierre()`.
  El resto de las personas solo puede cargar y ver.

⚠️ **Esto NO es una capa de seguridad real.** Firestore sigue aceptando
lectura/escritura de cualquier dispositivo autenticado anónimamente (ver
regla `request.auth != null`), así que alguien con la `firebaseConfig` podría
saltearse el PIN yendo directo a la base. Sirve solo para identificar quién
usa cada celular y decidir qué botones mostrar — no para proteger los datos
de alguien mal intencionado con acceso a la config. Si eso llega a hacer
falta, hay que migrar a Firebase Auth con cuentas reales + reglas de
Firestore por rol.

## Acceso restringido por negocio (solo colaboradores)

Los 3 **socios** siempre ven los 2 negocios — reparten gastos entre ambos
(ver "Reparto de deudas" más abajo), así que nunca se les restringe nada.

Un **colaborador** (ej. la encargada de un local puntual) puede quedar
atado a un solo negocio: `colaboradorNegocio[nombre]` guarda `"pancho"` o
`"heladeria"`. Si no aparece ahí (o el valor no matchea un id de
`NEGOCIOS`), ve los 2 — es el default seguro para no dejar a nadie sin
acceso por accidente (ej. colaboradores creados antes de que existiera
este campo).

- **`negociosPermitidos(nombre)`** — decide qué negocios puede ver esa
  persona; lo usan `renderNegocioCards()` (filtra las tarjetas de
  "¿Qué negocio querés ver?"), `renderSeccionCards()` (oculta "← Cambiar
  negocio" si solo tiene uno permitido) e `irANegocioOSeleccion()`
  (saltea directo a `selectNegocio()` sin mostrar el selector si la
  persona solo tiene un negocio permitido — se llama después de
  identificarse, en vez del `showScreen("screen-negocio")` de antes).
- **Se asigna en dos lugares**: al agregar colaboradores en el setup
  inicial (`addColaboradorRow()`, un `<select>` por fila) o después,
  desde **Ajustes → "Otras personas"** — ahí el admin ve un `<select>`
  editable por colaborador (el resto de las personas solo ve el nombre
  del negocio como texto). Cambiar el `<select>` de Ajustes guarda al
  toque con `updateDoc` sobre `colaboradorNegocio.${nombre}`.

## Navegación de pantallas

`index.html` tiene un `<div class="screen">` por pantalla; `showScreen(id)`
en app.js oculta todas y muestra una. Jerarquía:

```
screen-negocio (elegir Pancho / Heladería)
  └─ screen-seccion (elegir Gastos / Facturado / Resumen mensual)
       ├─ screen-app       (tabs: Gastos, Balance, Ajustes)
       ├─ screen-facturado
       └─ screen-resumen
screen-ajustes → screen-fotos (fotos guardadas, solo alcanzable desde Ajustes)
```

⚠️ Dentro de `screen-app` hay tabs (`.tab` + `.tabbtn`) manejadas por
`switchTab()`. Las pantallas de Facturado/Resumen/Fotos **también** usan la
clase `.tab` (solo para heredar estilos), pero **no** son parte de ese tabbar
— por eso `switchTab()` limita su selector a `#screen-app` a propósito (ver
comentario en el código). No tocar ese scoping sin entender por qué.

## Reglas de negocio a tener en cuenta

- **Reparto de deudas** (`computeSettlements`): calcula cuánto "debería" haber
  puesto cada socio (`total / 3`) y arma la cantidad mínima de transferencias
  para emparejar cuentas. Solo considera a los 3 socios, nunca a
  colaboradores.
- **Retención de fotos**: 120 días (~4 meses) desde `fecha` del gasto, no
  desde que se cargó. Se corre una sola vez por apertura de la app
  (`fotosLimpiezaHecha`), disparado por el primer `onSnapshot` de gastos.
- **XSS**: cualquier texto que viene de Firestore (descripción, nombres) se
  inserta con `escapeHtml()` antes de ir a `innerHTML`. Si se agregan campos
  de texto nuevos, hay que escaparlos igual.
- **Reintento de conexión Firebase**: `initFirebase()` borra apps Firebase
  previas (`getApps()` / `deleteApp()`) antes de reinicializar, porque el SDK
  tira `app/duplicate-app` si se llama `initializeApp` dos veces en la misma
  carga de página (pasa si el usuario reintenta conectar tras un error).

## Exportar datos (CSV)

En Ajustes → "Exportar datos", dos botones bajan los gastos y la
facturación del negocio actualmente seleccionado como `.csv`
(`exportGastosCSV()` / `exportFacturacionCSV()` en app.js) — se arma en el
navegador con un `Blob` y se dispara la descarga con un `<a download>`
temporal, sin ninguna librería. Lleva un BOM UTF-8 al principio para que
Excel no rompa los acentos.

## Cómo probarlo en local

No hace falta build. Basta con servir la carpeta como archivos estáticos
(abrir `index.html` directo con `file://` no funciona bien por los `import()`
dinámicos y el service worker, que requieren `http(s)://`):

```bash
npx serve .
# o, si no hay Node instalado:
python -m http.server 5177
```

y abrir la URL que imprima en la consola (`http://localhost:5177` con Python).

## Configurar Firebase (una vez por negocio)

La guía completa está también dentro de la app (pantalla de Setup → "¿No
sabés dónde conseguir esto?"):

1. Crear proyecto gratis en `console.firebase.google.com`.
2. Agregar una app "Web" y copiar el objeto `firebaseConfig`.
3. Activar **Firestore Database** (modo producción) y **Authentication →
   Anonymous**.
4. En Firestore → Reglas: `allow read, write: if request.auth != null;`
5. Activar **Storage** si se van a subir fotos de facturas.

## Estado del repo

Todavía no es un repositorio git (a diferencia de la carpeta hermana
`KIOSKO NUEVO`). Si se quiere versionar, avisar para inicializarlo.
