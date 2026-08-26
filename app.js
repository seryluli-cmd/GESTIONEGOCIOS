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

let fbApp = null, auth = null, db = null, storage = null;
let selectedFotoBlob = null; // foto comprimida, lista para subir (modal Nuevo gasto)
const FOTO_RETENCION_DIAS = 120; // ~4 meses — pasado esto, se borra sola la foto (no el gasto)
let fotosLimpiezaHecha = false;
let socios = [];           // ["Sergio", "Ana", "Marcos"] — los 3 socios, entran en el reparto
let colaboradores = [];    // ["Encargada"] — pueden pagar/cargar, NO entran en el reparto
let admins = [];           // subconjunto de nombres (normalmente socios) con permiso para editar/borrar
let pins = {};             // { "Sergio": "1234", ... } — PIN fijo de 4 dígitos por persona (ver README: no es seguridad real, solo identificación)
let gastos = [];           // TODOS los gastos, de los 2 negocios — [{id, importe, descripcion, categoria, pagadoPor, fecha, negocio}]
let facturaciones = [];    // TODOS los cierres diarios, de los 2 negocios — [{id, importe, registradoPor, fecha, negocio}]
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
    admins = Array.isArray(data.admins) ? data.admins : [];
    pins = data.pins && typeof data.pins === "object" ? data.pins : {};
  } else {
    if (!namesFromInput || namesFromInput.some(n => !n.trim())) {
      throw new Error("Completá los nombres de los 3 socios.");
    }
    socios = namesFromInput.map(n => n.trim());
    colaboradores = (colabFromInput || []).map(n => n.trim()).filter(Boolean);
    admins = [];
    pins = {};
    await sdk.setDoc(socioDocRef, { socios, colaboradores, admins, pins });
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
    showScreen("screen-negocio");
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
  renderGastos();
  renderFacturado();
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
  $("#pin-error").classList.add("hidden");

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
  setTimeout(() => $("#pin-input-1").focus(), 150);
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
    closePinModal();
    setUsuarioActual(pinFlowNombre);
    showScreen("screen-negocio");
    return;
  }

  // pinFlowMode === "create"
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
    showScreen("screen-negocio");
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
  NEGOCIOS.forEach(biz => {
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

  renderSeccionCards(biz);
  showScreen("screen-seccion");
}

// ---------- Selector de sección (Gastos / Facturado) ----------
function renderSeccionCards(biz) {
  $("#seccion-negocio-nombre").textContent = biz.nombre;
  $("#seccion-icon-badge").textContent = biz.emoji;
  $("#seccion-icon-badge").style.background = biz.color;

  const SECCIONES = [
    { id: "gastos", emoji: "🧾", nombre: "Gastos", sub: "Cargar gastos y ver el balance entre socios" },
    { id: "facturado", emoji: "💰", nombre: "Facturado", sub: "Anotar lo que se facturó cada día" },
    { id: "resumen", emoji: "📊", nombre: "Resumen mensual", sub: "Ver los totales de cada mes" }
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

function listenSocios() {
  const socioDocRef = fbSdk.doc(db, "config", "socios");
  fbSdk.onSnapshot(socioDocRef, (snap) => {
    if (snap.exists() && Array.isArray(snap.data().socios)) {
      const data = snap.data();
      socios = data.socios;
      colaboradores = Array.isArray(data.colaboradores) ? data.colaboradores : [];
      admins = Array.isArray(data.admins) ? data.admins : [];
      pins = data.pins && typeof data.pins === "object" ? data.pins : {};
      localStorage.setItem(LS_SOCIOS_CACHE, JSON.stringify(socios));
      localStorage.setItem(LS_COLAB_CACHE, JSON.stringify(colaboradores));
      esAdmin = usuarioActual ? admins.includes(usuarioActual) : false;
      renderPagadorChips();
      renderPagadorChipsFacturado();
      renderAjustesSocios();
      renderBalance();
      renderGastos();
      renderFacturado();
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

    const li = document.createElement("li");
    li.className = "expense-item";
    li.innerHTML = `
      <div class="avatar" style="background:${payerColorVar(g.pagadoPor)}">${socioInitial(g.pagadoPor)}</div>
      <div class="info">
        <div class="desc">${escapeHtml(g.descripcion || "Sin descripción")}</div>
        <div class="meta">${fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} · ${escapeHtml(g.categoria || "Otros")} · Pagó ${escapeHtml(g.pagadoPor || "?")}</div>
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

  $("#resumen-total-facturado").textContent = money(totalFact);
  $("#resumen-cant-facturado").textContent = factMes.length === 1 ? "1 cierre cargado" : `${factMes.length} cierres cargados`;
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

  // Deudas: cada socio "debería" haber puesto total/n
  const fairShare = total / socios.length;
  const balances = socios.map((nombre, idx) => ({
    nombre, idx, balance: porSocio[idx] - fairShare
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
      row.innerHTML = `<span class="socio-dot" style="background:${NEUTRAL_VAR}"></span> ${escapeHtml(nombre)}`;
      colabWrap.appendChild(row);
    });
  } else {
    colabEmpty.classList.remove("hidden");
  }

  $("#ajustes-conn-status").textContent = auth && auth.currentUser
    ? "✅ Conectado — los gastos se sincronizan entre todos los celulares."
    : "⚠️ No conectado.";
}

function setDefaultFecha() {
  const el = $("#input-fecha");
  const today = new Date();
  el.value = today.toISOString().slice(0, 10);
}

// ---------- Modal: agregar gasto ----------
function resetFotoField() {
  selectedFotoBlob = null;
  $("#input-foto").value = "";
  $("#foto-preview-wrap").classList.add("hidden");
  $("#btn-elegir-foto").classList.remove("hidden");
}

// Sin argumento: alta de un gasto nuevo. Con un gasto existente: edición
// (solo accesible para el admin, ver botón ✏️ en renderGastos).
function openModal(gasto) {
  editingGastoId = gasto ? gasto.id : null;
  selectedPagador = gasto
    ? gasto.pagadoPor
    : (allPagadores().includes(usuarioActual) ? usuarioActual : null);

  $("#input-importe").value = gasto ? gasto.importe : "";
  $("#input-descripcion").value = gasto ? (gasto.descripcion || "") : "";
  $("#input-categoria").value = gasto ? (gasto.categoria || "Insumos") : "Insumos";
  if (gasto) {
    $("#input-fecha").value = fechaDeRegistro(gasto).toISOString().slice(0, 10);
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
  $("#input-fecha-fact").value = new Date().toISOString().slice(0, 10);
}

// Sin argumento: alta de un cierre nuevo. Con un cierre existente: edición
// (solo admin, ver botón ✏️ en renderFacturado).
function openModalFacturado(cierre) {
  editingCierreId = cierre ? cierre.id : null;
  selectedRegistrador = cierre
    ? cierre.registradoPor
    : (allPagadores().includes(usuarioActual) ? usuarioActual : null);

  $("#input-importe-fact").value = cierre ? cierre.importe : "";
  if (cierre) {
    $("#input-fecha-fact").value = fechaDeRegistro(cierre).toISOString().slice(0, 10);
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
  const fechaStr = $("#input-fecha-fact").value;
  const errEl = $("#modal-fact-error");

  if (!importe || importe <= 0) {
    errEl.textContent = "Ingresá un importe válido.";
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
}

// ---------- Setup screen ----------
function addColaboradorRow(value) {
  const list = $("#colaboradores-list");
  const row = document.createElement("div");
  row.className = "colaborador-row";
  row.innerHTML = `
    <input type="text" class="colaborador-input" placeholder="Ej: Encargada" maxlength="30" value="${escapeHtml(value || "")}">
    <button type="button" class="colaborador-remove" aria-label="Quitar">×</button>
  `;
  row.querySelector(".colaborador-remove").addEventListener("click", () => row.remove());
  list.appendChild(row);
}

function getColaboradorInputs() {
  return Array.from($$(".colaborador-input"))
    .map(el => el.value.trim())
    .filter(Boolean);
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
      admins = Array.isArray(data.admins) ? data.admins : [];
      pins = data.pins && typeof data.pins === "object" ? data.pins : {};
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
  const colabNames = getColaboradorInputs();
  const adminFlags = [$("#socio1-admin").checked, $("#socio2-admin").checked, $("#socio3-admin").checked];

  btn.disabled = true;
  try {
    const socioDocRef = fbSdk.doc(db, "config", "socios");
    socios = names.map(n => n.trim());
    colaboradores = colabNames;
    admins = socios.filter((_, idx) => adminFlags[idx]);
    pins = {};
    await fbSdk.setDoc(socioDocRef, { socios, colaboradores, admins, pins });
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
  $$(".tabbtn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // Foto de factura (modal Nuevo gasto)
  $("#btn-elegir-foto").addEventListener("click", () => $("#input-foto").click());
  $("#input-foto").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      selectedFotoBlob = await compressImage(file);
      $("#foto-preview-img").src = URL.createObjectURL(selectedFotoBlob);
      $("#foto-preview-wrap").classList.remove("hidden");
      $("#btn-elegir-foto").classList.add("hidden");
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
