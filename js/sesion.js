// ============================================================
// Identidad del celular (¿Quién sos? + PIN), permisos derivados de esa
// identidad, y los selectores de negocio / sección. Nadie fuera de acá
// reasigna usuarioActual, esAdmin, negocioActual o pinFlowMode.
// ============================================================

import { $, $$, showScreen, switchTab, escapeHtml } from "./utilidades.js";
import { fbSdk, db } from "./firebase-sdk.js";
import { socios, colaboradorNegocio, admins, pins, claveMaestraAdmin } from "./datos.js";
import {
  NEGOCIOS, payerColorVar, socioInitial, allPagadores,
  renderAjustesSocios,
  renderBalance,
  resetResumenMesOffset, resetGastosMesOffset, resetFacturadoMesOffset, resetGastosAdminMesOffset
} from "../app.js";
import { renderGastos, renderGastosAdmin } from "./gastos.js";
import { renderFacturado } from "./facturado.js";
import { renderIdeas } from "./ideas.js";
import { renderResumen } from "./resumen.js";

const LS_USER_KEY = "gn_current_user"; // quién está identificado en este celular

export let usuarioActual = null;  // nombre con el que se identificó este celular (ver resumeSession)
export let esAdmin = false;       // usuarioActual ∈ admins
export function setEsAdmin(valor) { esAdmin = valor; }
export let negocioActual = null;  // "pancho" | "heladeria"
let seccionActual = null;  // "gastos" | "facturado" | "resumen"
let pinFlowNombre = null;  // nombre para el que está abierto el modal de PIN
export let pinFlowMode = null;    // "create" (todavía no tiene PIN) | "verify" (ya tiene uno)

// ---------- Identidad del celular (¿Quién sos? + PIN) ----------
// Se pregunta una sola vez por celular (como el resto de la config) y se
// recuerda en localStorage hasta que se use "Cambiar de usuario" en Ajustes.
// OJO: esto NO es una capa de seguridad real — cualquier dispositivo con la
// config de Firebase ya puede leer/escribir todo en Firestore. Sirve solo
// para identificar quién usa cada celular y mostrar los botones de admin.
export function resumeSession() {
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
  registrarLogin(nombre);
  aplicarPermisosDeVista();
  renderAjustesSocios();
  renderNegocioCards();
  renderGastos();
  renderFacturado();
  renderIdeas();
}

// Historial de logeos: cuenta cuántas veces se identificó cada persona
// (tanto al tipear el PIN de nuevo como cuando el celular ya la recordaba
// — setUsuarioActual() es el único lugar por el que pasa cualquiera de
// las dos formas). Solo Sergio puede VER el resultado (ver
// renderAjustesSocios) pero se cuenta para todos por igual. Un doc por
// persona con un contador atómico, en vez de un doc por logeo, para no
// acumular una colección sin límite ni tener que leer miles de docs para
// mostrar un simple conteo.
async function registrarLogin(nombre) {
  try {
    await fbSdk.setDoc(fbSdk.doc(db, "logins", nombre), { veces: fbSdk.increment(1) }, { merge: true });
  } catch (e) {
    console.error("No se pudo registrar el logeo:", e);
  }
}

