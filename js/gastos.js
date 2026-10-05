// ============================================================
// Pantalla de Gastos (y Gastos S/Admin): lista mensual, la fila
// compartida con Caja del local, el visor de fotos (con zoom por
// pellizco) y el detalle completo de un gasto.
// ============================================================

import { $, money, mesLabel, fechaDeRegistro, fechaBaseDelMes, esMismoMes, escapeHtml } from "./utilidades.js";
import { gastosDelNegocio, gastos } from "./datos.js";
import { esAdmin } from "./sesion.js";
import { renderCajaLocalCard, esGastoCaja } from "./caja-local.js";
import { gastosMesOffset, gastosAdminMesOffset, payerColorVar, socioInitial } from "../app.js";

// Antes mostraba TODOS los gastos del negocio sin importar el mes (solo
// el total de arriba estaba filtrado por mes actual, lo cual era
// inconsistente e iba acumulando meses viejos mezclados en la lista).
// Ahora, igual que Resumen mensual, se ve un mes a la vez — por defecto
// el actual (ver selectSeccion()) — con flechas para ir a uno anterior
// si hace falta editar o borrar algo viejo.
export function renderGastos() {
  const list = $("#expenses-list");
  const empty = $("#expenses-empty");
  list.innerHTML = "";

  const base = fechaBaseDelMes(gastosMesOffset);
  const targetMonth = base.getMonth();
  const targetYear = base.getFullYear();
  $("#gastos-mes-label").textContent = mesLabel(base);
  const esMesActual = esMismoMes(base, new Date());
  $("#btn-gastos-mes-siguiente").disabled = esMesActual;

  const gastosMes = gastosDelNegocio().filter(g => {
    if (!esAdmin && g.soloAdmin) return false;
    const f = fechaDeRegistro(g);
    return f.getMonth() === targetMonth && f.getFullYear() === targetYear;
  });

  if (!gastosMes.length) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }

  let totalMes = 0;

  gastosMes.forEach(g => {
    totalMes += Number(g.importe) || 0;
    list.appendChild(crearFilaGasto(g));
  });

  $("#total-mes").textContent = money(totalMes);
  renderCajaLocalCard();
}

// Gastos S/Admin: mismo formulario/lista/edición/foto que Gastos común
// (comparte crearFilaGasto y el modal, ver CLAUDE.md regla 1), solo que
// filtrado a los gastos marcados soloAdmin (checkbox "🔒 Gasto Admin" en
// el modal, ver openModal — es un flag por gasto individual, no por
// categoría, así cualquier categoría puede tener gastos públicos y
// privados mezclados) — pantalla propia, visible solo para admin (ver
// SECCIONES en renderSeccionCards), para no mezclar lo privado con la
// lista que ve el resto del equipo. El total del mes SÍ sigue entrando en
// Resumen mensual (que solo filtra el desglose por categoría, no el
// total) — lo único que cambia acá es dónde se ve la lista y quién puede
// verla.
export function renderGastosAdmin() {
  const list = $("#expenses-admin-list");
  const empty = $("#expenses-admin-empty");
  list.innerHTML = "";

  const base = fechaBaseDelMes(gastosAdminMesOffset);
  const targetMonth = base.getMonth();
  const targetYear = base.getFullYear();
  $("#gastos-admin-mes-label").textContent = mesLabel(base);
  const esMesActual = esMismoMes(base, new Date());
  $("#btn-gastos-admin-mes-siguiente").disabled = esMesActual;

  const gastosMes = gastosDelNegocio().filter(g => {
    if (!g.soloAdmin) return false;
    const f = fechaDeRegistro(g);
    return f.getMonth() === targetMonth && f.getFullYear() === targetYear;
  });

  empty.classList.toggle("hidden", gastosMes.length > 0);

  let totalMes = 0;
  gastosMes.forEach(g => {
    totalMes += Number(g.importe) || 0;
    list.appendChild(crearFilaGasto(g));
  });

  $("#total-mes-admin").textContent = money(totalMes);
}

