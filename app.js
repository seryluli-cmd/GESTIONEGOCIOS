// ============================================================
// Gastos del Negocio — lógica de la app (PWA + Firebase)
// ============================================================

// El SDK de Firebase se importa de forma DINÁMICA (recién cuando hace
// falta conectar) para que la app nunca quede colgada en "Cargando…"
// si la red está lenta o falla al abrir la app.
const FB_VERSION = "10.12.2";
let fbSdk = null; // { initializeApp, getAuth, signInAnonymously, onAuthStateChanged, getFirestore, ... }

async function loadFirebaseSdk() {
  if (fbSdk) return fbSdk;
  let appMod, authMod, fsMod, stMod;
  try {
    [appMod, authMod, fsMod, stMod] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-firestore.js`),
      import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-storage.js`)
    ]);
  } catch (e) {
    console.error("Error cargando SDK de Firebase:", e);
    throw new Error("No se pudo conectar a internet para cargar Firebase. Revisá tu conexión e intentá de nuevo.");
  }
  fbSdk = {
    initializeApp: appMod.initializeApp,
    getApps: appMod.getApps,
    deleteApp: appMod.deleteApp,
    getAuth: authMod.getAuth,
    signInAnonymously: authMod.signInAnonymously,
    onAuthStateChanged: authMod.onAuthStateChanged,
    getFirestore: fsMod.getFirestore,
    collection: fsMod.collection,
    addDoc: fsMod.addDoc,
    deleteDoc: fsMod.deleteDoc,
    onSnapshot: fsMod.onSnapshot,
    query: fsMod.query,
    orderBy: fsMod.orderBy,
    doc: fsMod.doc,
    getDoc: fsMod.getDoc,
    setDoc: fsMod.setDoc,
    updateDoc: fsMod.updateDoc,
    deleteField: fsMod.deleteField,
    arrayUnion: fsMod.arrayUnion,
    arrayRemove: fsMod.arrayRemove,
    serverTimestamp: fsMod.serverTimestamp,
    enableIndexedDbPersistence: fsMod.enableIndexedDbPersistence,
    getStorage: stMod.getStorage,
    ref: stMod.ref,
    uploadBytes: stMod.uploadBytes,
    getDownloadURL: stMod.getDownloadURL,
    deleteObject: stMod.deleteObject
  };
  return fbSdk;
}

// ---------- Estado ----------
const LS_CONFIG_KEY = "gn_firebaseConfig";
const LS_SOCIOS_CACHE = "gn_socios_cache";
const LS_COLAB_CACHE = "gn_colaboradores_cache";
const LS_USER_KEY = "gn_current_user"; // quién está identificado en este celular
const SERIES_VARS = ["--series-1", "--series-2", "--series-3"];
const NEUTRAL_VAR = "var(--text-muted)";

// Los 2 negocios. Cada gasto queda etiquetado con uno de estos "id",
// y tanto la lista de gastos como el balance se calculan por separado
// para cada negocio (mismos 3 socios, cuentas independientes).
const NEGOCIOS = [
  { id: "pancho", nombre: "Pancho Recreo", emoji: "🌭", color: "var(--biz-pancho)" },
  { id: "heladeria", nombre: "Heladería Pablo", emoji: "🍦", color: "var(--biz-heladeria)" }
];

// Categorías de gastos: distintas por negocio, porque Pancho Recreo y
// Heladería Pablo venden cosas totalmente distintas. El <select> de
// categoría del modal "Nuevo gasto" (index.html) trae por defecto las
// de Pancho, cargadas en el HTML — renderCategoriaOptions() las
// reemplaza dinámicamente por las que correspondan según negocioActual
// cada vez que se abre el modal (ver openModal()).
const CATEGORIAS_GASTO = {
  pancho: ["Insumos", "Alquiler", "Servicios", "Sueldos", "Marketing", "Impuestos", "Otros"],
  heladeria: ["Helado", "Tortas de repostería", "Café", "Medialunas", "Fiambres",
              "Art Limpieza", "Gastos Fijos", "Gastos varios"],
};

// Reparto de gastos entre los 3 socios: NO es igualitario (1/3 cada uno)
// — cada uno "debería" poner este % del total de lo gastado, según lo
// acordado entre ellos. Si el nombre de algún socio en Firestore no
// coincide exactamente con los de acá (typo, socio nuevo, etc.),
// renderBalance() se cae a reparto igualitario como antes, en vez de
// calcular un porcentaje a medias con el resto sin cubrir.
const PORCENTAJE_SOCIO = {
  "Sergio": 0.10,
  "Pola": 0.10,
  "Leonel": 0.80,
};

let fbApp = null, auth = null, db = null, storage = null;
let selectedFotoBlob = null; // foto comprimida, lista para subir (modal Nuevo gasto)
const FOTO_RETENCION_DIAS = 120; // ~4 meses — pasado esto, se borra sola la foto (no el gasto)
let fotosLimpiezaHecha = false;
let socios = [];           // ["Sergio", "Ana", "Marcos"] — los 3 socios, entran en el reparto
let colaboradores = [];    // ["Encargada"] — pueden pagar/cargar, NO entran en el reparto
let colaboradorNegocio = {}; // { "Encargada": "pancho" | "heladeria" } — si un colaborador no
                              // aparece acá, ve los 2 negocios (ver negociosPermitidos()). Los
                              // 3 socios siempre ven los 2, nunca están en este mapa.
let admins = [];           // subconjunto de nombres (normalmente socios) con permiso para editar/borrar
let pins = {};             // { "Sergio": "1234", ... } — PIN fijo de 4 dígitos por persona (ver README: no es seguridad real, solo identificación)
let claveMaestraAdmin = ""; // clave compartida entre los admins, solo para CREAR su PIN la primera vez
                             // en un celular nuevo (ver openPinModal/confirmPinModal) — evita que cualquiera
                             // tocando "Sergio" por primera vez se autoasigne el PIN de admin sin saberla.
                             // Si no está configurada (vacía), no se pide — no es seguridad real, ver README.
let gastos = [];           // TODOS los gastos, de los 2 negocios — [{id, importe, descripcion, categoria, pagadoPor, fecha, negocio}]
let facturaciones = [];    // TODOS los cierres diarios, de los 2 negocios — [{id, importe, registradoPor, fecha, negocio}]
let ideas = [];            // TODAS las ideas de mejora, de los 2 negocios — [{id, texto, estado, propuestoPor, negocio, creadoEn}], filtradas por ideasDelNegocio()
let negocioActual = null;  // "pancho" | "heladeria"
let seccionActual = null;  // "gastos" | "facturado" | "resumen"
let selectedPagador = null;
let selectedRegistrador = null;
let resumenMesOffset = 0;  // 0 = mes actual, -1 = mes anterior, etc. (Resumen mensual)
let pendingFirebaseConfig = null; // config guardada entre el paso 1 y 2 del setup inicial
let usuarioActual = null;  // nombre con el que se identificó este celular (ver resumeSession)
let esAdmin = false;       // usuarioActual ∈ admins
let editingGastoId = null;      // id del gasto que se está editando en el modal, o null si es uno nuevo
let editingCierreId = null;     // id del cierre que se está editando en el modal, o null si es uno nuevo
let pinFlowNombre = null;  // nombre para el que está abierto el modal de PIN
let pinFlowMode = null;    // "create" (todavía no tiene PIN) | "verify" (ya tiene uno)

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Utilidades ----------
function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
function mesLabel(date) {
  return `${MESES[date.getMonth()]} ${date.getFullYear()}`;
}
function fechaDeRegistro(item) {
  return item.fecha && item.fecha.toDate ? item.fecha.toDate() : new Date(item.fecha || Date.now());
}

// Fecha de un Date en formato "AAAA-MM-DD", en hora LOCAL — a propósito
// NO se usa .toISOString() para esto: esa función siempre da la fecha en
// UTC, así que de noche en Argentina (UTC-3), pasadas las ~21:00 ya es
// "mañana" en UTC — el campo de fecha quedaba pre-completado con el día
// (a veces hasta el mes) siguiente al real, y esos gastos/cierres
// terminaban sin sumar en el mes correcto en Gastos ni en Resumen mensual.
function fechaLocalISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Redimensiona y comprime la foto en el navegador antes de subirla, para que
// no pese varios MB (como sale de la cámara) sino unos cientos de KB.
function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error("No se pudo procesar la imagen."));
      }, "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen."));
    };
    img.src = url;
  });
}

function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

function showScreen(id) {
  $$(".screen").forEach(s => s.classList.remove("active"));
  $("#" + id).classList.add("active");
}

function parseFirebaseConfig(raw) {
  if (!raw || !raw.trim()) throw new Error("Pegá la configuración de Firebase.");
  let block = raw;
  const braceStart = raw.indexOf("{");
  const braceEnd = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
    block = raw.slice(braceStart, braceEnd + 1);
  }
  const config = {};
  const re = /["']?([A-Za-z0-9_]+)["']?\s*:\s*["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    config[m[1]] = m[2];
  }
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  const missing = required.filter(k => !config[k]);
  if (missing.length) {
    throw new Error("Faltan datos en la configuración: " + missing.join(", "));
  }
  return config;
}

function socioColorVar(index) {
  return `var(${SERIES_VARS[index % SERIES_VARS.length]})`;
}

// Color de identidad para cualquier "pagador": los 3 socios tienen su color
// categórico propio; cualquier otra persona (colaboradores) usa un color
// neutro, porque no participan del reparto y no deben leerse como una
// cuarta "serie" en el balance.
function payerColorVar(name) {
  const idx = socios.indexOf(name);
  return idx !== -1 ? socioColorVar(idx) : NEUTRAL_VAR;
}

