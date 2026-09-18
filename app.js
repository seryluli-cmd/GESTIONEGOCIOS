// ============================================================
// Gastos del Negocio — lógica de la app (PWA + Firebase)
// ============================================================

import {
  $, $$, money, montoOCargando, parseMoneyInput, formatMoneyValue,
  formatMoneyInputMientrasTipea, wireMoneyInput, debounce,
  MESES, mesLabel, fechaDeRegistro, fechaLocalISO, compressImage,
  showToast, showScreen, LS_TEMA_KEY, MQ_OSCURO, esOscuroSegunTema,
  aplicarTema, elegirTema, escapeHtml, csvEscape, downloadCSV,
  conTimeout, switchTab
} from "./js/utilidades.js";
import {
  fbSdk, loadFirebaseSdk, fbApp, auth, db, storage,
  parseFirebaseConfig, initFirebase
} from "./js/firebase-sdk.js";
import {
  negocioTieneCajaLocal, categoriasDelNegocio, aplicarConfigSocios, connectAndBoot,
  gastosDelNegocio, facturacionesDelNegocio, reposicionesDelNegocio, ideasDelNegocio,
  listenSocios, listenGastos, listenFacturacion, listenReposiciones, listenIdeas,
  setSyncOffline, listenConnectivity, setClaveMaestraLocal, marcarCajaLocalMigrada,
  categoriasGasto, categoriasGastoSembrado, socios, colaboradores, colaboradorNegocio,
  admins, pins, claveMaestraAdmin, cajaLocalMonto, gastos, facturaciones, reposiciones,
  reposicionesCargadas, ideas
} from "./js/datos.js";
import {
  resumeSession, renderNegocioCards, esSocio, cargarHistorialLogins, cambiarUsuario,
  closePinModal, confirmPinModal, volverASeccion, irAAjustesDirecto,
  usuarioActual, esAdmin, negocioActual, pinFlowMode
} from "./js/sesion.js";
import {
  esGastoCaja, pintarQueda, cajaLocalCalculo, renderCajaLocalCard, renderCajaLocalDetalle,
  openModalReposicion, closeModalReposicion, saveReposicion, deleteReposicion
} from "./js/caja-local.js";
import {
  renderGastos, renderGastosAdmin, crearFilaExpenseItem, crearFilaGasto, fotosDeGasto,
  abrirVisorFotos, visorFotosMover, closeModalVisorFotos, wireVisorFotosZoom,
  verDetalleGasto, closeModalDetalleGasto
} from "./js/gastos.js";
import {
  renderPagadorChips, setDefaultFecha, renderFotoStrip, selectFormaPago,
  registrarEdicionMixto, calcularCampoMixtoFaltante, openModal, closeModal,
  saveGasto, deleteGasto, marcarAbonado, fotosGastoModal, fotosGastoABorrar
} from "./js/modal-gasto.js";
import { renderFacturado } from "./js/facturado.js";


// ---------- Estado ----------
// Config de Firebase de este negocio (proyecto "controlnegocios-7b552") —
// la comparten Pancho Recreo y Heladería Pablo, es la misma para todos los
// dispositivos (socios y colaboradores), así que viene incluida de una vez
// y nadie tiene que pegarla a mano en el primer inicio (ver
// attemptReconnect). Si algún día hace falta cambiar de proyecto, alcanza
// con reemplazar este objeto.
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCxB5Rn_gtKYTo1O_iDmUrLtQP-9caVWwo",
  authDomain: "controlnegocios-7b552.firebaseapp.com",
  projectId: "controlnegocios-7b552",
  storageBucket: "controlnegocios-7b552.firebasestorage.app",
  messagingSenderId: "318057443268",
  appId: "1:318057443268:web:5ef716519070644968fe91"
};
export const LS_CONFIG_KEY = "gn_firebaseConfig";
export const LS_SOCIOS_CACHE = "gn_socios_cache";
export const LS_COLAB_CACHE = "gn_colaboradores_cache";
const SERIES_VARS = ["--series-1", "--series-2", "--series-3"];
const COLAB_VARS = ["--colab-1", "--colab-2", "--colab-3"];
export const NEUTRAL_VAR = "var(--text-muted)";

// Los 2 negocios. Cada gasto queda etiquetado con uno de estos "id",
// y tanto la lista de gastos como el balance se calculan por separado
// para cada negocio (mismos 3 socios, cuentas independientes).
export const NEGOCIOS = [
  { id: "pancho", nombre: "Pancho Recreo", emoji: "🌭", color: "var(--biz-pancho)", tieneCajaLocal: true },
  { id: "heladeria", nombre: "Heladería Pablo", emoji: "🍦", color: "var(--biz-heladeria)", tieneCajaLocal: false }
];


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

export const MAX_FOTOS_GASTO = 5; // una factura de varias hojas puede necesitar más de una foto — ver fotosDeGasto()
let selectedFotoFacturadoBlob = null; // foto comprimida, lista para subir (modal de Cierre de Turno — sigue siendo una sola, no forma parte de este cambio)
const FOTO_RETENCION_DIAS = 120; // ~4 meses — pasado esto, se borra sola la foto (no el gasto)
let selectedRegistrador = null;
let resumenMesOffset = 0;  // 0 = mes actual, -1 = mes anterior, etc. (Resumen mensual)
export let gastosMesOffset = 0;   // ídem, para la pantalla de Gastos — se reinicia a 0 cada vez que se entra
export let facturadoMesOffset = 0; // ídem, para la pantalla de Facturado/Cierre de turno
export let gastosAdminMesOffset = 0; // ídem, para la pantalla de Gastos S/Admin
// Setters para selectSeccion() (sesion.js): reinicia el mes al mes actual
// cada vez que se entra a esa sección — ver el comentario de cada offset.
export function resetResumenMesOffset() { resumenMesOffset = 0; }
export function resetGastosMesOffset() { gastosMesOffset = 0; }
export function resetFacturadoMesOffset() { facturadoMesOffset = 0; }
export function resetGastosAdminMesOffset() { gastosAdminMesOffset = 0; }
let pendingFirebaseConfig = null; // config guardada entre el paso 1 y 2 del setup inicial
let editingCierreId = null;     // id del cierre que se está editando en el modal, o null si es uno nuevo



function socioColorVar(index) {
  return `var(${SERIES_VARS[index % SERIES_VARS.length]})`;
}

function colaboradorColorVar(index) {
  return `var(${COLAB_VARS[index % COLAB_VARS.length]})`;
}