// Arma el <li> genérico de una fila tipo "expense-item" (avatar + info +
// monto + acciones abajo) — lo usan tanto los gastos (crearFilaGasto) como
// las reposiciones de la caja del local (crearFilaReposicion). Antes cada
// una tenía su propia copia del mismo template HTML (ver CLAUDE.md regla 1);
// ahora cambiar el layout de una fila (ej. dónde van los íconos) se hace acá
// una sola vez y se ve en las dos listas.
//
// Foto/editar/borrar van en su propia fila abajo (`accionesHtml`, ver
// .expense-item-actions en styles.css) en vez de competir con el texto de
// arriba cuando la descripción/nota es larga.
export function crearFilaExpenseItem({ claseExtra, avatarBg, avatarContent, desc, meta, notaHtml, amountText, accionesHtml }) {
  const li = document.createElement("li");
  li.className = "expense-item" + (claseExtra ? ` ${claseExtra}` : "");
  li.innerHTML = `
    <div class="expense-item-top">
      <div class="avatar" style="background:${avatarBg}">${avatarContent}</div>
      <div class="info">
        <div class="desc">${desc}</div>
        <div class="meta">${meta}</div>
        ${notaHtml || ""}
      </div>
      <div class="amount">${amountText}</div>
    </div>
    ${accionesHtml ? `<div class="expense-item-actions">${accionesHtml}</div>` : ""}
  `;
  return li;
}

// Fotos de un gasto, siempre como lista — único lugar que lo calcula
// (CLAUDE.md regla 1). Entiende dos formatos: el nuevo (`fotos: [{url,
// path}, ...]`, hasta MAX_FOTOS_GASTO) y el viejo, de un solo campo
// fotoUrl/fotoPath (gastos cargados antes de este cambio). No hay
// migración en bloque: un gasto viejo se pasa solo al formato nuevo la
// próxima vez que se edita y se guarda (ver saveGasto()).
export function fotosDeGasto(g) {
  if (Array.isArray(g.fotos) && g.fotos.length) return g.fotos;
  if (g.fotoUrl) return [{ url: g.fotoUrl, path: g.fotoPath || null }];
  return [];
}

// ---------- Visor de fotos (una o varias, del mismo gasto) ----------
let visorFotosLista = [];
let visorFotosIndex = 0;

export function abrirVisorFotos(fotos, indexInicial = 0) {
  if (!fotos.length) return;
  visorFotosLista = fotos;
  visorFotosIndex = indexInicial;
  renderVisorFotos();
  $("#modal-visor-fotos").classList.add("active");
}

function renderVisorFotos() {
  const foto = visorFotosLista[visorFotosIndex];
  $("#visor-fotos-img").src = foto.url;
  const varias = visorFotosLista.length > 1;
  $("#visor-fotos-contador").textContent = `${visorFotosIndex + 1} / ${visorFotosLista.length}`;
  $("#visor-fotos-contador").classList.toggle("hidden", !varias);
  $("#btn-visor-anterior").classList.toggle("hidden", !varias);
  $("#btn-visor-siguiente").classList.toggle("hidden", !varias);
  resetVisorZoom();
}

export function visorFotosMover(delta) {
  const n = visorFotosLista.length;
  visorFotosIndex = (visorFotosIndex + delta + n) % n;
  renderVisorFotos();
}

export function closeModalVisorFotos() {
  $("#modal-visor-fotos").classList.remove("active");
  resetVisorZoom();
}

// ---------- Zoom con pellizco del visor de fotos ----------
// No pasa por ninguna variable compartida con el resto de la app: es
// puramente visual y efímero (se resetea solo al cambiar de foto o cerrar
// el visor), no hay otra pantalla que necesite leerlo.
const VISOR_ZOOM_MAX = 4;
let visorZoomScale = 1;
let visorZoomPanX = 0;
let visorZoomPanY = 0;
let visorZoomPinchDistInicial = 0;
let visorZoomPinchScaleInicial = 1;
let visorZoomPaneando = false;
let visorZoomPanStartX = 0;
let visorZoomPanStartY = 0;
let visorZoomPanTouchStartX = 0;
let visorZoomPanTouchStartY = 0;

function resetVisorZoom() {
  visorZoomScale = 1;
  visorZoomPanX = 0;
  visorZoomPanY = 0;
  const img = $("#visor-fotos-img");
  if (img) img.style.transform = "";
}

// Evita que el pellizco arrastre la imagen fuera del recuadro visible —
// el límite depende de cuánto se agrandó (a escala 1 no se puede mover).
function clampVisorZoomPan(viewport) {
  const maxX = Math.max(0, (visorZoomScale - 1) * viewport.offsetWidth / 2);
  const maxY = Math.max(0, (visorZoomScale - 1) * viewport.offsetHeight / 2);
  visorZoomPanX = Math.min(maxX, Math.max(-maxX, visorZoomPanX));
  visorZoomPanY = Math.min(maxY, Math.max(-maxY, visorZoomPanY));
}