function socioInitial(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

function allPagadores() {
  return socios.concat(colaboradores);
}

// ---------- Firebase init ----------
async function initFirebase(config) {
  const sdk = await loadFirebaseSdk();

  // Si un intento anterior (en esta misma carga de página) ya inicializó
  // Firebase y falló más adelante (ej. clave inválida), hay que limpiar
  // esa app antes de reintentar, o Firebase tira "app/duplicate-app".
  const existing = sdk.getApps();
  if (existing.length) {
    await Promise.all(existing.map(a => sdk.deleteApp(a).catch(() => {})));
  }

  fbApp = sdk.initializeApp(config);
  auth = sdk.getAuth(fbApp);
  db = sdk.getFirestore(fbApp);
  storage = sdk.getStorage(fbApp);
  try {
    await sdk.enableIndexedDbPersistence(db);
  } catch (e) {
    // persistence puede fallar en pestañas múltiples o navegadores viejos; no es crítico
    console.warn("Persistencia offline no disponible:", e.message);
  }
  await new Promise((resolve, reject) => {
    sdk.signInAnonymously(auth).catch(reject);
    sdk.onAuthStateChanged(auth, (user) => {
      if (user) resolve(user);
    });
  });
}

async function connectAndBoot(config, namesFromInput, colabFromInput) {
  await initFirebase(config);
  const sdk = fbSdk;

  const socioDocRef = sdk.doc(db, "config", "socios");
  const snap = await sdk.getDoc(socioDocRef);

  if (snap.exists() && Array.isArray(snap.data().socios) && snap.data().socios.length === 3) {
    const data = snap.data();
    socios = data.socios;
    colaboradores = Array.isArray(data.colaboradores) ? data.colaboradores : [];
    colaboradorNegocio = data.colaboradorNegocio && typeof data.colaboradorNegocio === "object" ? data.colaboradorNegocio : {};
    admins = Array.isArray(data.admins) ? data.admins : [];
    pins = data.pins && typeof data.pins === "object" ? data.pins : {};
    claveMaestraAdmin = typeof data.claveMaestraAdmin === "string" ? data.claveMaestraAdmin : "";
  } else {
    if (!namesFromInput || namesFromInput.some(n => !n.trim())) {
      throw new Error("Completá los nombres de los 3 socios.");
    }
    socios = namesFromInput.map(n => n.trim());
    colaboradores = (colabFromInput || []).map(n => n.trim()).filter(Boolean);
    colaboradorNegocio = {};
    admins = [];
    pins = {};
    claveMaestraAdmin = "llavez";
    await sdk.setDoc(socioDocRef, { socios, colaboradores, colaboradorNegocio, admins, pins, claveMaestraAdmin });
  }

  localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(config));
  localStorage.setItem(LS_SOCIOS_CACHE, JSON.stringify(socios));
  localStorage.setItem(LS_COLAB_CACHE, JSON.stringify(colaboradores));

  bootApp();
}

// ---------- Boot principal (ya configurado) ----------
function bootApp() {
  renderPagadorChips();
  renderPagadorChipsFacturado();
  renderAjustesSocios();
  renderNegocioCards();
  listenGastos();
  listenFacturacion();
  listenIdeas();
  listenSocios();
  listenConnectivity();
  setDefaultFecha();
  resumeSession();
}

// ---------- Identidad del celular (¿Quién sos? + PIN) ----------
// Se pregunta una sola vez por celular (como el resto de la config) y se
// recuerda en localStorage hasta que se use "Cambiar de usuario" en Ajustes.
// OJO: esto NO es una capa de seguridad real — cualquier dispositivo con la
// config de Firebase ya puede leer/escribir todo en Firestore. Sirve solo
// para identificar quién usa cada celular y mostrar los botones de admin.
function resumeSession() {
  const savedUser = localStorage.getItem(LS_USER_KEY);
  if (savedUser && allPagadores().includes(savedUser)) {
    setUsuarioActual(savedUser);
    irANegocioOSeleccion();
  } else {
    renderQuienSosCards();
    showScreen("screen-quien-sos");
  }
}

function setUsuarioActual(nombre) {
  usuarioActual = nombre;
  esAdmin = admins.includes(nombre);
  localStorage.setItem(LS_USER_KEY, nombre);
  renderAjustesSocios();
  renderNegocioCards();
  renderGastos();
  renderFacturado();
  renderIdeas();
}

// Negocios que puede ver una persona: los 3 socios siempre ven los 2
// (reparten gastos entre ambos negocios); un colaborador ve solo el que
// tiene asignado en colaboradorNegocio — si no tiene nada asignado
// todavía, también ve los 2 (para no dejarlo sin acceso por default).
function negociosPermitidos(nombre) {
  if (socios.includes(nombre)) return NEGOCIOS.map(b => b.id);
  const asignado = colaboradorNegocio[nombre];
  return NEGOCIOS.some(b => b.id === asignado) ? [asignado] : NEGOCIOS.map(b => b.id);
}

// Se llama después de identificarse (PIN nuevo, PIN verificado, o sesión
// recordada). Si la persona solo puede ver un negocio, se saltea
// directo la pantalla "¿Qué negocio querés ver?" y entra a ese — no
// tiene sentido mostrarle un selector con una sola opción.
function irANegocioOSeleccion() {
  const permitidos = negociosPermitidos(usuarioActual);
  if (permitidos.length === 1) {
    selectNegocio(permitidos[0]);
  } else {
    showScreen("screen-negocio");
  }
}

function cambiarUsuario() {
  localStorage.removeItem(LS_USER_KEY);
  usuarioActual = null;
  esAdmin = false;
  renderQuienSosCards();
  showScreen("screen-quien-sos");
}

function renderQuienSosCards() {
  const wrap = $("#quien-sos-cards");
  wrap.innerHTML = "";
  allPagadores().forEach((nombre) => {
    const card = document.createElement("div");
    card.className = "negocio-card";
    card.style.setProperty("--biz-color", payerColorVar(nombre));
    card.innerHTML = `
      <div class="negocio-emoji">${socioInitial(nombre)}</div>
      <div class="negocio-info">
        <div class="negocio-nombre">${escapeHtml(nombre)}</div>
      </div>
    `;
    card.addEventListener("click", () => openPinModal(nombre));
    wrap.appendChild(card);
  });
}

function openPinModal(nombre) {
  pinFlowNombre = nombre;
  pinFlowMode = pins[nombre] ? "verify" : "create";
  $("#pin-input-1").value = "";
  $("#pin-input-2").value = "";
  $("#pin-input-clave-maestra").value = "";
  $("#pin-error").classList.add("hidden");

  // La clave maestra solo se pide la primera vez que un ADMIN crea su
  // PIN en un celular nuevo — no a colaboradores, y no de nuevo una vez
  // que ya tiene PIN (ahí entra por "verify" con su PIN de siempre). Si
  // no hay clave maestra configurada, no se pide (ver claveMaestraAdmin).
  const requiereClaveMaestra = pinFlowMode === "create" && admins.includes(nombre) && !!claveMaestraAdmin;
  $("#pin-field-clave-maestra").classList.toggle("hidden", !requiereClaveMaestra);

  if (pinFlowMode === "create") {
    $("#pin-modal-title").textContent = `Creá tu PIN, ${nombre}`;
    $("#pin-modal-sub").textContent = "Elegí un PIN de 4 números para identificarte la próxima vez en este celular.";
    $("#pin-field-2").classList.remove("hidden");
  } else {
    $("#pin-modal-title").textContent = "Ingresá tu PIN";
    $("#pin-modal-sub").textContent = nombre;
    $("#pin-field-2").classList.add("hidden");
  }

  $("#modal-pin").classList.add("active");
  setTimeout(() => $(requiereClaveMaestra ? "#pin-input-clave-maestra" : "#pin-input-1").focus(), 150);
}

function closePinModal() {
  $("#modal-pin").classList.remove("active");
  pinFlowNombre = null;
}

