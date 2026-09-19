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
import {
  renderPagadorChipsFacturado, resetFotoFieldFact, registrarEdicionManualFacturado,
  openModalFacturado, closeModalFacturado, saveCierre, deleteCierre,
  setSelectedFotoFacturadoBlob
} from "./js/modal-facturado.js";
import {
  renderIdeas, toggleVoto, toggleIdeaEstado, deleteIdea,
  openModalIdea, closeModalIdea, saveIdea
} from "./js/ideas.js";
import { renderResumen, limpiarFotosVencidas, renderFotosGuardadas } from "./js/resumen.js";
import {
  renderAjustesSocios, agregarCategoriaDesdeAjustes, quitarCategoria,
  openModalColaborador, closeModalColaborador, saveColaborador, toggleAdminSocio,
  guardarClaveMaestra, exportGastosCSV, exportFacturacionCSV
} from "./js/ajustes.js";
import {
  addColaboradorRow, handleSetupConnect, handleSetupGuardar, resetLocalConfig
} from "./js/setup.js";
import "./js/pwa.js";


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



export const MAX_FOTOS_GASTO = 5; // una factura de varias hojas puede necesitar más de una foto — ver fotosDeGasto()
export let resumenMesOffset = 0;  // 0 = mes actual, -1 = mes anterior, etc. (Resumen mensual)
export let gastosMesOffset = 0;   // ídem, para la pantalla de Gastos — se reinicia a 0 cada vez que se entra
export let facturadoMesOffset = 0; // ídem, para la pantalla de Facturado/Cierre de turno
export let gastosAdminMesOffset = 0; // ídem, para la pantalla de Gastos S/Admin
// Setters para selectSeccion() (sesion.js): reinicia el mes al mes actual
// cada vez que se entra a esa sección — ver el comentario de cada offset.
export function resetResumenMesOffset() { resumenMesOffset = 0; }
export function resetGastosMesOffset() { gastosMesOffset = 0; }
export function resetFacturadoMesOffset() { facturadoMesOffset = 0; }
export function resetGastosAdminMesOffset() { gastosAdminMesOffset = 0; }



export function socioColorVar(index) {
  return `var(${SERIES_VARS[index % SERIES_VARS.length]})`;
}

export function colaboradorColorVar(index) {
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
      const fotoFact = await compressImage(file);
      setSelectedFotoFacturadoBlob(fotoFact);
      $("#foto-preview-img-fact").src = URL.createObjectURL(fotoFact);
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