// Color de identidad para cualquier "pagador": los 3 socios tienen su color
// categórico propio (SERIES_VARS); los colaboradores tienen el suyo aparte
// (COLAB_VARS, paleta distinta a propósito — ver el comentario en
// styles.css) para que se los distinga entre sí sin que un colaborador se
// confunda visualmente con un socio. Si el nombre no es ni socio ni
// colaborador actual (ej. alguien que ya no está en config/socios pero
// quedó en el historial de logeos), cae al gris neutro.
export function payerColorVar(name) {
  const idxSocio = socios.indexOf(name);
  if (idxSocio !== -1) return socioColorVar(idxSocio);
  const idxColab = colaboradores.indexOf(name);
  if (idxColab !== -1) return colaboradorColorVar(idxColab);
  return NEUTRAL_VAR;
}

export function socioInitial(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

export function allPagadores() {
  return socios.concat(colaboradores);
}


// ---------- Boot principal (ya configurado) ----------
export function bootApp() {
  renderPagadorChips();
  renderPagadorChipsFacturado();
  renderAjustesSocios();
  renderNegocioCards();
  // Los 5 listen*() de abajo redibujan TODAS las pantallas (Gastos, Balance,
  // Resumen, Detalle de caja) en cada cambio, no solo la que se está
  // mirando — es a propósito, no un descuido: así cualquier pantalla que
  // se abra después ya está al día, sin tener que acordarse de refrescarla
  // al entrar. Evaluado y decidido no optimizar (volumen real del negocio
  // lo hace imperceptible) — ver "Trampas conocidas" en CLAUDE.md antes de
  // "arreglarlo".
  listenGastos();
  listenFacturacion();
  listenReposiciones();
  listenIdeas();
  listenSocios();
  listenConnectivity();
  setDefaultFecha();
  resumeSession();
}





// ---------- Render: Ideas (checklist compartido) ----------
export function renderIdeas() {
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

export function renderResumen() {
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

  // Rentabilidad = Total Facturado - Gastos del mes. En rojo si da negativo
  // (se gastó más de lo que entró), en verde si da positivo o cero. money()
  // siempre recibe un valor positivo (mismo criterio que el resto de la
  // app, ver computeSettlements) — el signo se antepone a mano para que
  // quede "-$1.234" y no el "$-1.234" que da toLocaleString con negativos.
  const rentabilidad = totalFact - totalGastos;
  const rentabilidadEl = $("#resumen-rentabilidad");
  rentabilidadEl.textContent = (rentabilidad < 0 ? "-" : "") + money(Math.abs(rentabilidad));
  rentabilidadEl.style.color = rentabilidad < 0 ? "var(--critical)" : "var(--good)";

  // Caja del local (hoy solo Pancho): "queda" = total repuesto (colección
  // `reposiciones`, ver cajaLocalCalculo) menos TODOS los gastos con
  // formaPago "caja" (de siempre, no solo del mes elegido — es un pozo
  // que se va vaciando, no un gasto mensual). Esos gastos igual ya están
  // sumados arriba en Total Gastos como cualquier otro, sin excepción.
  const cajaLocalWrap = $("#resumen-caja-local-wrap");
  if (negocioTieneCajaLocal(negocioActual)) {
    cajaLocalWrap.classList.remove("hidden");
    const { repuesto, queda: quedaCaja } = cajaLocalCalculo();
    pintarQueda($("#resumen-caja-local-queda"), quedaCaja);
    $("#resumen-caja-local-repuesto").textContent = montoOCargando(repuesto);
  } else {
    cajaLocalWrap.classList.add("hidden");
  }

  // Mismo desglose Efectivo/Digital que Facturado, pero para Gastos —
  // usa el campo "formaPago" de cada gasto (ver openModal/saveGasto).
  // Gastos sin ese campo (cargados antes de que existiera) cuentan como
  // Efectivo, igual que en la lista de Gastos (ver formaPagoLabel()).
  let totalGastosEfectivo = 0, totalGastosDigital = 0;
  gastosMes.forEach(g => {
    const importe = Number(g.importe) || 0;
    if (g.formaPago === "digital") {
      totalGastosDigital += importe;
    } else if (g.formaPago === "mixto") {
      totalGastosEfectivo += Number(g.montoEfectivo) || 0;
      totalGastosDigital += Number(g.montoDigital) || 0;
    } else {
      totalGastosEfectivo += importe;
    }
  });
  $("#resumen-gastos-efectivo").textContent = money(totalGastosEfectivo);
  $("#resumen-gastos-digital").textContent = money(totalGastosDigital);
  const maxGastosEfectDigital = Math.max(1, totalGastosEfectivo, totalGastosDigital);
  $("#resumen-gastos-bar-efectivo").style.width = Math.round((totalGastosEfectivo / maxGastosEfectDigital) * 100) + "%";
  $("#resumen-gastos-bar-digital").style.width = Math.round((totalGastosDigital / maxGastosEfectDigital) * 100) + "%";

  // El desglose "por categoría" es lo único que se filtra acá para
  // no-admin (a diferencia de totalGastos/rentabilidad arriba, que suman
  // TODO el mes sin excepción) — así alguien sin admin no ve el monto
  // exacto de un gasto marcado "Gasto Admin" (ej. un sueldo puntual)
  // aunque el total general del mes sí sea visible para todos.
  const porCategoria = {};
  gastosMes.forEach(g => {
    if (!esAdmin && g.soloAdmin) return;
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
export async function limpiarFotosVencidas() {
  const limite = Date.now() - FOTO_RETENCION_DIAS * 24 * 60 * 60 * 1000;
  const vencidos = gastos.filter(g => fotosDeGasto(g).length && fechaDeRegistro(g).getTime() < limite);

  for (const g of vencidos) {
    for (const f of fotosDeGasto(g)) {
      if (!f.path) continue;
      try {
        await fbSdk.deleteObject(fbSdk.ref(storage, f.path));
      } catch (e) {
        console.warn("No se pudo borrar la foto vencida (puede que ya no exista):", e.message);
      }
    }
    try {
      await fbSdk.updateDoc(fbSdk.doc(db, "gastos", g.id), {
        fotos: fbSdk.deleteField(),
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
    .filter(g => fotosDeGasto(g).length)
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

  // Una miniatura por FOTO, no por gasto — un gasto con una factura de
  // varias hojas muestra sus varias páginas acá. Tocar cualquiera abre
  // el visor ya parado en esa foto, con las demás del mismo gasto al lado.
  grupos.forEach(grupo => {
    const section = document.createElement("div");
    section.className = "fotos-grupo";
    let totalFotos = 0;
    const grid = grupo.items.map(g => {
      const fotosG = fotosDeGasto(g);
      totalFotos += fotosG.length;
      return fotosG.map((f, idx) => `
        <button type="button" class="foto-thumb-link" data-id="${g.id}" data-idx="${idx}" aria-label="Ver foto: ${escapeHtml(g.descripcion || "")}">
          <img class="foto-thumb" src="${escapeHtml(f.url)}" alt="Factura: ${escapeHtml(g.descripcion || "")}" loading="lazy">
        </button>
      `).join("");
    }).join("");
    section.innerHTML = `
      <div class="fotos-grupo-titulo">${escapeHtml(grupo.label)} — ${totalFotos} foto${totalFotos === 1 ? "" : "s"}</div>
      <div class="fotos-grid">${grid}</div>
    `;
    wrap.appendChild(section);
  });
}

// ---------- Render: Balance ----------
export function renderBalance() {
  // La pestaña Balance está escondida para un colaborador (ver
  // aplicarPermisosDeVista()), pero esta función se llama igual desde
  // selectSeccion("gastos")/listenGastos()/listenSocios() sin preguntar
  // quién está mirando — sin este guard, la plata entre socios quedaba
  // igual calculada y pintada en el DOM (visible por "Ver código fuente"
  // aunque el botón de la pestaña no se vea). Se vacía en vez de solo no
  // actualizar, para no dejar pegado un balance de otro socio en un
  // celular compartido.
  if (!esSocio()) {
    $("#total-historico").textContent = "";
    $("#socios-totales").innerHTML = "";
    $("#settlements").innerHTML = "";
    return;
  }
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
    const color = colaboradorColorVar(idx);
    card.innerHTML = `
      <div class="socio-total-row">
        <div class="socio-total-name">
          <span class="socio-dot" style="background:${color}"></span>
          ${escapeHtml(nombre)}
        </div>
        <div class="socio-total-amount">${money(porColaborador[idx])}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
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


// Chips de "¿Quién lo cargó?" en el modal de Facturado.
export function renderPagadorChipsFacturado() {
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
export function renderAjustesSocios() {
  const wrap = $("#ajustes-socios-list");
  wrap.innerHTML = "";
  socios.forEach((nombre, idx) => {
    const row = document.createElement("div");
    row.className = "ajustes-socio-row";
    const esAdminSocio = admins.includes(nombre);
    const badge = esAdminSocio ? `<span class="admin-badge">Admin</span>` : "";
    // Solo un admin puede sumar/sacar admin a otro socio (ej. Leonel, que
    // no lo era) — no a sí mismo, para que nadie se quede sin ningún
    // admin activo por accidente.
    const adminToggleBtn = esAdmin && nombre !== usuarioActual
      ? `<button type="button" class="icon-btn admin-toggle-btn" data-nombre="${escapeHtml(nombre)}" aria-label="${esAdminSocio ? "Quitar admin" : "Hacer admin"}" title="${esAdminSocio ? "Quitar admin" : "Hacer admin"}" style="margin-left:auto;">${esAdminSocio ? "🛡️" : "🔓"}</button>`
      : "";
    row.innerHTML = `<span class="socio-dot" style="background:${socioColorVar(idx)}"></span> ${escapeHtml(nombre)} ${badge}${adminToggleBtn}`;
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
    colaboradores.forEach((nombre, idx) => {
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
      row.innerHTML = `<span class="socio-dot" style="background:${colaboradorColorVar(idx)}"></span> ${escapeHtml(nombre)}`;
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
  renderAjustesCategorias();

  // Historial de logeos: escondido para todos salvo Sergio, aunque Pola y
  // Leonel también sean admin (ver registrarLogin/cargarHistorialLogins).
  const esSergio = usuarioActual === "Sergio";
  $("#ajustes-historial-logins-card").classList.toggle("hidden", !esSergio);
  if (esSergio) cargarHistorialLogins();

  $("#ajustes-conn-status").textContent = auth && auth.currentUser
    ? "✅ Conectado — los gastos se sincronizan entre todos los celulares."
    : "⚠️ No conectado.";
}

// Lista de categorías de gasto del negocio actual en Ajustes — solo la
// ve/edita el admin (crear, borrar). Cada negocio tiene su propia lista
// (ver categoriasGasto/categoriasDelNegocio más arriba), así que esto
// siempre opera sobre negocioActual. Son simples nombres, sin noción de
// privacidad acá — lo privado es el checkbox "Gasto Admin" de cada gasto
// individual.
function renderAjustesCategorias() {
  $("#ajustes-categorias-card").classList.toggle("hidden", !esAdmin);
  if (!esAdmin) return;

  const biz = NEGOCIOS.find(n => n.id === negocioActual);
  $("#ajustes-categorias-negocio-nombre").textContent = biz ? biz.nombre : "este negocio";

  const wrap = $("#ajustes-categorias-list");
  wrap.innerHTML = "";
  categoriasDelNegocio(negocioActual).forEach((nombre) => {
    const row = document.createElement("div");
    row.className = "ajustes-socio-row";
    row.innerHTML = `
      ${escapeHtml(nombre)}
      <button type="button" class="icon-btn danger categoria-remove-btn" data-nombre="${escapeHtml(nombre)}" aria-label="Borrar categoría" style="margin-left:auto;">🗑️</button>`;
    wrap.appendChild(row);
  });
}

async function agregarCategoriaDesdeAjustes() {
  const input = $("#input-nueva-categoria");
  const nombre = input.value.trim();
  if (!nombre) return;
  const actuales = categoriasDelNegocio(negocioActual);
  if (actuales.includes(nombre)) {
    showToast("Esa categoría ya existe.");
    return;
  }
  const nuevas = actuales.concat([nombre]);
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "config", "socios"), { [`categoriasGasto.${negocioActual}`]: nuevas });
    input.value = "";
    showToast("Categoría agregada ✅");
  } catch (e) {
    console.error(e);
    showToast("No se pudo agregar. Revisá tu conexión.");
  }
}

// Borrar una categoría no toca los gastos que ya la tienen cargada (queda
// el nombre guardado tal cual, ver renderCategoriaOptions) — solo deja de
// poder elegirse para gastos nuevos.
async function quitarCategoria(nombre) {
  if (!confirm(`¿Borrar la categoría "${nombre}"? Los gastos que ya la tienen cargada no cambian, solo no se va a poder elegir de nuevo.`)) return;
  const nuevas = categoriasDelNegocio(negocioActual).filter(c => c !== nombre);
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "config", "socios"), { [`categoriasGasto.${negocioActual}`]: nuevas });
    showToast("Categoría borrada");
  } catch (e) {
    console.error(e);
    showToast("No se pudo borrar. Revisá tu conexión.");
  }
}

// Agregar un colaborador nuevo DESPUÉS del setup inicial (a diferencia de
// los que se cargan en la pantalla de configuración de la primera vez,
// ver addColaboradorRow() más abajo) — para cuando se suma alguien
// (ej. una colaboradora nueva) mientras el negocio ya está andando.
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

// Sumar/sacar admin a un socio (ej. Leonel, que empezó sin permiso para
// editar/borrar gastos y cierres) — cualquier admin actual puede hacerlo
// desde Ajustes (ver botón 🔓/🛡️ en renderAjustesSocios). No se puede
// tocar a uno mismo (ver ese mismo render) para que nadie se quede sin
// ningún admin activo por accidente.
async function toggleAdminSocio(nombre) {
  const yaEsAdmin = admins.includes(nombre);
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "config", "socios"), {
      admins: yaEsAdmin ? fbSdk.arrayRemove(nombre) : fbSdk.arrayUnion(nombre)
    });
    showToast(yaEsAdmin ? `${nombre} ya no es admin` : `${nombre} ahora es admin ✅`);
  } catch (e) {
    console.error(e);
    showToast("No se pudo actualizar. Revisá tu conexión.");
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
    setClaveMaestraLocal(nueva);
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

function exportGastosCSV() {
  const rows = [["Fecha", "Categoría", "Descripción", "Importe", "Pagado por", "Forma de pago", "Efectivo", "Digital", "Nota"]];
  gastosDelNegocio()
    .filter(g => esAdmin || !g.soloAdmin)
    .slice()
    .sort((a, b) => fechaDeRegistro(a) - fechaDeRegistro(b))
    .forEach(g => {
      rows.push([
        fechaDeRegistro(g).toLocaleDateString("es-AR"),
        g.categoria || "Otros",
        g.descripcion || "",
        Number(g.importe) || 0,
        g.pagadoPor || "",
        g.formaPago || "efectivo",
        g.formaPago === "mixto" ? Number(g.montoEfectivo) || 0 : "",
        g.formaPago === "mixto" ? Number(g.montoDigital) || 0 : "",
        g.nota || ""
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

function resetFotoFieldFact() {
  selectedFotoFacturadoBlob = null;
  $("#input-foto-fact").value = "";
  $("#foto-preview-wrap-fact").classList.add("hidden");
  $("#foto-btns-row-fact").classList.remove("hidden");
}


// ---------- Modal: agregar cierre de Facturado ----------
// Pancho y Heladería a veces siguen abiertos hasta las 3am — si alguien
// carga el Cierre de Turno a esa hora, la fecha "de hoy" en realidad
// todavía es la noche de AYER (el turno arrancó el día anterior). Sin
// este ajuste quedaría fechado un día después de cuando realmente
// funcionó el negocio. No es una franja dudosa: un cierre real JAMÁS se
// carga entre la madrugada y el mediodía (a esa hora el negocio ni
// abrió), así que hasta el mediodía siempre es el cierre de ayer, sin
// excepción — recién a partir de esa hora "hoy" vuelve a ser hoy.
function fechaSugeridaCierre() {
  const hoy = new Date();
  if (hoy.getHours() < 12) {
    const ayer = new Date(hoy);
    ayer.setDate(ayer.getDate() - 1);
    return ayer;
  }
  return hoy;
}

function setDefaultFechaFact() {
  $("#input-fecha-fact").value = fechaLocalISO(fechaSugeridaCierre());
}

// Aviso "Caja faltante" (ver renderFacturado): la regla, tal como la
// pidieron, es con ejemplo concreto — turno del día 1: si a las 5hs
// del día 2 el cierre todavía no está cargado, RECIÉN a partir de ese
// horario se marca "Caja faltante" (ni un minuto antes). O sea: se
// chequea el cierre de AYER (hoy menos 1 día), nunca de hoy. OJO: a
// propósito NO reutiliza fechaSugeridaCierre() para esto (aunque las
// dos funciones suenan parecido) — esa otra función devuelve HOY
// pasado el mediodía, pensada para precargar la fecha al tocar "+" a
// mano; si este aviso la reutilizara, pasado el mediodía "diaEsperado"
// saltaría a hoy: mostraría "Caja faltante" de un día que todavía ni
// terminó (bug real que pasaba). Si todavía no existe un cierre con
// esa fecha para el negocio actual, devuelve esa fecha; si ya se cargó
// o todavía no son las 5am, devuelve null (no hay nada que avisar).
export function cierreFaltanteHoy() {
  const hoy = new Date();
  if (hoy.getHours() < 5) return null;
  const diaEsperado = new Date(hoy);
  diaEsperado.setDate(diaEsperado.getDate() - 1);
  const yaCargado = facturacionesDelNegocio().some(f => {
    const fecha = fechaDeRegistro(f);
    return fecha.getFullYear() === diaEsperado.getFullYear()
      && fecha.getMonth() === diaEsperado.getMonth()
      && fecha.getDate() === diaEsperado.getDate();
  });
  return yaCargado ? null : diaEsperado;
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
    total: parseMoneyInput($("#input-importe-fact").value),
    efectivo: parseMoneyInput($("#input-efectivo-fact").value),
    digital: parseMoneyInput($("#input-digital-fact").value),
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
  $("#" + FACTURADO_CAMPO_ID[faltante]).value = formatMoneyValue(Math.round(resultado * 100) / 100);
}

// Red de seguridad para saveCierre(): en iPhone, tocar "Guardar" justo
// después de tipear el segundo campo puede disparar el click del botón
// ANTES que el "change" de ese campo (bug conocido de Safari en iOS: en
// algunos casos dispara el click de un botón antes que el blur/change
// del input que tenía el foco). Si eso pasa, calcularCampoFaltanteFacturado()
// todavía no corrió y el tercer campo llega vacío al guardar, aunque el
// usuario ya haya completado los 2 que tenía que completar — se veía
// como "por más que completo 2 campos no se completa el tercero". Se
// fuerza acá el mismo cálculo (nunca se duplica la cuenta) si falta
// justo uno de los tres.
function asegurarCampoFaltanteFacturadoAntesDeGuardar() {
  const campos = ["total", "efectivo", "digital"];
  const vacios = campos.filter(c => $("#" + FACTURADO_CAMPO_ID[c]).value.trim() === "");
  if (vacios.length === 1) {
    facturadoUltimosEditados = campos.filter(c => c !== vacios[0]);
    calcularCampoFaltanteFacturado();
  }
}

// Sin argumento: alta de un cierre nuevo. Con un cierre existente: edición
// (solo admin, ver botón ✏️ en renderFacturado).
// Sin argumento: alta de un cierre nuevo (usa la fecha "sugerida" de
// hoy). Con un cierre existente: edición. Con "presetFecha" (Date): alta
// para una fecha puntual — ver botón "Cargar" del aviso "Caja faltante"
// en renderFacturado().
function openModalFacturado(cierre, presetFecha) {
  editingCierreId = cierre ? cierre.id : null;
  // Cierre nuevo: se registra directo a nombre de quien está logueado
  // (mismo criterio que "Nuevo gasto" — ver openModal()) — el selector
  // de chips solo se muestra al EDITAR un cierre ya cargado (admin-only),
  // por si hace falta corregir quién lo cargó en realidad.
  selectedRegistrador = cierre ? cierre.registradoPor : usuarioActual;
  $("#campo-registrador").classList.toggle("hidden", !cierre);

  $("#input-importe-fact").value = cierre ? formatMoneyValue(cierre.importe) : "";
  // Cierres cargados ANTES de que existiera el desglose Efectivo/Digital
  // no tienen esos campos guardados — quedan en blanco para que se
  // completen de nuevo (no se puede inventar cómo se repartía antes).
  $("#input-efectivo-fact").value = cierre && cierre.efectivo != null ? formatMoneyValue(cierre.efectivo) : "";
  $("#input-digital-fact").value = cierre && cierre.digital != null ? formatMoneyValue(cierre.digital) : "";
  facturadoUltimosEditados = [];
  if (cierre) {
    $("#input-fecha-fact").value = fechaLocalISO(fechaDeRegistro(cierre));
  } else if (presetFecha) {
    $("#input-fecha-fact").value = fechaLocalISO(presetFecha);
  } else {
    setDefaultFechaFact();
  }

  $("#modal-fact-title").textContent = cierre ? "Editar cierre" : "Nuevo cierre";
  $("#btn-save-facturado").textContent = cierre ? "Guardar cambios" : "Guardar";
  $$("#pagador-options-fact .pagador-chip").forEach(c => c.classList.toggle("selected", c.textContent === selectedRegistrador));
  resetFotoFieldFact(); // editar un cierre no toca su foto salvo que se elija una nueva
  $("#modal-fact-error").classList.add("hidden");
  $("#modal-add-facturado").classList.add("active");
  setTimeout(() => $("#input-importe-fact").focus(), 150);
}

function closeModalFacturado() {
  $("#modal-add-facturado").classList.remove("active");
  editingCierreId = null;
}

async function saveCierre() {
  asegurarCampoFaltanteFacturadoAntesDeGuardar();

  const totalStr = $("#input-importe-fact").value.trim();
  const efectivoStr = $("#input-efectivo-fact").value.trim();
  const digitalStr = $("#input-digital-fact").value.trim();
  const importe = parseMoneyInput(totalStr);
  const efectivo = parseMoneyInput(efectivoStr);
  const digital = parseMoneyInput(digitalStr);
  const fechaStr = $("#input-fecha-fact").value;
  const errEl = $("#modal-fact-error");

  // Los 3 campos se autocompletan entre sí (ver calcularCampoFaltanteFacturado)
  // pero igual hay que exigir que terminen los 3 con un valor antes de
  // guardar (ej. si se borra uno a mano después de que se completó solo).
  if (totalStr === "") {
    errEl.textContent = "Falta llenar el Total.";
    errEl.classList.remove("hidden");
    return;
  }
  if (efectivoStr === "") {
    errEl.textContent = "Falta llenar el Efectivo.";
    errEl.classList.remove("hidden");
    return;
  }
  if (digitalStr === "") {
    errEl.textContent = "Falta llenar el Digital.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!importe || importe <= 0) {
    errEl.textContent = "Ingresá un importe válido.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!Number.isFinite(efectivo) || !Number.isFinite(digital) || efectivo < 0 || digital < 0) {
    errEl.textContent = "Efectivo y Digital tienen que ser números válidos (0 o más).";
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
  btn.textContent = selectedFotoFacturadoBlob ? "Subiendo foto…" : "Guardando…";

  try {
    // Mismo criterio que el guardado de gastos: si la foto falla o tarda
    // demasiado, el cierre se guarda igual sin ella — mejor un cierre sin
    // foto que un cierre perdido.
    let fotoUrl = null, fotoPath = null, fotoFallo = false;
    if (selectedFotoFacturadoBlob) {
      try {
        fotoPath = `cierres/${negocioActual}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
        const storageRef = fbSdk.ref(storage, fotoPath);
        const TIMEOUT_MSG = "La subida de la foto tardó demasiado.";
        await conTimeout(
          fbSdk.uploadBytes(storageRef, selectedFotoFacturadoBlob, { contentType: "image/jpeg" }),
          25000,
          TIMEOUT_MSG
        );
        fotoUrl = await conTimeout(fbSdk.getDownloadURL(storageRef), 15000, TIMEOUT_MSG);
      } catch (fotoErr) {
        console.error("No se pudo subir la foto, se guarda el cierre sin ella:", fotoErr);
        fotoFallo = true;
        fotoPath = null;
      }
      btn.textContent = "Guardando…";
    }

    const data = {
      importe,
      efectivo,
      digital,
      registradoPor: selectedRegistrador,
      negocio: negocioActual,
      fecha: fechaStr ? new Date(fechaStr + "T12:00:00") : fbSdk.serverTimestamp()
    };
    // Solo se tocan fotoUrl/fotoPath si se eligió una foto nueva — al
    // editar, updateDoc no toca los campos que no se le pasan, así que la
    // foto existente queda intacta si no se cambia.
    if (fotoUrl) {
      data.fotoUrl = fotoUrl;
      data.fotoPath = fotoPath;
    }
    if (isEdit) {
      await fbSdk.updateDoc(fbSdk.doc(db, "facturacion", editingCierreId), data);
    } else {
      data.creadoEn = fbSdk.serverTimestamp();
      await fbSdk.addDoc(fbSdk.collection(db, "facturacion"), data);
    }
    closeModalFacturado();
    if (fotoFallo) {
      showToast(isEdit ? "Cierre actualizado, pero no se pudo subir la foto ⚠️" : "Cierre guardado sin la foto (no se pudo subir) ⚠️");
    } else {
      showToast(isEdit ? "Cierre actualizado ✅" : "Cierre guardado ✅");
    }
  } catch (e) {
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = isEdit ? "Guardar cambios" : "Guardar";
  }
}

// Solo accesible desde el botón 🗑️ (esAdmin). Borra también la foto en
// Storage si tenía una (mismo criterio que deleteGasto).
async function deleteCierre(id) {
  if (!confirm("¿Borrar este cierre? No se puede deshacer.")) return;
  const cierre = facturaciones.find(x => x.id === id);
  try {
    if (cierre && cierre.fotoPath) {
      try {
        await fbSdk.deleteObject(fbSdk.ref(storage, cierre.fotoPath));
      } catch (e) {
        console.warn("No se pudo borrar la foto del cierre:", e.message);
      }
    }
    await fbSdk.deleteDoc(fbSdk.doc(db, "facturacion", id));
    showToast("Cierre borrado");
  } catch (e) {
    console.error(e);
    showToast("No se pudo borrar. Revisá tu conexión.");
  }
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
      aplicarConfigSocios(snap.data());
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
    const colaboradorNegocioNuevo = {};
    colabInputs.forEach(c => { if (c.negocio) colaboradorNegocioNuevo[c.nombre] = c.negocio; });
    const sociosNuevos = names.map(n => n.trim());
    // Clave compartida para que los admins creen su PIN la primera vez
    // (ver openPinModal/confirmPinModal) — cada uno la puede cambiar
    // después desde Ajustes, sin afectar los PIN ya creados.
    aplicarConfigSocios({
      socios: sociosNuevos,
      colaboradores: colabInputs.map(c => c.nombre),
      colaboradorNegocio: colaboradorNegocioNuevo,
      admins: sociosNuevos.filter((_, idx) => adminFlags[idx]),
      pins: {},
      claveMaestraAdmin: "llavez"
    });
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

// ---------- Service worker + actualización automática ----------
// La app queda instalada en el celular y guarda una copia del código para
// poder abrir sin internet (ver service-worker.js). El efecto colateral es
// que una versión nueva no se ve hasta que la pantalla se recarga, y una
// PWA instalada casi nunca se cierra de verdad: se suspende y se retoma,
// así que puede quedarse semanas mostrando código viejo. Pasó de verdad:
// un socio siguió viendo la app sin la Caja del local mucho después de
// publicarla, y no hay forma de pedirle a cada persona que la cierre a
// mano cada vez que se sube un cambio.
//
// Por eso acá se actualiza sola: se pregunta si hay versión nueva al
// abrir y cada vez que se vuelve a la app, y cuando el service worker
// nuevo toma el control se recarga la pantalla una sola vez.
if ("serviceWorker" in navigator) {
  // Un cambio de controlador significa "salió una versión nueva"... salvo
  // el primero de todos, que es la instalación inicial (ahí no hay nada
  // viejo que reemplazar, y recargar haría que la app se reinicie sola la
  // primera vez que alguien la abre).
  //
  // OJO: esto tiene que ser una variable que se ACTUALIZA, no una foto del
  // momento de cargar. En la primera visita todavía no hay controlador, así
  // que si se dejara fija en `false` nunca se recargaría por más versiones
  // que se publiquen — es exactamente el bug que tenía este bloque.
  let controlada = !!navigator.serviceWorker.controller;
  let recargaPendiente = false;
  let recargando = false;

  // No cortar a alguien que está a medio cargar un gasto: si hay un modal
  // abierto se espera, y se reintenta cuando vuelve a la app. En el peor
  // caso la actualización entra la próxima vez que la abra.
  function recargarSiNoMolesta() {
    if (!recargaPendiente || recargando) return;
    if (document.querySelector(".modal-overlay.active")) return;
    recargando = true;
    location.reload();
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlada) {
      controlada = true;  // era la instalación inicial; de acá en más, sí
      return;
    }
    recargaPendiente = true;
    recargarSiNoMolesta();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        reg.update();            // ¿hay versión nueva publicada?
        recargarSiNoMolesta();   // ¿quedó una pendiente de antes?
      });
    }).catch(console.warn);
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
  $$(".tema-btn").forEach(b => b.addEventListener("click", () => elegirTema(b.dataset.tema)));
  $("#btn-atajo-ajustes").addEventListener("click", irAAjustesDirecto);
  aplicarTema(localStorage.getItem(LS_TEMA_KEY) || "auto");
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
  $("#btn-cerrar-detalle-gasto").addEventListener("click", closeModalDetalleGasto);
  $("#modal-detalle-gasto").addEventListener("click", (e) => {
    if (e.target.id === "modal-detalle-gasto") closeModalDetalleGasto();
  });
  $("#btn-cerrar-visor-fotos").addEventListener("click", closeModalVisorFotos);
  $("#btn-visor-anterior").addEventListener("click", () => visorFotosMover(-1));
  $("#btn-visor-siguiente").addEventListener("click", () => visorFotosMover(1));
  $("#modal-visor-fotos").addEventListener("click", (e) => {
    if (e.target.id === "modal-visor-fotos") closeModalVisorFotos();
  });
  wireVisorFotosZoom();
  $$("#forma-pago-options .pagador-chip").forEach(chip => {
    chip.addEventListener("click", () => selectFormaPago(chip.dataset.forma));
  });
  // Punto de miles mientras se tipea en los 7 campos de plata de la app
  // (ver formatMoneyInputMientrasTipea) — Gastos (Importe, Mixto), Cierre
  // de Turno (Total, Efectivo, Digital) y la reposición de la Caja del
  // local. Este último reemplazó al campo de Ajustes, que se eliminó al
  // pasar la caja a tener historial propio.
  ["#input-importe", "#input-mixto-efectivo", "#input-mixto-digital",
   "#input-importe-fact", "#input-efectivo-fact", "#input-digital-fact",
   "#input-reposicion-monto"].forEach(wireMoneyInput);
  // "change" (al salir del campo) para que el cálculo sea instantáneo
  // apenas se puede (funciona bien en Android/desktop) + "input" con
  // debounce (ver debounce() más arriba) como red de seguridad para
  // iPhone, donde el "change" no siempre llega a tiempo. El debounce evita
  // calcular con un solo dígito a medio tipear (ver calcularCampoMixtoFaltante).
  const recalcularMixtoEfectivoDebounced = debounce(() => registrarEdicionMixto("efectivo"), 600);
  const recalcularMixtoDigitalDebounced = debounce(() => registrarEdicionMixto("digital"), 600);
  const recalcularMixtoImporteDebounced = debounce(calcularCampoMixtoFaltante, 600);
  $("#input-mixto-efectivo").addEventListener("change", () => registrarEdicionMixto("efectivo"));
  $("#input-mixto-efectivo").addEventListener("input", recalcularMixtoEfectivoDebounced);
  $("#input-mixto-digital").addEventListener("change", () => registrarEdicionMixto("digital"));
  $("#input-mixto-digital").addEventListener("input", recalcularMixtoDigitalDebounced);
  $("#input-importe").addEventListener("change", calcularCampoMixtoFaltante);
  $("#input-importe").addEventListener("input", recalcularMixtoImporteDebounced);
  $("#btn-gastos-mes-anterior").addEventListener("click", () => {
    gastosMesOffset--;
    renderGastos();
  });
  $("#btn-gastos-mes-siguiente").addEventListener("click", () => {
    if (gastosMesOffset >= 0) return;
    gastosMesOffset++;
    renderGastos();
  });
  $("#btn-facturado-mes-anterior").addEventListener("click", () => {
    facturadoMesOffset--;
    renderFacturado();
  });
  $("#btn-facturado-mes-siguiente").addEventListener("click", () => {
    if (facturadoMesOffset >= 0) return;
    facturadoMesOffset++;
    renderFacturado();
  });
  $("#btn-export-gastos").addEventListener("click", exportGastosCSV);
  $("#btn-export-facturacion").addEventListener("click", exportFacturacionCSV);
  $("#btn-refrescar-historial-logins").addEventListener("click", cargarHistorialLogins);
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
  $("#btn-back-to-seccion-gastosadmin").addEventListener("click", volverASeccion);
  $("#btn-gastos-admin-mes-anterior").addEventListener("click", () => {
    gastosAdminMesOffset--;
    renderGastosAdmin();
  });
  $("#btn-gastos-admin-mes-siguiente").addEventListener("click", () => {
    if (gastosAdminMesOffset >= 0) return;
    gastosAdminMesOffset++;
    renderGastosAdmin();
  });
  $("#fab-add-gastos-admin").addEventListener("click", () => openModal(null, { soloAdmin: true }));
  $("#fab-add-facturado").addEventListener("click", () => openModalFacturado());
  $("#btn-cancel-add-facturado").addEventListener("click", closeModalFacturado);
  $("#btn-save-facturado").addEventListener("click", saveCierre);
  $("#modal-add-facturado").addEventListener("click", (e) => {
    if (e.target.id === "modal-add-facturado") closeModalFacturado();
  });
  // "change" (al salir del campo) para que el cálculo sea instantáneo
  // apenas se puede (funciona bien en Android/desktop) + "input" con
  // debounce (ver debounce() más arriba) como red de seguridad para
  // iPhone: ahí el "change" de Efectivo/Digital a veces no llega antes del
  // click de "Guardar" (bug de Safari/WebKit) y el Total quedaba sin
  // calcularse. El debounce evita calcular con un solo dígito a medio
  // terminar (ej. tipear "50000" en Efectivo calculando Digital ni bien se
  // apreta el "5").
  const recalcularFacturadoTotalDebounced = debounce(() => registrarEdicionManualFacturado("total"), 600);
  const recalcularFacturadoEfectivoDebounced = debounce(() => registrarEdicionManualFacturado("efectivo"), 600);
  const recalcularFacturadoDigitalDebounced = debounce(() => registrarEdicionManualFacturado("digital"), 600);
  $("#input-importe-fact").addEventListener("change", () => registrarEdicionManualFacturado("total"));
  $("#input-importe-fact").addEventListener("input", recalcularFacturadoTotalDebounced);
  $("#input-efectivo-fact").addEventListener("change", () => registrarEdicionManualFacturado("efectivo"));
  $("#input-efectivo-fact").addEventListener("input", recalcularFacturadoEfectivoDebounced);
  $("#input-digital-fact").addEventListener("change", () => registrarEdicionManualFacturado("digital"));
  $("#input-digital-fact").addEventListener("input", recalcularFacturadoDigitalDebounced);

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
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // permite elegir el mismo archivo de nuevo más adelante si hace falta
    if (!files.length) return;
    const espacio = MAX_FOTOS_GASTO - fotosGastoModal.length;
    const aProcesar = files.slice(0, Math.max(0, espacio));
    if (files.length > aProcesar.length) {
      showToast(`Máximo ${MAX_FOTOS_GASTO} fotos por gasto.`);
    }
    for (const file of aProcesar) {
      try {
        const blob = await compressImage(file);
        fotosGastoModal.push({ tipo: "nueva", blob, previewUrl: URL.createObjectURL(blob) });
      } catch (err) {
        console.error(err);
        showToast("No se pudo procesar una de las fotos.");
      }
    }
    renderFotoStrip();
  });
  // Quitar una foto de la tira (delegado — la tira se re-dibuja seguido).
  // Si era "existente" (ya guardada), se marca para borrar del Storage
  // recién al confirmar "Guardar" (ver saveGasto) — cancelar el modal no
  // borra nada.
  $("#foto-strip").addEventListener("click", (e) => {
    const btn = e.target.closest(".foto-remove-btn");
    if (!btn) return;
    const [removida] = fotosGastoModal.splice(Number(btn.dataset.idx), 1);
    if (removida.tipo === "existente" && removida.path) fotosGastoABorrar.push(removida.path);
    if (removida.tipo === "nueva") URL.revokeObjectURL(removida.previewUrl);
    renderFotoStrip();
  });

  // Foto del cierre (modal Cierre de Turno) — mismo patrón que la de
  // Nuevo gasto, arriba, pero con sus propios elementos e input.
  $("#btn-tomar-foto-fact").addEventListener("click", () => {
    $("#input-foto-fact").setAttribute("capture", "environment");
    $("#input-foto-fact").click();
  });
  $("#btn-elegir-foto-fact").addEventListener("click", () => {
    $("#input-foto-fact").removeAttribute("capture");
    $("#input-foto-fact").click();
  });
  $("#input-foto-fact").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      selectedFotoFacturadoBlob = await compressImage(file);
      $("#foto-preview-img-fact").src = URL.createObjectURL(selectedFotoFacturadoBlob);
      $("#foto-preview-wrap-fact").classList.remove("hidden");
      $("#foto-btns-row-fact").classList.add("hidden");
    } catch (err) {
      console.error(err);
      showToast("No se pudo procesar la foto.");
    }
  });
  $("#btn-quitar-foto-fact").addEventListener("click", resetFotoFieldFact);

  // Foto, editar y borrar de un gasto ya cargado (delegado, la lista se
  // re-dibuja seguido) — misma lógica para la lista normal de Gastos, el
  // detalle de Caja del local y Gastos S/Admin, que también son filas de
  // gasto (ver CLAUDE.md regla 1).
  const handleGastoListClick = (e) => {
    const fotoBtn = e.target.closest(".foto-link");
    if (fotoBtn) {
      const g = gastos.find(x => x.id === fotoBtn.dataset.id);
      if (g) abrirVisorFotos(fotosDeGasto(g));
      return;
    }
    const editBtn = e.target.closest(".gasto-edit-btn");
    if (editBtn) {
      const g = gastos.find(x => x.id === editBtn.dataset.id);
      if (g) openModal(g);
      return;
    }
    const delBtn = e.target.closest(".gasto-delete-btn");
    if (delBtn) { deleteGasto(delBtn.dataset.id); return; }
    const abonarBtn = e.target.closest(".meta-falta-abonar");
    if (abonarBtn) { marcarAbonado(abonarBtn.dataset.id); return; }
    const verDetalleBtn = e.target.closest(".ver-detalle-btn");
    if (verDetalleBtn) verDetalleGasto(verDetalleBtn.dataset.id);
  };
  $("#expenses-list").addEventListener("click", handleGastoListClick);
  $("#caja-local-detalle-list").addEventListener("click", handleGastoListClick);
  $("#expenses-admin-list").addEventListener("click", handleGastoListClick);

  // Editar y borrar de un cierre ya cargado (delegado, admin)
  $("#facturado-list").addEventListener("click", (e) => {
    const fotoBtn = e.target.closest(".foto-link");
    if (fotoBtn) { window.open(fotoBtn.dataset.url, "_blank", "noopener"); return; }
    const editBtn = e.target.closest(".cierre-edit-btn");
    if (editBtn) {
      const c = facturaciones.find(x => x.id === editBtn.dataset.id);
      if (c) openModalFacturado(c);
      return;
    }
    const delBtn = e.target.closest(".cierre-delete-btn");
    if (delBtn) { deleteCierre(delBtn.dataset.id); return; }
    const cargarBtn = e.target.closest(".btn-cargar-faltante");
    if (cargarBtn) openModalFacturado(null, new Date(cargarBtn.dataset.fecha + "T12:00:00"));
  });

  // Pantalla "Caja del local — Detalle" (botón en la card de Gastos)
  $("#btn-ver-caja-local").addEventListener("click", () => {
    renderCajaLocalDetalle();
    showScreen("screen-caja-local");
  });
  $("#btn-back-from-caja-local").addEventListener("click", () => {
    switchTab("gastos");
    showScreen("screen-app");
  });
  $("#btn-add-reposicion").addEventListener("click", openModalReposicion);
  $("#btn-cancel-reposicion").addEventListener("click", closeModalReposicion);
  $("#btn-save-reposicion").addEventListener("click", saveReposicion);
  $("#modal-add-reposicion").addEventListener("click", (e) => {
    if (e.target.id === "modal-add-reposicion") closeModalReposicion();
  });
  $("#caja-local-reposiciones-list").addEventListener("click", (e) => {
    const delBtn = e.target.closest(".reposicion-delete-btn");
    if (delBtn) deleteReposicion(delBtn.dataset.id);
  });

  // Pantalla "Fotos guardadas" — cada miniatura es una foto puntual de un
  // gasto; tocarla abre el visor en esa foto, con las demás del mismo
  // gasto al lado si tenía varias.
  $("#fotos-grupos").addEventListener("click", (e) => {
    const thumb = e.target.closest(".foto-thumb-link");
    if (!thumb) return;
    const g = gastos.find(x => x.id === thumb.dataset.id);
    if (g) abrirVisorFotos(fotosDeGasto(g), Number(thumb.dataset.idx));
  });
  $("#btn-ver-fotos").addEventListener("click", () => {
    renderFotosGuardadas();
    showScreen("screen-fotos");
  });
  $("#btn-back-to-ajustes").addEventListener("click", () => {
    switchTab("ajustes");
    showScreen("screen-app");
  });

  $("#btn-guardar-clave-maestra").addEventListener("click", guardarClaveMaestra);

  $("#btn-agregar-categoria").addEventListener("click", agregarCategoriaDesdeAjustes);
  $("#ajustes-categorias-list").addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".categoria-remove-btn");
    if (removeBtn) quitarCategoria(removeBtn.dataset.nombre);
  });

  // Agregar colaborador nuevo desde Ajustes (botón oculto para no-admin).
  $("#btn-add-colaborador-ajustes").addEventListener("click", () => openModalColaborador());
  $("#btn-cancel-add-colaborador").addEventListener("click", closeModalColaborador);
  $("#btn-save-colaborador").addEventListener("click", saveColaborador);
  $("#modal-add-colaborador").addEventListener("click", (e) => {
    if (e.target.id === "modal-add-colaborador") closeModalColaborador();
  });

  // Reasignar a qué negocio ve un colaborador, desde Ajustes (solo se
  // renderiza el <select> para el admin — ver renderAjustesSocios()).
  $("#ajustes-socios-list").addEventListener("click", (e) => {
    const adminBtn = e.target.closest(".admin-toggle-btn");
    if (adminBtn) toggleAdminSocio(adminBtn.dataset.nombre);
  });
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

  if (!savedConfig && !DEFAULT_FIREBASE_CONFIG.apiKey) {
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
    const config = savedConfig ? JSON.parse(savedConfig) : DEFAULT_FIREBASE_CONFIG;
    await connectAndBoot(config, socios, colaboradores);
    if (!savedConfig) localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(config));
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