async function confirmPinModal() {
  const errEl = $("#pin-error");
  const pin1 = $("#pin-input-1").value.trim();
  errEl.classList.add("hidden");

  if (!/^\d{4}$/.test(pin1)) {
    errEl.textContent = "El PIN debe tener 4 números.";
    errEl.classList.remove("hidden");
    return;
  }

  if (pinFlowMode === "verify") {
    if (pins[pinFlowNombre] !== pin1) {
      errEl.textContent = "PIN incorrecto.";
      errEl.classList.remove("hidden");
      return;
    }
    // Ojo: closePinModal() pone pinFlowNombre en null, por eso hay que
    // guardarlo en una variable local ANTES de llamarla (mismo motivo por
    // el que el branch "create" ya lo hacía con `const nombre`).
    const nombre = pinFlowNombre;
    closePinModal();
    setUsuarioActual(nombre);
    irANegocioOSeleccion();
    return;
  }

  // pinFlowMode === "create"
  const requiereClaveMaestra = admins.includes(pinFlowNombre) && !!claveMaestraAdmin;
  if (requiereClaveMaestra && $("#pin-input-clave-maestra").value !== claveMaestraAdmin) {
    errEl.textContent = "Clave maestra incorrecta. Pedísela a otro admin.";
    errEl.classList.remove("hidden");
    return;
  }

  const pin2 = $("#pin-input-2").value.trim();
  if (pin1 !== pin2) {
    errEl.textContent = "Los PIN no coinciden.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#btn-pin-confirm");
  btn.disabled = true;
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "config", "socios"), {
      [`pins.${pinFlowNombre}`]: pin1
    });
    pins[pinFlowNombre] = pin1;
    const nombre = pinFlowNombre;
    closePinModal();
    setUsuarioActual(nombre);
    irANegocioOSeleccion();
  } catch (e) {
    console.error(e);
    errEl.textContent = "No se pudo guardar el PIN. Revisá tu conexión.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

// ---------- Selector de negocio ----------
function renderNegocioCards() {
  const wrap = $("#negocio-cards");
  wrap.innerHTML = "";
  // Antes de identificarse todavía no hay a quién filtrarle la lista —
  // se muestran los 2 (este primer render se pisa apenas alguien se
  // identifica, ver setUsuarioActual()).
  const permitidos = usuarioActual ? negociosPermitidos(usuarioActual) : NEGOCIOS.map(b => b.id);
  NEGOCIOS.filter(biz => permitidos.includes(biz.id)).forEach(biz => {
    const card = document.createElement("div");
    card.className = "negocio-card";
    card.style.setProperty("--biz-color", biz.color);
    card.innerHTML = `
      <div class="negocio-emoji">${biz.emoji}</div>
      <div class="negocio-info">
        <div class="negocio-nombre">${escapeHtml(biz.nombre)}</div>
        <div class="negocio-sub">Ver gastos y facturado</div>
      </div>
    `;
    card.addEventListener("click", () => selectNegocio(biz.id));
    wrap.appendChild(card);
  });
}

function selectNegocio(id) {
  const biz = NEGOCIOS.find(n => n.id === id);
  if (!biz) return;
  negocioActual = id;

  // Pantalla "app" (Gastos/Balance/Ajustes) — badge del topbar
  $("#negocio-titulo").textContent = biz.nombre;
  $("#negocio-icon-badge").textContent = biz.emoji;
  $("#negocio-icon-badge").style.background = biz.color;

  // Pantalla "Facturado" — badge del topbar
  $("#facturado-titulo").textContent = biz.nombre + " — Facturado";
  $("#facturado-icon-badge").textContent = biz.emoji;
  $("#facturado-icon-badge").style.background = biz.color;

  // Pantalla "Resumen mensual" — badge del topbar
  $("#resumen-titulo").textContent = biz.nombre + " — Resumen";
  $("#resumen-icon-badge").textContent = biz.emoji;
  $("#resumen-icon-badge").style.background = biz.color;

  // Ajustes → tarjeta "Exportar datos"
  $("#export-negocio-nombre").textContent = biz.nombre;

  renderSeccionCards(biz);
  showScreen("screen-seccion");
}

// ---------- Selector de sección (Gastos / Facturado) ----------
function renderSeccionCards(biz) {
  $("#seccion-negocio-nombre").textContent = biz.nombre;
  $("#seccion-icon-badge").textContent = biz.emoji;
  $("#seccion-icon-badge").style.background = biz.color;
  // Si la persona solo puede ver este negocio, "← Cambiar negocio" no
  // tiene a dónde llevarla — se oculta en vez de mostrar un selector
  // con una sola opción sin sentido.
  $("#btn-back-to-negocio").classList.toggle("hidden", negociosPermitidos(usuarioActual).length <= 1);

  const SECCIONES = [
    { id: "gastos", emoji: "🧾", nombre: "Gastos", sub: "Cargar gastos y ver el balance entre socios" },
    { id: "facturado", emoji: "💰", nombre: "Facturado", sub: "Anotar lo que se facturó cada día" },
    { id: "resumen", emoji: "📊", nombre: "Resumen mensual", sub: "Ver los totales de cada mes" },
    { id: "ideas", emoji: "💡", nombre: "Ideas/Metas", sub: "Para mejorar este negocio" }
  ];

  const wrap = $("#seccion-cards");
  wrap.innerHTML = "";
  SECCIONES.forEach(s => {
    const card = document.createElement("div");
    card.className = "negocio-card";
    card.style.setProperty("--biz-color", biz.color);
    card.innerHTML = `
      <div class="negocio-emoji">${s.emoji}</div>
      <div class="negocio-info">
        <div class="negocio-nombre">${s.nombre}</div>
        <div class="negocio-sub">${s.sub}</div>
      </div>
    `;
    card.addEventListener("click", () => selectSeccion(s.id));
    wrap.appendChild(card);
  });
}

function selectSeccion(id) {
  seccionActual = id;
  if (id === "gastos") {
    switchTab("gastos");
    renderGastos();
    renderBalance();
    showScreen("screen-app");
  } else if (id === "facturado") {
    renderFacturado();
    showScreen("screen-facturado");
  } else if (id === "resumen") {
    resumenMesOffset = 0;
    renderResumen();
    showScreen("screen-resumen");
  } else if (id === "ideas") {
    renderIdeas();
    showScreen("screen-ideas");
  }
}

function volverASeccion() {
  const biz = NEGOCIOS.find(n => n.id === negocioActual);
  if (biz) renderSeccionCards(biz);
  showScreen("screen-seccion");
}

// Gastos del negocio actualmente seleccionado (de la lista completa que
// ya sincronizamos con Firestore).
function gastosDelNegocio() {
  return gastos.filter(g => g.negocio === negocioActual);
}

// Cierres de facturación del negocio actualmente seleccionado.
function facturacionesDelNegocio() {
  return facturaciones.filter(f => f.negocio === negocioActual);
}

// Ideas/Metas del negocio actualmente seleccionado. Antes eran
// compartidas entre los 2 negocios (sin campo "negocio"); ahora cada
// negocio tiene las suyas, igual que gastos y facturación. Las ideas
// viejas, creadas antes de este cambio, no tienen "negocio" guardado —
// se siguen mostrando en los dos negocios (en vez de desaparecer) hasta
// que alguien las recargue como nuevas, ya con negocio asignado.
function ideasDelNegocio() {
  return ideas.filter(i => i.negocio === negocioActual || !i.negocio);
}

function listenSocios() {
  const socioDocRef = fbSdk.doc(db, "config", "socios");
  fbSdk.onSnapshot(socioDocRef, (snap) => {
    if (snap.exists() && Array.isArray(snap.data().socios)) {
      const data = snap.data();
      socios = data.socios;
      colaboradores = Array.isArray(data.colaboradores) ? data.colaboradores : [];
      colaboradorNegocio = data.colaboradorNegocio && typeof data.colaboradorNegocio === "object" ? data.colaboradorNegocio : {};
      admins = Array.isArray(data.admins) ? data.admins : [];
      pins = data.pins && typeof data.pins === "object" ? data.pins : {};
      claveMaestraAdmin = typeof data.claveMaestraAdmin === "string" ? data.claveMaestraAdmin : "";
      localStorage.setItem(LS_SOCIOS_CACHE, JSON.stringify(socios));
      localStorage.setItem(LS_COLAB_CACHE, JSON.stringify(colaboradores));
      esAdmin = usuarioActual ? admins.includes(usuarioActual) : false;
      renderPagadorChips();
      renderPagadorChipsFacturado();
      renderAjustesSocios();
      renderNegocioCards();
      renderBalance();
      renderGastos();
      renderFacturado();
      renderIdeas();
    }
  });
}

function listenGastos() {
  const q = fbSdk.query(fbSdk.collection(db, "gastos"), fbSdk.orderBy("fecha", "desc"));
  fbSdk.onSnapshot(q, (snapshot) => {
    gastos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderGastos();
    renderBalance();
    if (negocioActual) renderResumen();
    setSyncOffline(false);
    if (!fotosLimpiezaHecha) {
      fotosLimpiezaHecha = true;
      limpiarFotosVencidas();
    }
  }, (err) => {
    console.error(err);
    setSyncOffline(true);
  });
}

function listenFacturacion() {
  const q = fbSdk.query(fbSdk.collection(db, "facturacion"), fbSdk.orderBy("fecha", "desc"));
  fbSdk.onSnapshot(q, (snapshot) => {
    facturaciones = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFacturado();
    if (negocioActual) renderResumen();
    setSyncOffline(false);
  }, (err) => {
    console.error(err);
    setSyncOffline(true);
  });
}

// Compartidas entre los 2 negocios a propósito — no se filtran por "negocio".
function listenIdeas() {
  const q = fbSdk.query(fbSdk.collection(db, "ideas"), fbSdk.orderBy("creadoEn", "desc"));
  fbSdk.onSnapshot(q, (snapshot) => {
    ideas = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderIdeas();
    setSyncOffline(false);
  }, (err) => {
    console.error(err);
    setSyncOffline(true);
  });
}

function setSyncOffline(isOffline) {
  $$(".sync-dot").forEach(d => d.classList.toggle("offline", isOffline));
}

function listenConnectivity() {
  const update = () => setSyncOffline(!navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ---------- Render: Gastos ----------
function renderGastos() {
  const list = $("#expenses-list");
  const empty = $("#expenses-empty");
  list.innerHTML = "";

  const gastosNegocio = gastosDelNegocio();

  if (!gastosNegocio.length) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }

  const now = new Date();
  let totalMes = 0;

  gastosNegocio.forEach(g => {
    const fecha = g.fecha && g.fecha.toDate ? g.fecha.toDate() : new Date(g.fecha || Date.now());
    if (fecha.getMonth() === now.getMonth() && fecha.getFullYear() === now.getFullYear()) {
      totalMes += Number(g.importe) || 0;
    }

    const fotoBtn = g.fotoUrl
      ? `<button type="button" class="foto-link" data-url="${escapeHtml(g.fotoUrl)}" aria-label="Ver foto de la factura">📷</button>`
      : "";

    // Editar/borrar solo para el admin — el resto solo puede cargar y ver.
    const adminBtns = esAdmin
      ? `<button type="button" class="icon-btn gasto-edit-btn" data-id="${g.id}" aria-label="Editar gasto">✏️</button>
         <button type="button" class="icon-btn danger gasto-delete-btn" data-id="${g.id}" aria-label="Borrar gasto">🗑️</button>`
      : "";

    // Falta abonar: se tildó porque todavía no se le pagó a quien
    // trajo la mercadería (ej. te dejan pagar unos días después) — la
    // fila queda en rojo hasta que se destilde desde "Editar".
    const metaFaltaAbonar = g.faltaAbonar ? ` · <span class="meta-falta-abonar">⚠️ Falta abonar</span>` : "";

    const li = document.createElement("li");
    li.className = "expense-item" + (g.faltaAbonar ? " falta-abonar" : "");
    li.innerHTML = `
      <div class="avatar" style="background:${payerColorVar(g.pagadoPor)}">${socioInitial(g.pagadoPor)}</div>
      <div class="info">
        <div class="desc">${escapeHtml(g.descripcion || "Sin descripción")}</div>
        <div class="meta">${fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} · ${escapeHtml(g.categoria || "Otros")} · Pagó ${escapeHtml(g.pagadoPor || "?")}${metaFaltaAbonar}</div>
      </div>
      <div class="amount">${money(g.importe)}</div>
      ${fotoBtn}
      ${adminBtns}
    `;
    list.appendChild(li);
  });

  $("#total-mes").textContent = money(totalMes);
}

// Todo texto que viene de Firestore (descripción, nombres) pasa por acá antes
// de insertarse con innerHTML, para evitar XSS. Cualquier campo de texto
// nuevo que se agregue a un template debe escaparse igual.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---------- Render: Facturado ----------
function renderFacturado() {
  const list = $("#facturado-list");
  const empty = $("#facturado-empty");
  list.innerHTML = "";

  const items = facturacionesDelNegocio();

  if (!items.length) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }

  const now = new Date();
  let totalMes = 0;

  items.forEach(f => {
    const fecha = f.fecha && f.fecha.toDate ? f.fecha.toDate() : new Date(f.fecha || Date.now());
    if (fecha.getMonth() === now.getMonth() && fecha.getFullYear() === now.getFullYear()) {
      totalMes += Number(f.importe) || 0;
    }

    const adminBtns = esAdmin
      ? `<button type="button" class="icon-btn cierre-edit-btn" data-id="${f.id}" aria-label="Editar cierre">✏️</button>
         <button type="button" class="icon-btn danger cierre-delete-btn" data-id="${f.id}" aria-label="Borrar cierre">🗑️</button>`
      : "";

    const li = document.createElement("li");
    li.className = "expense-item";
    li.innerHTML = `
      <div class="avatar" style="background:${payerColorVar(f.registradoPor)}">${socioInitial(f.registradoPor)}</div>
      <div class="info">
        <div class="desc">${fecha.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "short" })}</div>
        <div class="meta">Cargado por ${escapeHtml(f.registradoPor || "?")}</div>
      </div>
      <div class="amount">${money(f.importe)}</div>
      ${adminBtns}
    `;
    list.appendChild(li);
  });

  $("#facturado-total-mes").textContent = money(totalMes);
}

// ---------- Render: Ideas (checklist compartido) ----------
function renderIdeas() {
  const ideasNegocio = ideasDelNegocio();
  const total = ideasNegocio.length;
  const concretadas = ideasNegocio.filter(i => i.estado === "concretada");
  // Pendientes ordenadas por votos — así se ve de un vistazo qué le
  // interesa más al equipo, sin que nadie tenga que decidir solo.
  const pendientes = ideasNegocio
    .filter(i => i.estado !== "concretada")
    .slice()
    .sort((a, b) => votosDe(b).length - votosDe(a).length);

  $("#ideas-empty").classList.toggle("hidden", total > 0);

  $("#ideas-progreso-valor").textContent = `${concretadas.length} de ${total}`;
  const pct = total ? Math.round((concretadas.length / total) * 100) : 0;
  $("#ideas-progreso-bar").style.width = pct + "%";

  $("#ideas-pendientes-empty").classList.toggle("hidden", pendientes.length > 0 || total === 0);
  $("#ideas-concretadas-wrap").classList.toggle("hidden", concretadas.length === 0);

  const pendientesEl = $("#ideas-pendientes-list");
  pendientesEl.innerHTML = "";
  pendientes.forEach(i => pendientesEl.appendChild(ideaCard(i)));

  const concretadasEl = $("#ideas-concretadas-list");
  concretadasEl.innerHTML = "";
  concretadas.forEach(i => concretadasEl.appendChild(ideaCard(i)));
}

function votosDe(idea) {
  return Array.isArray(idea.votos) ? idea.votos : [];
}

function ideaCard(idea) {
  const done = idea.estado === "concretada";
  const fecha = fechaDeRegistro(idea);
  const votos = votosDe(idea);
  const voteado = usuarioActual && votos.includes(usuarioActual);
  const card = document.createElement("div");
  card.className = "idea-card";
  card.dataset.id = idea.id;
  const deleteBtn = esAdmin
    ? `<button type="button" class="icon-btn danger idea-delete-btn" data-id="${idea.id}" aria-label="Borrar idea">🗑️</button>`
    : "";
  card.innerHTML = `
    <div class="idea-check ${done ? "checked" : ""}">${done ? "✓" : ""}</div>
    <div class="idea-info">
      <div class="idea-texto ${done ? "done" : ""}">${escapeHtml(idea.texto)}</div>
      <div class="idea-meta">Propuesto por ${escapeHtml(idea.propuestoPor || "?")} · ${fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}</div>
    </div>
    <button type="button" class="idea-vote-btn ${voteado ? "voted" : ""}" data-id="${idea.id}" aria-label="Me interesa esta idea">🔥 ${votos.length}</button>
    ${deleteBtn}
  `;
  return card;
}

// Cualquiera puede votar/desvotar una idea pendiente (no admin) — así se ve
// qué le importa más al equipo sin que nadie tenga que decidir por otro.
async function toggleVoto(id) {
  const idea = ideas.find(i => i.id === id);
  if (!idea || !usuarioActual) return;
  const yaVoto = votosDe(idea).includes(usuarioActual);
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "ideas", id), {
      votos: yaVoto ? fbSdk.arrayRemove(usuarioActual) : fbSdk.arrayUnion(usuarioActual)
    });
  } catch (e) {
    console.error(e);
    showToast("No se pudo actualizar. Revisá tu conexión.");
  }
}

