# Guía de trabajo para Claude

## Regla principal (pedido explícito del dueño)

El proyecto va creciendo en complejidad y en líneas. **Todo tiene que quedar
aislado y encapsulado**, de modo que una modificación no rompa otra parte del
programa. Más adelante se va a segmentar y optimizar; el trabajo de hoy tiene
que dejar el terreno preparado para eso.

En concreto, antes de escribir código:

1. **Un dato, un solo lugar que lo calcula.** Si vas a repetir un cálculo o un
   template que ya existe en otra función, extraelo a una función compartida
   *primero* y usala en los dos lados. Nunca copiar y pegar lógica.
2. **Cambio local, efecto local.** Tocar una pantalla no puede obligar a tocar
   otras tres. Si te pasa eso, falta una abstracción: hacela.
3. **Nada de condiciones sueltas.** Las variantes de comportamiento se
   preguntan a una función (`negocioTieneCajaLocal(id)`, `esSocio()`), no
   comparando strings desparramados por el código.
4. **Comentar el porqué, no el qué.** Este código ya tiene la convención de
   explicar las decisiones no obvias y las trampas. Mantenerla: es lo que hace
   que un cambio futuro no rompa algo por desconocimiento.

## Qué es el proyecto

PWA en JavaScript vanilla (sin build, sin npm, sin frameworks) para que 3
socios lleven los gastos de dos negocios: **Pancho Recreo** 🌭 y **Heladería
Pablo** 🍦. Firebase (Firestore + Auth anónima + Storage) cargado por CDN.

**El detalle del dominio está en [README.md](README.md)** — modelo de datos,
reglas de negocio, permisos, flujo de arranque. No dupliques eso acá; si
cambiás una regla de negocio, actualizá el README.

## Cómo trabajar en este repo

- **Idioma: español.** UI, comentarios del código, mensajes de commit y
  respuestas al usuario. El usuario no es programador: explicá los cambios en
  términos del negocio, no de la implementación.
- **No hay build ni tests.** Se sirven los archivos tal cual.
- **Verificación mínima antes de dar algo por terminado:**
  - `node --check app.js` (sintaxis).
  - Chequear que los IDs nuevos del HTML existan y que el JS los referencie
    igual (un typo acá no falla ruidosamente, solo deja de funcionar).
  - **Probarlo de verdad en el navegador.** Servir con
    `python3 -m http.server 5177` y sacar screenshots con Playwright (está
    global: `require('/opt/node22/lib/node_modules/playwright')`). Como las
    funciones son de módulo y no están en `window`, y no hay Firebase real en
    el sandbox, la técnica es simular el estado desde `page.evaluate()`:
    activar la pantalla, sacarle `hidden` a lo que corresponda e inyectar
    filas de ejemplo. Verificar **tema claro y oscuro** (`colorScheme`).
- **Git:** desarrollar en la rama asignada y después mergear a `master`.
  `master` es lo que Netlify publica, así que un cambio no llega a los
  celulares hasta que esté ahí.

## Puntos únicos de verdad ya establecidos (no los eludas)

| Función | Es el único lugar donde... |
|---|---|
| `aplicarConfigSocios(data)` | se vuelca el doc `config/socios` a las globales |
| `cajaLocalCalculo()` | se calcula repuesto / gastado / queda de la caja |
| `crearFilaGasto(g)` | se arma el `<li>` de un gasto (lista y detalle de caja) |
| `negociosPermitidos(nombre)` | se decide qué negocios ve una persona |
| `esSocio()` / `aplicarPermisosDeVista()` | se decide qué ve un colaborador |
| `negocioTieneCajaLocal(id)` | se pregunta si un negocio tiene caja del local |
| `escapeHtml(str)` | pasa todo texto de Firestore antes de ir a `innerHTML` |
| `fechaLocalISO(date)` | se arma una fecha `AAAA-MM-DD` local |

Si agregás algo que necesita uno de esos datos, **usá la función existente**.
Si agregás un campo nuevo a `config/socios`, alcanza con tocar
`aplicarConfigSocios()`.

## Trampas conocidas (no las rompas sin entenderlas)

- **`switchTab()` limita su selector a `#screen-app` a propósito.** Otras
  pantallas usan la clase `.tab` solo para heredar estilos; un `$$(".tab")`
  global las deja en blanco.
- **`fechaLocalISO()` existe porque `toISOString()` da UTC.** De noche en
  Argentina eso adelanta un día y los gastos caen en el mes equivocado.
- **La caja del local se maneja solo con la colección `reposiciones`.** El
  campo viejo `cajaLocalMonto` quedó obsoleto: `migrarMontoInicialCaja()` lo
  pasa a una reposición con `esInicial: true` y lo deja en cero. Se sigue
  sumando en `cajaLocalCalculo()` solo como red de seguridad hasta que la
  migración corra. **No lo vuelvas a hacer editable**: tener dos lugares
  para cargar lo mismo ya causó un bug real (el aviso de saldo negativo de
  `saveGasto()` ignoraba las reposiciones).
- **Aviso "Caja faltante":** turno del día 1 → recién avisa a las 5hs del día
  2. Se calcula sobre *ayer*, y a propósito **no** reutiliza
  `fechaSugeridaCierre()` (esa devuelve *hoy* pasado el mediodía).
- **Kiara está hardcodeada por nombre** (`usuarioActual === "Kiara"`) para
  forzarle forma de pago "caja". Es deuda técnica conocida, ver abajo.
- **Los PIN y los permisos son solo interfaz, no seguridad.** Cualquiera con
  la `firebaseConfig` lee y escribe todo directo en Firestore. No le prometas
  al usuario que esto protege datos.
- **Cada cambio en Firestore redibuja TODAS las pantallas, no solo la que se
  está mirando** (ver los `listen*()` llamados desde `bootApp()`). Es a
  propósito: así cualquier pantalla que se abra después ya está al día, sin
  tener que acordarse de refrescarla al entrar. Se evaluó cambiarlo (solo
  redibujar la pantalla visible, o pasar a `docChanges()` para actualizar
  fila por fila) y se decidió que no vale el riesgo: al volumen real de este
  negocio (pocos movimientos por día) el redibujado completo tarda
  milisegundos. Si el día de mañana el volumen crece mucho, ahí sí conviene
  revisar esto — mientras tanto, no lo "optimices" sin que alguien lo pida.

## Deuda técnica y rumbo

- **`app.js` tiene ~3.100 líneas en un solo archivo.** La segmentación está
  planeada (pedido del dueño). Cortes naturales cuando llegue el momento:
  capa de datos/Firebase, utilidades, render por pantalla, modales. Mientras
  tanto, **agrupá lo nuevo por sección con su comentario de encabezado**, para
  que el día que se parta el archivo los límites ya estén dibujados.
- **Kiara por nombre exacto** debería ser una marca por persona (ej.
  `pagaConCajaLocal: ["Kiara"]` en `config/socios`), para no tener que tocar
  código cuando cambie el personal.
- **Sin tests.** Para lógica pura (fechas, cálculos, permisos) sirve replicar
  la función en un `node -e` y verificar los casos borde antes de dar por
  buena una regla; se hizo así con el aviso de "Caja faltante" y con el
  cálculo de la caja.