function aplicarVisorZoomTransform(img) {
  img.style.transform = visorZoomScale === 1
    ? ""
    : `translate(${visorZoomPanX}px, ${visorZoomPanY}px) scale(${visorZoomScale})`;
}

// Se cablea una sola vez al arrancar la app (ver wireEventListeners) — el
// visor reutiliza siempre el mismo #visor-fotos-viewport/#visor-fotos-img,
// no hace falta recablear en cada abrirVisorFotos().
export function wireVisorFotosZoom() {
  const viewport = $("#visor-fotos-viewport");
  const img = $("#visor-fotos-img");

  viewport.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      const [t1, t2] = e.touches;
      visorZoomPinchDistInicial = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      visorZoomPinchScaleInicial = visorZoomScale;
      visorZoomPaneando = false;
    } else if (e.touches.length === 1 && visorZoomScale > 1) {
      visorZoomPaneando = true;
      visorZoomPanTouchStartX = e.touches[0].clientX;
      visorZoomPanTouchStartY = e.touches[0].clientY;
      visorZoomPanStartX = visorZoomPanX;
      visorZoomPanStartY = visorZoomPanY;
    }
  }, { passive: true });

  viewport.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      visorZoomScale = Math.min(VISOR_ZOOM_MAX, Math.max(1, visorZoomPinchScaleInicial * (dist / visorZoomPinchDistInicial)));
      clampVisorZoomPan(viewport);
      aplicarVisorZoomTransform(img);
    } else if (e.touches.length === 1 && visorZoomPaneando) {
      e.preventDefault();
      visorZoomPanX = visorZoomPanStartX + (e.touches[0].clientX - visorZoomPanTouchStartX);
      visorZoomPanY = visorZoomPanStartY + (e.touches[0].clientY - visorZoomPanTouchStartY);
      clampVisorZoomPan(viewport);
      aplicarVisorZoomTransform(img);
    }
  }, { passive: false });

  viewport.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      visorZoomPaneando = false;
      if (visorZoomScale <= 1) resetVisorZoom();
    } else if (e.touches.length === 1) {
      // Se soltó un dedo del pellizco a dos — si sigue agrandado, seguir
      // paneando con el que queda en vez de cortar el gesto en seco.
      visorZoomPaneando = visorZoomScale > 1;
      visorZoomPanTouchStartX = e.touches[0].clientX;
      visorZoomPanTouchStartY = e.touches[0].clientY;
      visorZoomPanStartX = visorZoomPanX;
      visorZoomPanStartY = visorZoomPanY;
    }
  }, { passive: true });
}

// Arma la fila <li> de un gasto — extraído de renderGastos() para
// reusarlo tal cual en el detalle de Caja del local (renderCajaLocalDetalle),
// que lista TODOS los gastos "caja" del negocio sin importar el mes.
export function crearFilaGasto(g) {
  const fecha = fechaDeRegistro(g);

  const fotoBtn = fotosDeGasto(g).length
    ? `<button type="button" class="foto-link" data-id="${g.id}" aria-label="Ver foto de la factura">📷</button>`
    : "";

  // Editar/borrar solo para el admin — el resto solo puede cargar y ver.
  const adminBtns = esAdmin
    ? `<button type="button" class="icon-btn gasto-edit-btn" data-id="${g.id}" aria-label="Editar gasto">✏️</button>
       <button type="button" class="icon-btn danger gasto-delete-btn" data-id="${g.id}" aria-label="Borrar gasto">🗑️</button>`
    : "";

  // Falta abonar: se tildó porque todavía no se le pagó a quien
  // trajo la mercadería (ej. te dejan pagar unos días después) — la
  // fila queda en rojo. Tocar el aviso lo marca como pagado al toque
  // (guarda directo, sin pasar por el modal de Editar).
  const metaFaltaAbonar = g.faltaAbonar
    ? ` · <button type="button" class="meta-falta-abonar" data-id="${g.id}">⚠️ Falta abonar</button>`
    : "";

  // Este gasto está marcado "Gasto Admin" (checkbox del modal) — en la
  // lista de Gastos común (donde el admin ve todo, público y privado
  // mezclado) esta marca es la única forma de distinguirlo a simple
  // vista, ya que la categoría no implica privacidad. Solo se muestra al
  // admin: quien no sea admin nunca llega a ver este gasto de todos modos.
  const metaSoloAdmin = (esAdmin && g.soloAdmin) ? ` · 🔒 Solo admin` : "";

  // Notas largas hacían la fila del gasto muy alta en el celular — se
  // recortan a las primeras 2 palabras y el resto se ve tocando "Ver
  // detalle completo" (usa data-id, no el texto de la nota, para no
  // tener que escaparla dentro de un atributo HTML — ver verDetalleGasto()).
  const notaPalabras = g.nota ? g.nota.trim().split(/\s+/) : [];
  const notaLarga = notaPalabras.length > 2;
  const notaCorta = notaPalabras.slice(0, 2).join(" ");
  const notaHtml = g.nota
    ? `<div class="meta gasto-nota">📝 ${escapeHtml(notaCorta)}${notaLarga ? `… <button type="button" class="ver-detalle-btn" data-id="${g.id}">Ver detalle completo</button>` : ""}</div>`
    : "";

  // "Caja del local" se destaca en dorado para verla de un vistazo en la
  // lista (ver .expense-item.caja-local en styles.css) — salvo que
  // además tenga "Falta abonar" tildado, que por ser el aviso más
  // urgente de los dos tiene prioridad visual (rojo).
  const claseExtra = g.faltaAbonar ? "falta-abonar" : (esGastoCaja(g) ? "caja-local" : "");

  return crearFilaExpenseItem({
    claseExtra,
    avatarBg: payerColorVar(g.pagadoPor),
    avatarContent: socioInitial(g.pagadoPor),
    desc: escapeHtml(g.descripcion || "Sin descripción"),
    meta: `${fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} · ${escapeHtml(g.categoria || "Otros")} · Pagó ${escapeHtml(g.pagadoPor || "?")} · ${formaPagoLabel(g)}${metaFaltaAbonar}${metaSoloAdmin}`,
    notaHtml,
    amountText: money(g.importe),
    accionesHtml: fotoBtn + adminBtns
  });
}