// Cualquiera puede marcar/desmarcar una idea como concretada — sin admin,
// para que sea tan liviano como tildar un check en una lista de tareas.
async function toggleIdeaEstado(id) {
  const idea = ideas.find(i => i.id === id);
  if (!idea) return;
  const nuevoEstado = idea.estado === "concretada" ? "pendiente" : "concretada";
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "ideas", id), { estado: nuevoEstado });
  } catch (e) {
    console.error(e);
    showToast("No se pudo actualizar. Revisá tu conexión.");
  }
}

// Solo admin (esAdmin) — ver botón 🗑️ en ideaCard().
async function deleteIdea(id) {
  if (!confirm("¿Borrar esta idea?")) return;
  try {
    await fbSdk.deleteDoc(fbSdk.doc(db, "ideas", id));
    showToast("Idea borrada");
  } catch (e) {
    console.error(e);
    showToast("No se pudo borrar. Revisá tu conexión.");
  }
}

function openModalIdea() {
  $("#input-idea-texto").value = "";
  $("#modal-idea-error").classList.add("hidden");
  $("#modal-add-idea").classList.add("active");
  setTimeout(() => $("#input-idea-texto").focus(), 150);
}

function closeModalIdea() {
  $("#modal-add-idea").classList.remove("active");
}

async function saveIdea() {
  const texto = $("#input-idea-texto").value.trim();
  const errEl = $("#modal-idea-error");
  if (!texto) {
    errEl.textContent = "Escribí la idea antes de guardar.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#btn-save-idea");
  btn.disabled = true;
  btn.textContent = "Guardando…";
  try {
    await fbSdk.addDoc(fbSdk.collection(db, "ideas"), {
      texto,
      estado: "pendiente",
      votos: [],
      propuestoPor: usuarioActual,
      negocio: negocioActual,
      creadoEn: fbSdk.serverTimestamp()
    });
    closeModalIdea();
    showToast("Idea guardada ✅");
  } catch (e) {
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar idea";
  }
}

// ---------- Render: Resumen mensual ----------
// Muestra, para el mes elegido (navegable con ‹ ›), el total de Facturado
// y el total de Gastos por separado — sin restar uno del otro. No borra ni
// mueve ningún dato: es solo una vista calculada sobre lo que ya está
// guardado en Firestore.
function resumenFechaBase() {
  const d = new Date();
  d.setDate(1); // evita saltos raros de mes al sumar/restar meses
  d.setMonth(d.getMonth() + resumenMesOffset);
  return d;
}

function renderResumen() {
  const base = resumenFechaBase();
  const targetMonth = base.getMonth();
  const targetYear = base.getFullYear();

  $("#resumen-mes-label").textContent = mesLabel(base);

  const now = new Date();
  const esMesActual = targetMonth === now.getMonth() && targetYear === now.getFullYear();
  $("#btn-mes-siguiente").disabled = esMesActual;

  const gastosMes = gastosDelNegocio().filter(g => {
    const f = fechaDeRegistro(g);
    return f.getMonth() === targetMonth && f.getFullYear() === targetYear;
  });
  const factMes = facturacionesDelNegocio().filter(f => {
    const d = fechaDeRegistro(f);
    return d.getMonth() === targetMonth && d.getFullYear() === targetYear;
  });

  const totalGastos = gastosMes.reduce((sum, g) => sum + (Number(g.importe) || 0), 0);
  const totalFact = factMes.reduce((sum, f) => sum + (Number(f.importe) || 0), 0);
  // Cierres cargados ANTES del desglose Efectivo/Digital no tienen esos
  // campos — no suman acá (por eso Efectivo+Digital puede no coincidir
  // exactamente con el Total Facturado en meses con cierres viejos).
  const totalEfectivo = factMes.reduce((sum, f) => sum + (Number(f.efectivo) || 0), 0);
  const totalDigital = factMes.reduce((sum, f) => sum + (Number(f.digital) || 0), 0);

  $("#resumen-total-facturado").textContent = money(totalFact);
  $("#resumen-cant-facturado").textContent = factMes.length === 1 ? "1 cierre cargado" : `${factMes.length} cierres cargados`;
  $("#resumen-total-efectivo").textContent = money(totalEfectivo);
  $("#resumen-total-digital").textContent = money(totalDigital);
  const maxEfectDigital = Math.max(1, totalEfectivo, totalDigital);
  $("#resumen-bar-efectivo").style.width = Math.round((totalEfectivo / maxEfectDigital) * 100) + "%";
  $("#resumen-bar-digital").style.width = Math.round((totalDigital / maxEfectDigital) * 100) + "%";
  $("#resumen-total-gastos").textContent = money(totalGastos);
  $("#resumen-cant-gastos").textContent = gastosMes.length === 1 ? "1 gasto cargado" : `${gastosMes.length} gastos cargados`;

  const porCategoria = {};
  gastosMes.forEach(g => {
    const cat = g.categoria || "Otros";
    porCategoria[cat] = (porCategoria[cat] || 0) + (Number(g.importe) || 0);
  });
  const categorias = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]);

  const wrap = $("#resumen-categorias");
  const emptyEl = $("#resumen-categorias-empty");
  wrap.innerHTML = "";
  if (!categorias.length) {
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    const maxVal = Math.max(1, ...categorias.map(c => c[1]));
    categorias.forEach(([cat, val]) => {
      const pct = Math.round((val / maxVal) * 100);
      const card = document.createElement("div");
      card.className = "socio-total-card";
      card.innerHTML = `
        <div class="socio-total-row">
          <div class="socio-total-name">${escapeHtml(cat)}</div>
          <div class="socio-total-amount">${money(val)}</div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--text-muted)"></div></div>
      `;
      wrap.appendChild(card);
    });
  }
}

// ---------- Fotos de facturas: limpieza automática y pantalla de descarga ----------
// Se ejecuta una vez por apertura de la app (ver listenGastos). Borra del
// Storage y del gasto la foto de cualquier gasto con más de 4 meses — el
// gasto en sí (importe, descripción, etc.) NUNCA se toca ni se borra.
async function limpiarFotosVencidas() {
  const limite = Date.now() - FOTO_RETENCION_DIAS * 24 * 60 * 60 * 1000;
  const vencidos = gastos.filter(g => g.fotoPath && fechaDeRegistro(g).getTime() < limite);

  for (const g of vencidos) {
    try {
      await fbSdk.deleteObject(fbSdk.ref(storage, g.fotoPath));
    } catch (e) {
      console.warn("No se pudo borrar la foto vencida (puede que ya no exista):", e.message);
    }
    try {
      await fbSdk.updateDoc(fbSdk.doc(db, "gastos", g.id), {
        fotoUrl: fbSdk.deleteField(),
        fotoPath: fbSdk.deleteField()
      });
    } catch (e) {
      console.warn("No se pudo limpiar la referencia de la foto:", e.message);
    }
  }
}