export async function cargarHistorialLogins() {
  const wrap = $("#historial-logins-list");
  const empty = $("#historial-logins-empty");
  wrap.innerHTML = "";
  try {
    const snap = await fbSdk.getDocs(fbSdk.collection(db, "logins"));
    const filas = [];
    snap.forEach(d => filas.push({ nombre: d.id, veces: d.data().veces || 0 }));
    filas.sort((a, b) => b.veces - a.veces);
    empty.classList.toggle("hidden", filas.length > 0);
    filas.forEach(f => {
      const row = document.createElement("div");
      row.className = "ajustes-socio-row";
      row.innerHTML = `<span class="socio-dot" style="background:${payerColorVar(f.nombre)}"></span> ${escapeHtml(f.nombre)}
        <span class="muted small" style="margin-left:auto;">${f.veces} ${f.veces === 1 ? "vez" : "veces"}</span>`;
      wrap.appendChild(row);
    });
  } catch (e) {
    console.error("No se pudo cargar el historial de logeos:", e);
    empty.textContent = "No se pudo cargar. Revisá tu conexión.";
    empty.classList.remove("hidden");
  }
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

// ¿La persona identificada es uno de los 3 socios? Los colaboradores
// (ej. la encargada) cargan gastos y ven la caja del local, pero NO la
// plata entre socios ni los totales del negocio — ver
// aplicarPermisosDeVista() y renderSeccionCards(). OJO: esto es solo la
// interfaz, no es seguridad real (ver README: cualquiera con la
// firebaseConfig puede leer todo directo de Firestore).
export function esSocio() {
  return !!usuarioActual && socios.includes(usuarioActual);
}

// Esconde a los colaboradores lo que es solo de los socios: la pestaña
// Balance (cuánto puso cada uno y quién le debe a quién) y la tarjeta
// de Ajustes que baja todo el historial del negocio en CSV. El Resumen
// mensual se filtra aparte, en renderSeccionCards(), porque es una
// tarjeta de sección y no una pestaña. Se llama cada vez que puede
// cambiar quién está identificado o la lista de socios
// (setUsuarioActual y listenSocios).
export function aplicarPermisosDeVista() {
  const soloSocios = !esSocio();
  $('.tabbtn[data-tab="balance"]').classList.toggle("hidden", soloSocios);
  $("#ajustes-export-card").classList.toggle("hidden", soloSocios);
  // Si justo estaba parado en Balance (ej. venía de otro usuario en el
  // mismo celular), se lo manda a Gastos para que no quede mirando una
  // pestaña que ya no le corresponde.
  if (soloSocios && $("#tab-balance").classList.contains("active")) {
    switchTab("gastos");
  }
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

export function cambiarUsuario() {
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

export function closePinModal() {
  $("#modal-pin").classList.remove("active");
  pinFlowNombre = null;
}

export async function confirmPinModal() {
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
export function renderNegocioCards() {
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

  // En Facturado y Resumen el título es solo el nombre del negocio: la
  // sección va en la segunda línea, fija en el HTML (.topbar-subtitulo).
  // Antes iban juntos en una línea ("Pancho Recreo — Cierre de Turno"),
  // pero con el título agrandado eso no entraba en ningún ancho de
  // celular y se partía solo a mitad de frase.
  $("#facturado-titulo").textContent = biz.nombre;
  $("#facturado-icon-badge").textContent = biz.emoji;
  $("#facturado-icon-badge").style.background = biz.color;

  // Pantalla "Resumen mensual" — badge del topbar
  $("#resumen-titulo").textContent = biz.nombre;
  $("#resumen-icon-badge").textContent = biz.emoji;
  $("#resumen-icon-badge").style.background = biz.color;

  // Pantalla "Gastos S/Admin" — badge del topbar (mismo criterio que
  // Facturado/Resumen: negocio arriba, sección fija abajo en el HTML).
  $("#gastos-admin-titulo").textContent = biz.nombre;
  $("#gastos-admin-icon-badge").textContent = biz.emoji;
  $("#gastos-admin-icon-badge").style.background = biz.color;

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
    // El colaborador no ve la pestaña Balance (ver aplicarPermisosDeVista),
    // así que a él no se le promete "el balance entre socios".
    { id: "gastos", emoji: "🧾", nombre: "Gastos",
      sub: esSocio() ? "Cargar gastos y ver el balance entre socios" : "Cargar y ver los gastos del negocio" },
    { id: "facturado", emoji: "💰", nombre: "Cierre de Turno", sub: "Anotar lo que se facturó cada día" },
    { id: "resumen", emoji: "📊", nombre: "Resumen mensual", sub: "Ver los totales de cada mes" },
    { id: "gastosadmin", emoji: "🔒", nombre: "Gastos S/Admin", sub: "Sueldos y otros gastos privados", soloAdmin: true },
    { id: "ideas", emoji: "💡", nombre: "Ideas/Metas", sub: "Para mejorar este negocio" }
  ];

  const wrap = $("#seccion-cards");
  wrap.innerHTML = "";
  // Resumen mensual (facturado, gastos totales y rentabilidad del
  // negocio) es solo para los socios. El colaborador no pierde nada de
  // lo que necesita: la caja del local la ve en la pestaña Gastos.
  // Gastos S/Admin es solo para admin (ver "Gastos privados" en README).
  SECCIONES.filter(s => (s.id !== "resumen" || esSocio()) && (!s.soloAdmin || esAdmin)).forEach(s => {
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
    resetGastosMesOffset(); // siempre arranca en el mes actual al entrar
    renderGastos();
    renderBalance();
    showScreen("screen-app");
  } else if (id === "facturado") {
    resetFacturadoMesOffset(); // siempre arranca en el mes actual al entrar
    renderFacturado();
    showScreen("screen-facturado");
  } else if (id === "resumen") {
    // Resumen mensual es solo para socios (ver esSocio() y el comentario
    // en renderSeccionCards) — la tarjeta ya está escondida para un
    // colaborador, esto es además una segunda puerta por si algo llega a
    // llamar selectSeccion("resumen") directo.
    if (!esSocio()) return;
    resetResumenMesOffset();
    renderResumen();
    showScreen("screen-resumen");
  } else if (id === "gastosadmin") {
    // Segunda puerta por si algo llega a llamar selectSeccion("gastosadmin")
    // directo — la tarjeta ya está escondida para quien no sea admin (ver
    // renderSeccionCards), mismo criterio que "resumen" arriba.
    if (!esAdmin) return;
    resetGastosAdminMesOffset();
    renderGastosAdmin();
    showScreen("screen-gastos-admin");
  } else if (id === "ideas") {
    renderIdeas();
    showScreen("screen-ideas");
  }
}

export function volverASeccion() {
  const biz = NEGOCIOS.find(n => n.id === negocioActual);
  if (biz) renderSeccionCards(biz);
  showScreen("screen-seccion");
}

// Atajo (⚙️) en "Elegir sección" — misma pantalla de Ajustes que la
// pestaña de abajo en Gastos/Balance/Ajustes, sin pasar primero por
// Gastos. No hace falta un render explícito: todas las pantallas se
// redibujan solas con cada cambio en Firestore (ver bootApp()).
export function irAAjustesDirecto() {
  switchTab("ajustes");
  showScreen("screen-app");
}