// Gastos cargados antes de que existiera "forma de pago" no tienen el
// campo — se muestran como Efectivo por default.
function formaPagoLabel(g) {
  if (g.formaPago === "digital") return "💳 Digital";
  if (g.formaPago === "mixto") return `🔀 ${money(g.montoDigital)} digital · ${money(g.montoEfectivo)} efectivo`;
  if (esGastoCaja(g)) return "💰 Caja del local";
  return "💵 Efectivo";
}

// Detalle completo de un gasto (ver botón "Ver detalle completo" en
// renderGastos, para notas largas) — un cartel simple en vez de otro
// modal, ya que es solo para leer, no para editar.
export function verDetalleGasto(id) {
  const g = gastos.find(x => x.id === id);
  if (!g) return;
  const fecha = fechaDeRegistro(g).toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

  // Todo por textContent (no innerHTML) — no hace falta escapeHtml, texto
  // plano nunca se interpreta como HTML.
  $("#detalle-gasto-avatar").textContent = socioInitial(g.pagadoPor);
  $("#detalle-gasto-avatar").style.background = payerColorVar(g.pagadoPor);
  $("#detalle-gasto-monto").textContent = money(g.importe);
  $("#detalle-gasto-desc").textContent = g.descripcion || "Sin descripción";
  $("#detalle-gasto-categoria").textContent = g.categoria || "Otros";
  $("#detalle-gasto-abonar").classList.toggle("hidden", !g.faltaAbonar);
  $("#detalle-gasto-fecha").textContent = fecha;
  $("#detalle-gasto-pagador").textContent = g.pagadoPor || "?";
  $("#detalle-gasto-formapago").textContent = formaPagoLabel(g);

  const notaWrap = $("#detalle-gasto-nota-wrap");
  if (g.nota) {
    $("#detalle-gasto-nota-texto").textContent = g.nota;
    notaWrap.classList.remove("hidden");
  } else {
    notaWrap.classList.add("hidden");
  }

  const fotosG = fotosDeGasto(g);
  const fotoBtn = $("#detalle-gasto-foto-btn");
  if (fotosG.length) {
    $("#detalle-gasto-foto-img").src = fotosG[0].url;
    $("#detalle-gasto-foto-label").textContent = fotosG.length > 1 ? `Ver ${fotosG.length} fotos` : "Ver foto completa";
    fotoBtn.onclick = () => abrirVisorFotos(fotosG);
    fotoBtn.classList.remove("hidden");
  } else {
    fotoBtn.onclick = null;
    fotoBtn.classList.add("hidden");
  }

  $("#modal-detalle-gasto").classList.add("active");
}

export function closeModalDetalleGasto() {
  $("#modal-detalle-gasto").classList.remove("active");
}