// Pantalla "Fotos guardadas": agrupa por mes todos los gastos del negocio
// actual que todavía tienen una foto (los que ya se limpiaron por vencidos
// simplemente no aparecen más, sin necesidad de filtrar por fecha acá).
function renderFotosGuardadas() {
  const conFoto = gastosDelNegocio()
    .filter(g => g.fotoUrl)
    .sort((a, b) => fechaDeRegistro(b) - fechaDeRegistro(a));

  const empty = $("#fotos-empty");
  const wrap = $("#fotos-grupos");
  wrap.innerHTML = "";

  if (!conFoto.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const grupos = new Map(); // "2026-8" -> { label, items: [] }
  conFoto.forEach(g => {
    const f = fechaDeRegistro(g);
    const key = `${f.getFullYear()}-${f.getMonth()}`;
    if (!grupos.has(key)) grupos.set(key, { label: mesLabel(f), items: [] });
    grupos.get(key).items.push(g);
  });

  grupos.forEach(grupo => {
    const section = document.createElement("div");
    section.className = "fotos-grupo";
    const grid = grupo.items.map(g => `
      <a class="foto-thumb-link" href="${escapeHtml(g.fotoUrl)}" target="_blank" rel="noopener" aria-label="Ver foto: ${escapeHtml(g.descripcion || "")}">
        <img class="foto-thumb" src="${escapeHtml(g.fotoUrl)}" alt="Factura: ${escapeHtml(g.descripcion || "")}" loading="lazy">
      </a>
    `).join("");
    section.innerHTML = `
      <div class="fotos-grupo-titulo">${escapeHtml(grupo.label)} — ${grupo.items.length} foto${grupo.items.length === 1 ? "" : "s"}</div>
      <div class="fotos-grid">${grid}</div>
    `;
    wrap.appendChild(section);
  });
}

// ---------- Render: Balance ----------
function renderBalance() {
  if (!socios.length) return;

  const gastosNegocio = gastosDelNegocio();
  const total = gastosNegocio.reduce((sum, g) => sum + (Number(g.importe) || 0), 0);
  $("#total-historico").textContent = money(total);

  const porSocio = socios.map(() => 0);
  gastosNegocio.forEach(g => {
    const idx = socios.indexOf(g.pagadoPor);
    if (idx !== -1) porSocio[idx] += Number(g.importe) || 0;
  });

  const maxPorSocio = Math.max(1, ...porSocio);
  const totalesEl = $("#socios-totales");
  totalesEl.innerHTML = "";
  socios.forEach((nombre, idx) => {
    const pct = Math.round((porSocio[idx] / maxPorSocio) * 100);
    const card = document.createElement("div");
    card.className = "socio-total-card";
    card.innerHTML = `
      <div class="socio-total-row">
        <div class="socio-total-name">
          <span class="socio-dot" style="background:${socioColorVar(idx)}"></span>
          ${escapeHtml(nombre)}
        </div>
        <div class="socio-total-amount">${money(porSocio[idx])}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${socioColorVar(idx)}"></div></div>
    `;
    totalesEl.appendChild(card);
  });

  // Deudas: cada socio "debería" haber puesto su % de PORCENTAJE_SOCIO
  // sobre el total (ver esa constante) — si por algún motivo los nombres
  // actuales de Firestore no calzan exactamente con ese mapa, se cae a
  // reparto igualitario (total/n) en vez de calcular un porcentaje mal.
  const usaPorcentajes = socios.every(nombre => nombre in PORCENTAJE_SOCIO);
  const fairShares = usaPorcentajes
    ? socios.map(nombre => total * PORCENTAJE_SOCIO[nombre])
    : socios.map(() => total / socios.length);
  const balances = socios.map((nombre, idx) => ({
    nombre, idx, balance: porSocio[idx] - fairShares[idx]
  }));

  const settlements = computeSettlements(balances);
  const settlementsEl = $("#settlements");
  settlementsEl.innerHTML = "";

  if (!total) {
    settlementsEl.innerHTML = `<p class="settlements-empty">Todavía no hay gastos para calcular.</p>`;
  } else if (!settlements.length) {
    settlementsEl.innerHTML = `<p class="settlements-empty">✅ Las cuentas están parejas entre los 3.</p>`;
  } else {
    settlements.forEach(s => {
      const item = document.createElement("div");
      item.className = "settlement-item";
      item.innerHTML = `
        <b>${escapeHtml(s.from)}</b>
        <span class="arrow">le debe a</span>
        <b>${escapeHtml(s.to)}</b>
        <span class="amt">${money(s.amount)}</span>
      `;
      settlementsEl.appendChild(item);
    });
  }

  renderColaboradoresTotales();
}

// Pagos hechos por colaboradores (ej. la encargada): se muestran a modo
// informativo, pero NUNCA entran en el cálculo de "quién le debe a quién"
// entre los socios.
function renderColaboradoresTotales() {
  const section = $("#colaboradores-section");
  if (!colaboradores.length) {
    section.classList.add("hidden");
    return;
  }

  const porColaborador = colaboradores.map(() => 0);
  gastosDelNegocio().forEach(g => {
    const idx = colaboradores.indexOf(g.pagadoPor);
    if (idx !== -1) porColaborador[idx] += Number(g.importe) || 0;
  });

  const total = porColaborador.reduce((a, b) => a + b, 0);
  if (!total) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const maxVal = Math.max(1, ...porColaborador);
  const wrap = $("#colaboradores-totales");
  wrap.innerHTML = "";
  colaboradores.forEach((nombre, idx) => {
    const pct = Math.round((porColaborador[idx] / maxVal) * 100);
    if (!porColaborador[idx]) return;
    const card = document.createElement("div");
    card.className = "socio-total-card";
    card.innerHTML = `
      <div class="socio-total-row">
        <div class="socio-total-name">
          <span class="socio-dot" style="background:${NEUTRAL_VAR}"></span>
          ${escapeHtml(nombre)}
        </div>
        <div class="socio-total-amount">${money(porColaborador[idx])}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${NEUTRAL_VAR}"></div></div>
    `;
    wrap.appendChild(card);
  });
}

// Algoritmo simple de liquidación de deudas (minimiza transacciones)
function computeSettlements(balances) {
  const debtors = balances.filter(b => b.balance < -0.01).map(b => ({ ...b, balance: -b.balance }));
  const creditors = balances.filter(b => b.balance > 0.01).map(b => ({ ...b }));
  debtors.sort((a, b) => b.balance - a.balance);
  creditors.sort((a, b) => b.balance - a.balance);

  const result = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const amount = Math.min(d.balance, c.balance);
    if (amount > 0.01) {
      result.push({ from: d.nombre, to: c.nombre, amount });
    }
    d.balance -= amount;
    c.balance -= amount;
    if (d.balance <= 0.01) i++;
    if (c.balance <= 0.01) j++;
  }
  return result;
}

// ---------- Render: chips de pagador (modal) ----------
function renderPagadorChips() {
  const wrap = $("#pagador-options");
  wrap.innerHTML = "";
  allPagadores().forEach((nombre) => {
    const chip = document.createElement("div");
    chip.className = "pagador-chip";
    chip.textContent = nombre;
    chip.style.setProperty("--chip-color", payerColorVar(nombre));
    chip.addEventListener("click", () => {
      selectedPagador = nombre;
      wrap.querySelectorAll(".pagador-chip").forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
    });
    wrap.appendChild(chip);
  });
}

// Chips de "¿Quién lo cargó?" en el modal de Facturado.
function renderPagadorChipsFacturado() {
  const wrap = $("#pagador-options-fact");
  wrap.innerHTML = "";
  allPagadores().forEach((nombre) => {
    const chip = document.createElement("div");
    chip.className = "pagador-chip";
    chip.textContent = nombre;
    chip.style.setProperty("--chip-color", payerColorVar(nombre));
    chip.addEventListener("click", () => {
      selectedRegistrador = nombre;
      wrap.querySelectorAll(".pagador-chip").forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
    });
    wrap.appendChild(chip);
  });
}

// ---------- Render: Ajustes ----------
function renderAjustesSocios() {
  const wrap = $("#ajustes-socios-list");
  wrap.innerHTML = "";
  socios.forEach((nombre, idx) => {
    const row = document.createElement("div");
    row.className = "ajustes-socio-row";
    const badge = admins.includes(nombre) ? `<span class="admin-badge">Admin</span>` : "";
    row.innerHTML = `<span class="socio-dot" style="background:${socioColorVar(idx)}"></span> ${escapeHtml(nombre)} ${badge}`;
    wrap.appendChild(row);
  });

  const usuarioEl = $("#ajustes-usuario-actual");
  usuarioEl.innerHTML = usuarioActual
    ? `Ingresaste como <b>${escapeHtml(usuarioActual)}</b>${esAdmin ? ' <span class="admin-badge">Admin</span>' : ""}`
    : "Sin identificar";

  const colabWrap = $("#ajustes-colaboradores-list");
  const colabEmpty = $("#ajustes-colaboradores-empty");
  colabWrap.innerHTML = "";
  if (colaboradores.length) {
    colabEmpty.classList.add("hidden");
    colaboradores.forEach((nombre) => {
      const row = document.createElement("div");
      row.className = "ajustes-socio-row";
      const asignado = colaboradorNegocio[nombre];
      // Solo el admin puede reasignar a qué negocio ve cada colaborador
      // (mismo criterio que editar/borrar gastos y cierres). El resto
      // solo ve el negocio asignado como texto, informativo.
      const negocioControl = esAdmin
        ? `<select class="colaborador-negocio-select colaborador-negocio-tag" data-nombre="${escapeHtml(nombre)}" title="¿Qué negocio puede ver ${escapeHtml(nombre)}?">
             <option value="">Ambos negocios</option>
             ${NEGOCIOS.map(biz => `<option value="${biz.id}" ${asignado === biz.id ? "selected" : ""}>${escapeHtml(biz.nombre)}</option>`).join("")}
           </select>`
        : `<span class="muted small colaborador-negocio-tag">${asignado ? escapeHtml(NEGOCIOS.find(b => b.id === asignado)?.nombre || asignado) : "Ambos negocios"}</span>`;
      row.innerHTML = `<span class="socio-dot" style="background:${NEUTRAL_VAR}"></span> ${escapeHtml(nombre)}`;
      row.insertAdjacentHTML("beforeend", negocioControl);
      colabWrap.appendChild(row);
    });
  } else {
    colabEmpty.classList.remove("hidden");
  }
  // Solo el admin puede sumar gente nueva (mismo criterio que reasignar
  // negocio, arriba) — el resto de las personas ni ve el botón.
  $("#btn-add-colaborador-ajustes").classList.toggle("hidden", !esAdmin);
  $("#ajustes-clave-maestra-card").classList.toggle("hidden", !esAdmin);

  $("#ajustes-conn-status").textContent = auth && auth.currentUser
    ? "✅ Conectado — los gastos se sincronizan entre todos los celulares."
    : "⚠️ No conectado.";
}

// Agregar un colaborador nuevo DESPUÉS del setup inicial (a diferencia de
// los que se cargan en la pantalla de configuración de la primera vez,
// ver addColaboradorRow() más abajo) — para cuando se suma alguien
// (ej. una empleada nueva) mientras el negocio ya está andando.
function openModalColaborador() {
  $("#input-colaborador-nombre").value = "";
  $("#input-colaborador-negocio").innerHTML = `<option value="">Ambos negocios</option>` +
    NEGOCIOS.map(biz => `<option value="${biz.id}">${escapeHtml(biz.nombre)}</option>`).join("");
  $("#modal-colaborador-error").classList.add("hidden");
  $("#modal-add-colaborador").classList.add("active");
  setTimeout(() => $("#input-colaborador-nombre").focus(), 150);
}

function closeModalColaborador() {
  $("#modal-add-colaborador").classList.remove("active");
}

