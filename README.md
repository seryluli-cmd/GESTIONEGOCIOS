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
  `{ socios: [string, string, string], colaboradores: string[], colaboradorNegocio: { [nombre]: "pancho"|"heladeria" }, admins: string[], pins: { [nombre]: "1234" }, claveMaestraAdmin: string, cajaLocalMonto: number }`.
  Se crea una única vez, la primera vez que alguien conecta el negocio (ver
  `handleSetupGuardar`). El resto de los dispositivos lo leen y ya no lo
  vuelven a pedir. `admins` y `pins` se explican en la sección de abajo.
  `colaboradorNegocio` se explica en "Acceso restringido por negocio" más
  abajo — un colaborador que no aparece ahí ve los 2 negocios.
  **Los 3 lugares que leen este doc** (`connectAndBoot`, `listenSocios`,
  `handleSetupConnect`) vuelcan el resultado a las variables globales a
  través de una única función, `aplicarConfigSocios(data)` — si se agrega
  un campo nuevo al doc (como pasó con `cajaLocalMonto`), alcanza con
  tocar esa función, no los 3 lugares.
- **`gastos`** (colección) — un doc por gasto:
  `{ importe, descripcion, categoria, pagadoPor, formaPago, negocio, fecha, creadoEn, fotoUrl?, fotoPath? }`.
  `negocio` es `"pancho"` o `"heladeria"` (ver `NEGOCIOS` en app.js) — **ambos
  negocios comparten la misma colección**, se filtran en memoria con
  `gastosDelNegocio()`. `formaPago` es `"efectivo"`, `"digital"`, `"mixto"`
  (con `montoEfectivo`/`montoDigital` propios) o `"caja"` — este último solo
  existe en Pancho, ver **Caja del local** más abajo. Un gasto "caja" suma a
  Total Gastos y Rentabilidad como cualquier otro — no tiene ningún trato
  especial salvo restarse de `cajaLocalMonto` en el cálculo de "queda".
- **Caja del local** (campo `cajaLocalMonto` en `config/socios`, no una
  colección propia) — el efectivo físico que tiene la encargada de Pancho
  para pagar cosas sin transferirle cada vez. Es **un solo número que
  cualquier admin reescribe a mano desde Ajustes** (`guardarCajaLocal()`)
  para "reponer" la caja — a propósito no hay historial de reposiciones,
  se prefirió simple. Lo que "queda" se calcula en `renderResumen()`:
  `cajaLocalMonto` menos la suma de TODOS los gastos con `formaPago: "caja"`
  (de siempre, no solo del mes elegido) — se muestra en Resumen mensual
  solo si `negocioTieneCajaLocal(negocioActual)` da `true` (hoy solo
  Pancho, ver `tieneCajaLocal` en `NEGOCIOS`). Si un gasto "caja" deja el
  saldo en negativo, `saveGasto()` avisa con un `confirm()` (no bloquea,
  por si realmente se gastó de más y después se repone).
- **`facturacion`** (colección) — un doc por cierre diario:
  `{ importe, registradoPor, negocio, fecha, creadoEn }`. Mismo patrón que
  `gastos`. **Aviso "Caja faltante"**: a partir de las 5am, si no existe
  un cierre fechado el día que `fechaSugeridaCierre()` considera "de
  ayer" (ver `cierreFaltanteHoy()`), `renderFacturado()` muestra un
  cartel rojo (reusa el mismo estilo de "Falta abonar" de Gastos) con un
  botón "Cargar" que abre el modal con esa fecha precargada — solo se
  muestra mirando el mes actual, no al navegar meses viejos.
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
- **Storage**: fotos de gastos en `recibos/{negocio}/{timestamp}_{random}.jpg`.
  Se borran solas a los 4 meses (`FOTO_RETENCION_DIAS`) vía
  `limpiarFotosVencidas()` — **el gasto nunca se borra, solo la foto**. Las
  fotos de Cierre de Turno van en `cierres/{negocio}/{...}.jpg` (mismo
  patrón — ver `saveCierre()`, separadas por Pancho/Heladería vía
  `negocioActual`) pero **no** entran en esa limpieza automática de 4 meses
  (`limpiarFotosVencidas()` solo mira `gastos`) ni en "Fotos guardadas"
  (solo lista fotos de gastos) — quedan en Storage indefinidamente salvo
  que se borre el cierre entero.

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

## Lista de Gastos: fila, notas largas y "Ver detalle completo"

Cambios recientes en cómo se ve y se abre el detalle de un gasto
(`renderGastos()` en app.js) — documentados acá porque se probaron y
ajustaron varias veces seguidas en la misma sesión:

- **Fila de cada gasto**: se divide en `.expense-item-top` (avatar +
  texto + monto) y, debajo, `.expense-item-actions` (íconos 📷 foto /
  ✏️ editar / 🗑️ borrar). Antes todo iba en una sola fila y una
  descripción o nota larga quedaba apretada contra el avatar y los
  íconos. **Ojo**: Cierre de Turno y el aviso "Caja faltante" comparten
  la misma clase base `.expense-item` pero NO tienen `.expense-item-actions`
  — sus íconos se quedaron en la fila de siempre a propósito, porque su
  texto es corto y no lo necesitaba.
- **Notas largas**: se recortan a las primeras 2 palabras + "…" — el
  texto completo (y el resto de los campos) se ve tocando **"Ver detalle
  completo"**, que abre `#modal-detalle-gasto` (`verDetalleGasto(id)` /
  `closeModalDetalleGasto()`). Notas de 2 palabras o menos se muestran
  enteras, sin el botón.
- **`#modal-detalle-gasto`**: reemplaza lo que antes era un `alert()`
  nativo del navegador (mostraba el título "gestionegocios.netlify.app
  dice", imposible de sacar o personalizar). Diseño final, a pedido: lista
  simple de `ETIQUETA: valor` — etiqueta en mayúscula y negrita gris
  (`.detalle-gasto-label`), valor en texto normal (`.detalle-gasto-valor`),
  **todo en gris salvo "Falta abonar"** que se muestra en rojo
  (`.detalle-gasto-label-critico`, mismo `--critical` que el resto de la
  app) — es la única excepción de color, a propósito. Botón único
  "Aceptar" (`.btn-primary`). Se probaron antes otras 2 versiones más
  "de diseño" (con avatar, categoría en pastilla de color, fecha con
  ícono, nota en tarjeta aparte) — se descartaron a pedido en favor de
  esta lista simple; si se quiere retomar esa idea más adelante, están en
  el historial de commits de abajo.

**Para revertir estos cambios puntuales sin tocar el resto** (por si se
prueba y no convence) — son 3 commits seguidos, cada uno independiente:
- `8dfddb5` Simplificar el detalle del gasto a una lista gris
- `cdb52e7` Rediseñar "Ver detalle completo" como modal propio
- `fd6a640` Mover íconos de foto/editar/borrar debajo del texto

Para deshacer los 3 (mantiene el historial, no reescribe nada — es la
opción segura):
```
git revert 8dfddb5 cdb52e7 fd6a640
git push origin master
```
Para deshacer solo el último ajuste de diseño (volver a la versión con
avatar/pastillas de color, quedándose con el resto):
```
git revert 8dfddb5
git push origin master
```
Si en cambio se quiere borrar directamente esos commits del historial
(en vez de sumar commits que los deshacen), `git reset --hard a9c65e3`
(el commit justo anterior a estos 3, "Agregar aviso Caja faltante...")
seguido de `git push --force origin master` — esto sí reescribe el
historial público, usarlo solo si nadie más bajó estos commits todavía.

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