async function saveColaborador() {
  const nombre = $("#input-colaborador-nombre").value.trim();
  const negocio = $("#input-colaborador-negocio").value;
  const errEl = $("#modal-colaborador-error");

  if (!nombre) {
    errEl.textContent = "Ingresá un nombre.";
    errEl.classList.remove("hidden");
    return;
  }
  // arrayUnion no avisa si el nombre ya estaba — sin este chequeo, "agregar"
  // a alguien que ya existe cerraría el modal como si hubiera funcionado
  // sin haber cambiado nada.
  if (allPagadores().includes(nombre)) {
    errEl.textContent = `Ya existe una persona llamada "${nombre}".`;
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#btn-save-colaborador");
  btn.disabled = true;
  btn.textContent = "Guardando…";
  try {
    const update = { colaboradores: fbSdk.arrayUnion(nombre) };
    if (negocio) update[`colaboradorNegocio.${nombre}`] = negocio;
    await fbSdk.updateDoc(fbSdk.doc(db, "config", "socios"), update);
    closeModalColaborador();
    showToast(`${nombre} agregado ✅`);
  } catch (e) {
    console.error(e);
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar";
  }
}

// Cambiar la clave maestra de administradores (ver claveMaestraAdmin) —
// cualquiera de los 3 admins puede hacerlo desde acá. Solo afecta a
// quien todavía no creó su PIN en algún celular; no toca los PIN que
// los admins ya tienen guardados.
async function guardarClaveMaestra() {
  const nueva = $("#input-clave-maestra").value.trim();
  const errEl = $("#clave-maestra-error");
  errEl.classList.add("hidden");

  if (!nueva) {
    errEl.textContent = "Ingresá una clave.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#btn-guardar-clave-maestra");
  btn.disabled = true;
  btn.textContent = "Guardando…";
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "config", "socios"), { claveMaestraAdmin: nueva });
    claveMaestraAdmin = nueva;
    $("#input-clave-maestra").value = "";
    showToast("Clave maestra actualizada ✅");
  } catch (e) {
    console.error(e);
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar";
  }
}

// ---------- Exportar datos (CSV) ----------
function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function downloadCSV(filename, rows) {
  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
  // BOM al principio para que Excel detecte UTF-8 y no rompa los acentos.
  const BOM = String.fromCharCode(0xFEFF);
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportGastosCSV() {
  const rows = [["Fecha", "Categoría", "Descripción", "Importe", "Pagado por"]];
  gastosDelNegocio()
    .slice()
    .sort((a, b) => fechaDeRegistro(a) - fechaDeRegistro(b))
    .forEach(g => {
      rows.push([
        fechaDeRegistro(g).toLocaleDateString("es-AR"),
        g.categoria || "Otros",
        g.descripcion || "",
        Number(g.importe) || 0,
        g.pagadoPor || ""
      ]);
    });
  downloadCSV(`gastos-${negocioActual}-${fechaLocalISO()}.csv`, rows);
}

function exportFacturacionCSV() {
  const rows = [["Fecha", "Importe", "Registrado por"]];
  facturacionesDelNegocio()
    .slice()
    .sort((a, b) => fechaDeRegistro(a) - fechaDeRegistro(b))
    .forEach(f => {
      rows.push([
        fechaDeRegistro(f).toLocaleDateString("es-AR"),
        Number(f.importe) || 0,
        f.registradoPor || ""
      ]);
    });
  downloadCSV(`facturacion-${negocioActual}-${fechaLocalISO()}.csv`, rows);
}

function setDefaultFecha() {
  $("#input-fecha").value = fechaLocalISO();
}

// ---------- Modal: agregar gasto ----------
function resetFotoField() {
  selectedFotoBlob = null;
  $("#input-foto").value = "";
  $("#foto-preview-wrap").classList.add("hidden");
  $("#foto-btns-row").classList.remove("hidden");
}

// Llena el <select> de categoría con las que correspondan al negocio
// activo (ver CATEGORIAS_GASTO) — se llama cada vez que se abre el modal,
// así siempre refleja el negocio en el que se está parado.
function renderCategoriaOptions() {
  const categorias = CATEGORIAS_GASTO[negocioActual] || CATEGORIAS_GASTO.pancho;
  $("#input-categoria").innerHTML = categorias
    .map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join("");
}

// Sin argumento: alta de un gasto nuevo. Con un gasto existente: edición
// (solo accesible para el admin, ver botón ✏️ en renderGastos).
function openModal(gasto) {
  editingGastoId = gasto ? gasto.id : null;
  // Gasto nuevo: se registra directo a nombre de quien está logueado en
  // este celular — no tiene sentido preguntarle "¿quién pagó?" si la app
  // ya sabe quién es. El selector de chips solo se muestra al EDITAR un
  // gasto ya cargado (solo accesible para el admin), por si hace falta
  // corregir un error de a quién se le atribuyó.
  selectedPagador = gasto ? gasto.pagadoPor : usuarioActual;
  $("#campo-pagador").classList.toggle("hidden", !gasto);

  renderCategoriaOptions();
  const categoriaPorDefecto = (CATEGORIAS_GASTO[negocioActual] || CATEGORIAS_GASTO.pancho)[0];
  $("#input-importe").value = gasto ? gasto.importe : "";
  $("#input-descripcion").value = gasto ? (gasto.descripcion || "") : "";
  $("#input-categoria").value = gasto ? (gasto.categoria || categoriaPorDefecto) : categoriaPorDefecto;
  $("#input-falta-abonar").checked = gasto ? !!gasto.faltaAbonar : false;
  if (gasto) {
    $("#input-fecha").value = fechaLocalISO(fechaDeRegistro(gasto));
  } else {
    setDefaultFecha();
  }
  resetFotoField(); // editar un gasto no toca su foto salvo que se elija una nueva

  $("#modal-add-title").textContent = gasto ? "Editar gasto" : "Nuevo gasto";
  $("#btn-save-add").textContent = gasto ? "Guardar cambios" : "Guardar gasto";
  $$(".pagador-chip").forEach(c => c.classList.toggle("selected", c.textContent === selectedPagador));
  $("#modal-error").classList.add("hidden");
  $("#modal-add").classList.add("active");
  setTimeout(() => $("#input-importe").focus(), 150);
}

function closeModal() {
  $("#modal-add").classList.remove("active");
  editingGastoId = null;
}

async function saveGasto() {
  const importe = parseFloat($("#input-importe").value);
  const descripcion = $("#input-descripcion").value.trim();
  const categoria = $("#input-categoria").value;
  const fechaStr = $("#input-fecha").value;
  const errEl = $("#modal-error");

  if (!importe || importe <= 0) {
    errEl.textContent = "Ingresá un importe válido.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!descripcion) {
    errEl.textContent = "Contanos en qué se gastó.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!selectedPagador) {
    errEl.textContent = "Elegí quién pagó.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#btn-save-add");
  const isEdit = !!editingGastoId;
  btn.disabled = true;
  btn.textContent = selectedFotoBlob ? "Subiendo foto…" : "Guardando…";

  try {
    let fotoUrl = null, fotoPath = null;
    if (selectedFotoBlob) {
      fotoPath = `recibos/${negocioActual}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      const storageRef = fbSdk.ref(storage, fotoPath);
      await fbSdk.uploadBytes(storageRef, selectedFotoBlob, { contentType: "image/jpeg" });
      fotoUrl = await fbSdk.getDownloadURL(storageRef);
      btn.textContent = "Guardando…";
    }

    const gastoData = {
      importe,
      descripcion,
      categoria,
      pagadoPor: selectedPagador,
      negocio: negocioActual,
      faltaAbonar: $("#input-falta-abonar").checked,
      fecha: fechaStr ? new Date(fechaStr + "T12:00:00") : fbSdk.serverTimestamp()
    };
    // Solo se tocan fotoUrl/fotoPath si se eligió una foto nueva — al editar,
    // updateDoc no toca los campos que no se le pasan, así que la foto
    // existente queda intacta si no se cambia.
    if (fotoUrl) {
      gastoData.fotoUrl = fotoUrl;
      gastoData.fotoPath = fotoPath;
    }

    if (isEdit) {
      await fbSdk.updateDoc(fbSdk.doc(db, "gastos", editingGastoId), gastoData);
    } else {
      gastoData.creadoEn = fbSdk.serverTimestamp();
      await fbSdk.addDoc(fbSdk.collection(db, "gastos"), gastoData);
    }
    closeModal();
    showToast(isEdit ? "Gasto actualizado ✅" : "Gasto guardado ✅");
  } catch (e) {
    errEl.textContent = selectedFotoBlob
      ? "No se pudo subir la foto. Revisá tu conexión (o que Cloud Storage esté activado en Firebase)."
      : "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = isEdit ? "Guardar cambios" : "Guardar gasto";
  }
}

// Solo accesible desde el botón 🗑️ (esAdmin). Borra también la foto en
// Storage si tenía una — el gasto en Firestore se elimina por completo
// (a diferencia de limpiarFotosVencidas, que solo borra la foto).
async function deleteGasto(id) {
  if (!confirm("¿Borrar este gasto? No se puede deshacer.")) return;
  const gasto = gastos.find(g => g.id === id);
  try {
    if (gasto && gasto.fotoPath) {
      try {
        await fbSdk.deleteObject(fbSdk.ref(storage, gasto.fotoPath));
      } catch (e) {
        console.warn("No se pudo borrar la foto del gasto:", e.message);
      }
    }
    await fbSdk.deleteDoc(fbSdk.doc(db, "gastos", id));
    showToast("Gasto borrado");
  } catch (e) {
    console.error(e);
    showToast("No se pudo borrar. Revisá tu conexión.");
  }
}

// ---------- Modal: agregar cierre de Facturado ----------
function setDefaultFechaFact() {
  $("#input-fecha-fact").value = fechaLocalISO();
}

// Cálculo cruzado Total/Efectivo/Digital: se pueden completar 2
// cualquiera de los 3 campos y el que falta se calcula solo.
// facturadoUltimosEditados guarda, en orden, los últimos 2 campos que
// se tipearon A MANO (no los que ya se autocompletaron) — con esos 2 se
// sabe cuál es el tercero a calcular. Se reinicia cada vez que se abre
// el modal (ver openModalFacturado()).
let facturadoUltimosEditados = [];

const FACTURADO_CAMPO_ID = {
  total: "input-importe-fact",
  efectivo: "input-efectivo-fact",
  digital: "input-digital-fact",
};

function registrarEdicionManualFacturado(campo) {
  facturadoUltimosEditados = facturadoUltimosEditados.filter(c => c !== campo);
  facturadoUltimosEditados.push(campo);
  if (facturadoUltimosEditados.length > 2) facturadoUltimosEditados.shift();
  calcularCampoFaltanteFacturado();
}

function calcularCampoFaltanteFacturado() {
  if (facturadoUltimosEditados.length < 2) return; // todavía no hay 2 campos como para deducir el tercero
  const valores = {
    total: parseFloat($("#input-importe-fact").value),
    efectivo: parseFloat($("#input-efectivo-fact").value),
    digital: parseFloat($("#input-digital-fact").value),
  };
  const [a, b] = facturadoUltimosEditados;
  if (!Number.isFinite(valores[a]) || !Number.isFinite(valores[b])) return;

  const faltante = ["total", "efectivo", "digital"].find(c => c !== a && c !== b);
  const resultado = faltante === "total" ? valores.efectivo + valores.digital
    : faltante === "efectivo" ? valores.total - valores.digital
    : valores.total - valores.efectivo;

  // Se muestra el resultado tal cual, incluso si da negativo (ej.
  // pusiste más Efectivo que Total) — así se nota el error a simple
  // vista en vez de desaparecer solo; saveCierre() lo bloquea al guardar.
  $("#" + FACTURADO_CAMPO_ID[faltante]).value = Math.round(resultado * 100) / 100;
}

// Sin argumento: alta de un cierre nuevo. Con un cierre existente: edición
// (solo admin, ver botón ✏️ en renderFacturado).
function openModalFacturado(cierre) {
  editingCierreId = cierre ? cierre.id : null;
  selectedRegistrador = cierre
    ? cierre.registradoPor
    : (allPagadores().includes(usuarioActual) ? usuarioActual : null);

  $("#input-importe-fact").value = cierre ? cierre.importe : "";
  // Cierres cargados ANTES de que existiera el desglose Efectivo/Digital
  // no tienen esos campos guardados — quedan en blanco para que se
  // completen de nuevo (no se puede inventar cómo se repartía antes).
  $("#input-efectivo-fact").value = cierre && cierre.efectivo != null ? cierre.efectivo : "";
  $("#input-digital-fact").value = cierre && cierre.digital != null ? cierre.digital : "";
  facturadoUltimosEditados = [];
  if (cierre) {
    $("#input-fecha-fact").value = fechaLocalISO(fechaDeRegistro(cierre));
  } else {
    setDefaultFechaFact();
  }

  $("#modal-fact-title").textContent = cierre ? "Editar cierre" : "Nuevo cierre";
  $("#btn-save-facturado").textContent = cierre ? "Guardar cambios" : "Guardar";
  $$("#pagador-options-fact .pagador-chip").forEach(c => c.classList.toggle("selected", c.textContent === selectedRegistrador));
  $("#modal-fact-error").classList.add("hidden");
  $("#modal-add-facturado").classList.add("active");
  setTimeout(() => $("#input-importe-fact").focus(), 150);
}

function closeModalFacturado() {
  $("#modal-add-facturado").classList.remove("active");
  editingCierreId = null;
}

async function saveCierre() {
  const importe = parseFloat($("#input-importe-fact").value);
  const efectivo = parseFloat($("#input-efectivo-fact").value);
  const digital = parseFloat($("#input-digital-fact").value);
  const fechaStr = $("#input-fecha-fact").value;
  const errEl = $("#modal-fact-error");

  if (!importe || importe <= 0) {
    errEl.textContent = "Ingresá un importe válido.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!Number.isFinite(efectivo) || !Number.isFinite(digital) || efectivo < 0 || digital < 0) {
    errEl.textContent = "Completá Efectivo y Digital (el que falta se calcula solo con el otro y el Total).";
    errEl.classList.remove("hidden");
    return;
  }
  // Por las dudas se hayan tipeado los 3 campos a mano sin dejar que se
  // autocompletara ninguno: se valida que sumen el total antes de
  // guardar, en vez de confiar ciegamente en el cálculo cruzado.
  if (Math.abs(efectivo + digital - importe) > 0.01) {
    errEl.textContent = "Efectivo + Digital no coincide con el Total. Revisá los montos.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!selectedRegistrador) {
    errEl.textContent = "Elegí quién lo cargó.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#btn-save-facturado");
  const isEdit = !!editingCierreId;
  btn.disabled = true;
  btn.textContent = "Guardando…";

  try {
    const data = {
      importe,
      efectivo,
      digital,
      registradoPor: selectedRegistrador,
      negocio: negocioActual,
      fecha: fechaStr ? new Date(fechaStr + "T12:00:00") : fbSdk.serverTimestamp()
    };
    if (isEdit) {
      await fbSdk.updateDoc(fbSdk.doc(db, "facturacion", editingCierreId), data);
    } else {
      data.creadoEn = fbSdk.serverTimestamp();
      await fbSdk.addDoc(fbSdk.collection(db, "facturacion"), data);
    }
    closeModalFacturado();
    showToast(isEdit ? "Cierre actualizado ✅" : "Cierre guardado ✅");
  } catch (e) {
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = isEdit ? "Guardar cambios" : "Guardar";
  }
}

// Solo accesible desde el botón 🗑️ (esAdmin).
async function deleteCierre(id) {
  if (!confirm("¿Borrar este cierre? No se puede deshacer.")) return;
  try {
    await fbSdk.deleteDoc(fbSdk.doc(db, "facturacion", id));
    showToast("Cierre borrado");
  } catch (e) {
    console.error(e);
    showToast("No se pudo borrar. Revisá tu conexión.");
  }
}

// ---------- Tabs ----------
// OJO: el selector de acá adentro está limitado a #screen-app a propósito.
// Las pantallas de Facturado / Resumen / Fotos guardadas también usan la
// clase .tab (para heredar el mismo estilo de scroll/padding) pero no son
// parte de este tabbar — si se les sacara "active" con un $$(".tab") global,
// quedarían en blanco la primera vez que se toque cualquier pestaña.
function switchTab(name) {
  $("#screen-app").querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  $$(".tabbtn").forEach(b => b.classList.remove("active"));
  $("#tab-" + name).classList.add("active");
  $(`.tabbtn[data-tab="${name}"]`).classList.add("active");
  $("#fab-add").classList.toggle("hidden", name !== "gastos");
}

// ---------- Setup screen ----------
function addColaboradorRow(value, negocioAsignado) {
  const list = $("#colaboradores-list");
  const row = document.createElement("div");
  row.className = "colaborador-row";
  const opciones = `<option value="">Ambos negocios</option>` + NEGOCIOS.map(biz =>
    `<option value="${biz.id}" ${negocioAsignado === biz.id ? "selected" : ""}>${escapeHtml(biz.nombre)}</option>`
  ).join("");
  row.innerHTML = `
    <input type="text" class="colaborador-input" placeholder="Ej: Encargada" maxlength="30" value="${escapeHtml(value || "")}">
    <select class="colaborador-negocio-input" title="¿Qué negocio puede ver esta persona?">${opciones}</select>
    <button type="button" class="colaborador-remove" aria-label="Quitar">×</button>
  `;
  row.querySelector(".colaborador-remove").addEventListener("click", () => row.remove());
  list.appendChild(row);
}

// Nombres + el negocio asignado a cada uno (o "" si eligieron "Ambos
// negocios") — se arma acá el mapa colaboradorNegocio que se guarda en
// Firestore (ver handleSetupGuardar).
function getColaboradorInputs() {
  return Array.from($$(".colaborador-row"))
    .map(row => ({
      nombre: row.querySelector(".colaborador-input").value.trim(),
      negocio: row.querySelector(".colaborador-negocio-input").value
    }))
    .filter(c => c.nombre);
}

// Guarda config + socios en este navegador y entra a la app.
async function finalizeSetup(config) {
  localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(config));
  localStorage.setItem(LS_SOCIOS_CACHE, JSON.stringify(socios));
  localStorage.setItem(LS_COLAB_CACHE, JSON.stringify(colaboradores));
  bootApp();
}

// PASO 1: conectar con Firebase y ver si ya hay socios cargados (por otra
// persona, en otro navegador). Si ya existen, entra directo — nadie más
// tiene que volver a escribir los nombres. Si no existen, pasa al paso 2.
async function handleSetupConnect() {
  const raw = $("#firebase-config-input").value;
  const errEl = $("#setup-error");
  const statusEl = $("#setup-status");
  const btn = $("#btn-setup-connect");
  errEl.classList.add("hidden");

  try {
    const config = parseFirebaseConfig(raw);
    btn.disabled = true;
    statusEl.textContent = "Conectando…";
    await initFirebase(config);

    const socioDocRef = fbSdk.doc(db, "config", "socios");
    const snap = await fbSdk.getDoc(socioDocRef);

    if (snap.exists() && Array.isArray(snap.data().socios) && snap.data().socios.length === 3) {
      const data = snap.data();
      socios = data.socios;
      colaboradores = Array.isArray(data.colaboradores) ? data.colaboradores : [];
      colaboradorNegocio = data.colaboradorNegocio && typeof data.colaboradorNegocio === "object" ? data.colaboradorNegocio : {};
      admins = Array.isArray(data.admins) ? data.admins : [];
      pins = data.pins && typeof data.pins === "object" ? data.pins : {};
      claveMaestraAdmin = typeof data.claveMaestraAdmin === "string" ? data.claveMaestraAdmin : "";
      statusEl.textContent = "";
      await finalizeSetup(config);
    } else {
      pendingFirebaseConfig = config;
      statusEl.textContent = "";
      $("#setup-step-firebase").classList.add("hidden");
      $("#setup-step-socios").classList.remove("hidden");
      setTimeout(() => $("#socio1").focus(), 100);
    }
  } catch (e) {
    console.error(e);
    errEl.textContent = e.message || "Ocurrió un error al conectar.";
    errEl.classList.remove("hidden");
    statusEl.textContent = "";
  } finally {
    btn.disabled = false;
  }
}

// PASO 2: solo se ve la primera vez que alguien conecta este negocio —
// crea los socios en Firebase y entra.
async function handleSetupGuardar() {
  const errEl = $("#setup-socios-error");
  const btn = $("#btn-setup-guardar");
  errEl.classList.add("hidden");

  const names = [$("#socio1").value, $("#socio2").value, $("#socio3").value];
  if (names.some(n => !n.trim())) {
    errEl.textContent = "Completá los nombres de los 3 socios.";
    errEl.classList.remove("hidden");
    return;
  }
  const colabInputs = getColaboradorInputs();
  const adminFlags = [$("#socio1-admin").checked, $("#socio2-admin").checked, $("#socio3-admin").checked];

  btn.disabled = true;
  try {
    const socioDocRef = fbSdk.doc(db, "config", "socios");
    socios = names.map(n => n.trim());
    colaboradores = colabInputs.map(c => c.nombre);
    colaboradorNegocio = {};
    colabInputs.forEach(c => { if (c.negocio) colaboradorNegocio[c.nombre] = c.negocio; });
    admins = socios.filter((_, idx) => adminFlags[idx]);
    pins = {};
    // Clave compartida para que los admins creen su PIN la primera vez
    // (ver openPinModal/confirmPinModal) — cada uno la puede cambiar
    // después desde Ajustes, sin afectar los PIN ya creados.
    claveMaestraAdmin = "llavez";
    await fbSdk.setDoc(socioDocRef, { socios, colaboradores, colaboradorNegocio, admins, pins, claveMaestraAdmin });
    await finalizeSetup(pendingFirebaseConfig);
  } catch (e) {
    console.error(e);
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

// ---------- Instalación PWA ----------
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $("#btn-install").classList.remove("hidden");
});
$("#btn-install")?.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#btn-install").classList.add("hidden");
});

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(console.warn);
  });
}

// ---------- Reset ----------
function resetLocalConfig() {
  if (!confirm("¿Desconectar este celular? No se borran los gastos.")) return;
  localStorage.removeItem(LS_CONFIG_KEY);
  localStorage.removeItem(LS_SOCIOS_CACHE);
  localStorage.removeItem(LS_COLAB_CACHE);
  location.reload();
}

// ---------- Listeners de UI ----------
function wireEvents() {
  $("#btn-setup-connect").addEventListener("click", handleSetupConnect);
  $("#btn-setup-guardar").addEventListener("click", handleSetupGuardar);
  $("#btn-add-colaborador").addEventListener("click", () => addColaboradorRow());
  addColaboradorRow(); // arranca con una fila vacía disponible
  $("#fab-add").addEventListener("click", () => openModal());
  $("#btn-cancel-add").addEventListener("click", closeModal);
  $("#btn-cambiar-usuario").addEventListener("click", cambiarUsuario);
  $("#btn-pin-cancel").addEventListener("click", closePinModal);
  $("#btn-pin-confirm").addEventListener("click", confirmPinModal);
  $("#modal-pin").addEventListener("click", (e) => {
    if (e.target.id === "modal-pin") closePinModal();
  });
  $("#pin-input-1").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (pinFlowMode === "create") $("#pin-input-2").focus();
    else confirmPinModal();
  });
  $("#pin-input-2").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmPinModal();
  });
  $("#btn-save-add").addEventListener("click", saveGasto);
  $("#modal-add").addEventListener("click", (e) => {
    if (e.target.id === "modal-add") closeModal();
  });
  $("#btn-export-gastos").addEventListener("click", exportGastosCSV);
  $("#btn-export-facturacion").addEventListener("click", exportFacturacionCSV);
  $("#btn-reset").addEventListener("click", resetLocalConfig);
  $("#btn-switch-negocio").addEventListener("click", volverASeccion);
  $("#btn-back-to-seccion-fact").addEventListener("click", volverASeccion);
  $("#btn-back-to-negocio").addEventListener("click", () => showScreen("screen-negocio"));
  $("#btn-back-to-seccion-resumen").addEventListener("click", volverASeccion);
  $("#btn-mes-anterior").addEventListener("click", () => {
    resumenMesOffset--;
    renderResumen();
  });
  $("#btn-mes-siguiente").addEventListener("click", () => {
    if (resumenMesOffset >= 0) return;
    resumenMesOffset++;
    renderResumen();
  });
  $("#fab-add-facturado").addEventListener("click", () => openModalFacturado());
  $("#btn-cancel-add-facturado").addEventListener("click", closeModalFacturado);
  $("#btn-save-facturado").addEventListener("click", saveCierre);
  $("#modal-add-facturado").addEventListener("click", (e) => {
    if (e.target.id === "modal-add-facturado") closeModalFacturado();
  });
  $("#input-importe-fact").addEventListener("input", () => registrarEdicionManualFacturado("total"));
  $("#input-efectivo-fact").addEventListener("input", () => registrarEdicionManualFacturado("efectivo"));
  $("#input-digital-fact").addEventListener("input", () => registrarEdicionManualFacturado("digital"));

  $("#btn-back-from-ideas").addEventListener("click", volverASeccion);
  $("#fab-add-idea").addEventListener("click", () => openModalIdea());
  $("#btn-cancel-add-idea").addEventListener("click", closeModalIdea);
  $("#btn-save-idea").addEventListener("click", saveIdea);
  $("#modal-add-idea").addEventListener("click", (e) => {
    if (e.target.id === "modal-add-idea") closeModalIdea();
  });
  // Toggle pendiente/concretada tocando la tarjeta; borrar solo con el 🗑️ (admin)
  const handleIdeaListClick = (e) => {
    const delBtn = e.target.closest(".idea-delete-btn");
    if (delBtn) { deleteIdea(delBtn.dataset.id); return; }
    const voteBtn = e.target.closest(".idea-vote-btn");
    if (voteBtn) { toggleVoto(voteBtn.dataset.id); return; }
    const card = e.target.closest(".idea-card");
    if (card) toggleIdeaEstado(card.dataset.id);
  };
  $("#ideas-pendientes-list").addEventListener("click", handleIdeaListClick);
  $("#ideas-concretadas-list").addEventListener("click", handleIdeaListClick);
  $$(".tabbtn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // Foto de factura (modal Nuevo gasto): "Tomar foto" agrega el atributo
  // capture antes de abrir el selector, para forzar la cámara trasera;
  // "Elegir de galería" lo saca para que el navegador ofrezca el
  // selector de archivos/fotos normal. Ambos disparan el mismo
  // <input type="file">.
  $("#btn-tomar-foto").addEventListener("click", () => {
    $("#input-foto").setAttribute("capture", "environment");
    $("#input-foto").click();
  });
  $("#btn-elegir-foto").addEventListener("click", () => {
    $("#input-foto").removeAttribute("capture");
    $("#input-foto").click();
  });
  $("#input-foto").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      selectedFotoBlob = await compressImage(file);
      $("#foto-preview-img").src = URL.createObjectURL(selectedFotoBlob);
      $("#foto-preview-wrap").classList.remove("hidden");
      $("#foto-btns-row").classList.add("hidden");
    } catch (err) {
      console.error(err);
      showToast("No se pudo procesar la foto.");
    }
  });
  $("#btn-quitar-foto").addEventListener("click", resetFotoField);

  // Foto, editar y borrar de un gasto ya cargado (delegado, la lista se re-dibuja seguido)
  $("#expenses-list").addEventListener("click", (e) => {
    const fotoBtn = e.target.closest(".foto-link");
    if (fotoBtn) { window.open(fotoBtn.dataset.url, "_blank", "noopener"); return; }
    const editBtn = e.target.closest(".gasto-edit-btn");
    if (editBtn) {
      const g = gastos.find(x => x.id === editBtn.dataset.id);
      if (g) openModal(g);
      return;
    }
    const delBtn = e.target.closest(".gasto-delete-btn");
    if (delBtn) deleteGasto(delBtn.dataset.id);
  });

  // Editar y borrar de un cierre ya cargado (delegado, admin)
  $("#facturado-list").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".cierre-edit-btn");
    if (editBtn) {
      const c = facturaciones.find(x => x.id === editBtn.dataset.id);
      if (c) openModalFacturado(c);
      return;
    }
    const delBtn = e.target.closest(".cierre-delete-btn");
    if (delBtn) deleteCierre(delBtn.dataset.id);
  });

  // Pantalla "Fotos guardadas"
  $("#btn-ver-fotos").addEventListener("click", () => {
    renderFotosGuardadas();
    showScreen("screen-fotos");
  });
  $("#btn-back-to-ajustes").addEventListener("click", () => {
    switchTab("ajustes");
    showScreen("screen-app");
  });

  $("#btn-guardar-clave-maestra").addEventListener("click", guardarClaveMaestra);

  // Agregar colaborador nuevo desde Ajustes (botón oculto para no-admin).
  $("#btn-add-colaborador-ajustes").addEventListener("click", () => openModalColaborador());
  $("#btn-cancel-add-colaborador").addEventListener("click", closeModalColaborador);
  $("#btn-save-colaborador").addEventListener("click", saveColaborador);
  $("#modal-add-colaborador").addEventListener("click", (e) => {
    if (e.target.id === "modal-add-colaborador") closeModalColaborador();
  });

  // Reasignar a qué negocio ve un colaborador, desde Ajustes (solo se
  // renderiza el <select> para el admin — ver renderAjustesSocios()).
  $("#ajustes-colaboradores-list").addEventListener("change", async (e) => {
    const select = e.target.closest(".colaborador-negocio-select");
    if (!select) return;
    const nombre = select.dataset.nombre;
    const valor = select.value;
    try {
      await fbSdk.updateDoc(fbSdk.doc(db, "config", "socios"), {
        [`colaboradorNegocio.${nombre}`]: valor
      });
      colaboradorNegocio[nombre] = valor;
      showToast(`${nombre} → ${valor ? NEGOCIOS.find(b => b.id === valor).nombre : "Ambos negocios"}`);
    } catch (err) {
      console.error(err);
      showToast("No se pudo guardar. Revisá tu conexión.");
      renderAjustesSocios(); // vuelve a dejar el <select> como estaba en la base
    }
  });
}

// ---------- Arranque ----------
// Se llama SIEMPRE al abrir la app (ver start()). Es uno de 3 caminos de
// arranque posibles junto con handleSetupConnect/handleSetupGuardar (ver
// README, sección "Flujo de arranque") — este es el único que no requiere
// tipear nada: usa la config y el caché de socios ya guardados de una vez
// anterior.
async function attemptReconnect() {
  const savedConfig = localStorage.getItem(LS_CONFIG_KEY);
  const cachedSocios = localStorage.getItem(LS_SOCIOS_CACHE);
  const cachedColab = localStorage.getItem(LS_COLAB_CACHE);

  if (!savedConfig) {
    showScreen("screen-setup");
    return;
  }

  if (cachedSocios) {
    try { socios = JSON.parse(cachedSocios); } catch (_) {}
  }
  if (cachedColab) {
    try { colaboradores = JSON.parse(cachedColab); } catch (_) {}
  }

  $("#loading-msg").textContent = "Cargando…";
  $("#btn-retry-boot").classList.add("hidden");
  $("#btn-reconfigure-boot").classList.add("hidden");
  showScreen("screen-loading");

  try {
    const config = JSON.parse(savedConfig);
    await connectAndBoot(config, socios, colaboradores);
  } catch (e) {
    console.error("Error reconectando:", e);
    $("#loading-msg").textContent = e.message && e.message.includes("conectar")
      ? e.message
      : "No se pudo conectar. Revisá tu internet.";
    $("#btn-retry-boot").classList.remove("hidden");
    $("#btn-reconfigure-boot").classList.remove("hidden");
  }
}

async function start() {
  wireEvents();
  $("#btn-retry-boot").addEventListener("click", attemptReconnect);
  $("#btn-reconfigure-boot").addEventListener("click", () => {
    showScreen("screen-setup");
  });
  await attemptReconnect();
}

start();
