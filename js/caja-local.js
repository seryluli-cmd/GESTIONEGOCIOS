// ============================================================
// Caja del local: cuánto se repuso, cuánto se gastó y cuánto queda, más
// la pantalla de Detalle y las reposiciones (registrar/borrar, migración
// del monto inicial viejo). Une dos secciones que en app.js están
// separadas (la tarjeta/detalle vive junto a Gastos, las reposiciones
// tenían su propia sección) porque son el mismo subsistema.
// ============================================================

import { $, $$, money, montoOCargando, parseMoneyInput, fechaLocalISO, fechaDeRegistro, escapeHtml, showToast } from "./utilidades.js";
import { fbSdk, db } from "./firebase-sdk.js";
import {
  gastosDelNegocio, reposicionesDelNegocio, reposiciones, reposicionesCargadas, cajaLocalMonto,
  negocioTieneCajaLocal, marcarCajaLocalMigrada
} from "./datos.js";
import { negocioActual, usuarioActual, esAdmin } from "./sesion.js";
import { NEGOCIOS, NEUTRAL_VAR, payerColorVar, socioInitial, crearFilaExpenseItem, crearFilaGasto } from "../app.js";

// ¿Este gasto salió de la Caja del local? Único lugar que lo pregunta
// (ver CLAUDE.md regla 3: nada de condiciones sueltas comparando
// strings desparramadas por el código).
export function esGastoCaja(g) {
  return g.formaPago === "caja";
}

// Pinta un monto de "queda" con signo y color crítico si es negativo —
// único lugar que arma este template (ver CLAUDE.md regla 1). Usado en
// la card de Gastos, el Detalle de Caja del local y el Resumen mensual.
export function pintarQueda(el, queda) {
  if (queda === null) {
    el.textContent = "…";
    el.style.color = "var(--text-primary)";
    return;
  }
  el.textContent = (queda < 0 ? "-" : "") + money(Math.abs(queda));
  el.style.color = queda < 0 ? "var(--critical)" : "var(--text-primary)";
}

// Cuánto se le puso a la caja y cuánto se gastó, de siempre (no solo
// del mes elegido) — mismo cálculo para la card de Resumen mensual, la
// card de Gastos y el detalle de Caja del local, para no repetirlo.
//
// La única fuente de lo repuesto es la colección `reposiciones` (el
// saldo inicial es una más, ver migrarMontoInicialCaja). Igual se le
// suma `cajaLocalMonto` porque es el campo viejo: vale 0 apenas la
// migración corre, pero mientras no haya corrido —o si un celular
// todavía tiene la config vieja en caché— es plata real que todavía no
// se pasó a `reposiciones`. No se edita desde ningún lado.
//
// `cajaLocalMonto` es GLOBAL (un solo número en config/socios, no uno
// por negocio) y solo puede pertenecer al negocio que hoy tiene caja
// local — sumarlo sin importar cuál es negocioActual lo contaría también
// para cualquier otro negocio que en el futuro tenga su propia caja.
//
// Devuelve todo en `null` mientras `reposiciones` no cargó su primer
// snapshot (reposicionesCargadas): un array vacío por-no-cargado-todavía
// no es lo mismo que "esta caja no tiene reposiciones", y sumar sobre un
// [] vacío daría un "queda" negativo falso apenas se abre la app (antes
// esto quedaba tapado de pura casualidad porque cajaLocalMonto se leía
// aparte y llegaba antes; dejó de tapar nada el día que ese campo se
// migró a 0 para siempre).
export function cajaLocalCalculo() {
  if (!reposicionesCargadas) {
    return { repuesto: null, gastado: null, queda: null, cargando: true };
  }
  const gastado = gastosDelNegocio()
    .filter(esGastoCaja)
    .reduce((sum, g) => sum + (Number(g.importe) || 0), 0);
  const sumaReposiciones = reposicionesDelNegocio()
    .reduce((sum, r) => sum + (Number(r.monto) || 0), 0);
  const negocioDeCajaVieja = NEGOCIOS.find(b => b.tieneCajaLocal);
  const legacy = (negocioDeCajaVieja && negocioDeCajaVieja.id === negocioActual) ? cajaLocalMonto : 0;
  const repuesto = legacy + sumaReposiciones;
  return { repuesto, gastado, queda: repuesto - gastado, cargando: false };
}

// Card "Caja del local" en la pestaña Gastos (además de la que ya
// existía en Resumen mensual) — mismo dato, para no tener que ir a
// Resumen solo para ver cuánto queda. Se llama desde renderGastos()
// para que se actualice cada vez que cambian los gastos o el negocio.
export function renderCajaLocalCard() {
  const wrap = $("#gastos-caja-local-wrap");
  if (!negocioTieneCajaLocal(negocioActual)) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const { repuesto, queda } = cajaLocalCalculo();
  pintarQueda($("#gastos-caja-local-queda"), queda);
  $("#gastos-caja-local-repuesto").textContent = montoOCargando(repuesto);
}

// Pantalla "Caja del local — Detalle" (botón "Detalle" de la card de
// arriba): lista TODOS los gastos "caja" del negocio actual, sin
// importar el mes — mismo criterio que cajaLocalCalculo() (no es un
// gasto mensual, es un pozo que se va vaciando desde que se repuso).
//
// Se llama también desde listenGastos() (no solo desde listenReposiciones()),
// porque esta pantalla lista gastos: si se edita/borra uno "caja" con la
// pantalla abierta, tiene que reflejarse al toque y no quedar vieja hasta
// que cambie algo de reposiciones.
export function renderCajaLocalDetalle() {
  const list = $("#caja-local-detalle-list");
  const empty = $("#caja-local-detalle-empty");
  list.innerHTML = "";

  // Mismo guard que renderCajaLocalCard(): esta función la llaman los
  // listeners de gastos/reposiciones sin importar qué negocio está
  // seleccionado, así que si el actual no tiene caja local no hay nada
  // que mostrar (evita calcular/pintar números de un negocio sin caja).
  if (!negocioTieneCajaLocal(negocioActual)) {
    empty.classList.add("hidden");
    $("#caja-local-reposiciones-list").innerHTML = "";
    return;
  }

  const items = gastosDelNegocio()
    .filter(g => esGastoCaja(g) && (esAdmin || !g.soloAdmin))
    .slice()
    .sort((a, b) => fechaDeRegistro(b) - fechaDeRegistro(a));

  empty.classList.toggle("hidden", items.length > 0);
  items.forEach(g => list.appendChild(crearFilaGasto(g)));

  // Se muestra también cuánto se GASTÓ (no solo lo que queda): la
  // pantalla existe justamente para responder "en qué se fue yendo la
  // caja", así que el total gastado va arriba y el desglose, abajo.
  const { repuesto, gastado, queda } = cajaLocalCalculo();
  pintarQueda($("#caja-local-detalle-queda"), queda);
  $("#caja-local-detalle-gastado").textContent = montoOCargando(gastado);
  $("#caja-local-detalle-repuesto").textContent = montoOCargando(repuesto);

  renderReposiciones();
}

// Arma la fila <li> de una reposición — extraído de renderReposiciones()
// para compartir el mismo template que crearFilaGasto() vía
// crearFilaExpenseItem() (antes eran dos copias del mismo HTML, ver
// CLAUDE.md regla 1).
function crearFilaReposicion(r) {
  const fecha = fechaDeRegistro(r);
  // El saldo inicial no se puede borrar desde acá: es un hecho histórico
  // migrado (ver migrarMontoInicialCaja), no algo que alguien cargó por
  // error — borrarlo haría desaparecer esa plata de "queda" para siempre,
  // sin forma de recuperarla (ver también el guard en deleteReposicion()).
  const borrarBtn = (esAdmin && !r.esInicial)
    ? `<button type="button" class="icon-btn danger reposicion-delete-btn" data-id="${r.id}" aria-label="Borrar reposición">🗑️</button>`
    : "";
  const notaHtml = r.nota
    ? `<div class="meta gasto-nota">📝 ${escapeHtml(r.nota)}</div>`
    : "";
  // El saldo inicial no lo cargó nadie (viene del campo viejo, ver
  // migrarMontoInicialCaja), así que no se le inventa un autor ni se
  // muestra la fecha del día en que se migró, que no significa nada.
  const meta = r.esInicial
    ? "Lo que ya había en la caja"
    : `${fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} · Cargó ${escapeHtml(r.repuestoPor || "?")}`;

  return crearFilaExpenseItem({
    claseExtra: "reposicion",
    avatarBg: r.esInicial ? NEUTRAL_VAR : payerColorVar(r.repuestoPor),
    avatarContent: r.esInicial ? "💰" : socioInitial(r.repuestoPor),
    desc: r.esInicial ? "Saldo inicial" : "Reposición",
    meta,
    notaHtml,
    amountText: `+${money(r.monto)}`,
    accionesHtml: borrarBtn
  });
}

// Historial de reposiciones: la otra mitad del movimiento de la caja (lo
// que ENTRA). Incluye el saldo inicial, que es una reposición más pero
// marcada con esInicial (ver migrarMontoInicialCaja).
function renderReposiciones() {
  const list = $("#caja-local-reposiciones-list");
  const empty = $("#caja-local-reposiciones-empty");
  list.innerHTML = "";

  // El saldo inicial va siempre último aunque su fecha sea la del día en
  // que se migró: es la plata más vieja de la caja, no la más nueva.
  const items = reposicionesDelNegocio()
    .slice()
    .sort((a, b) => {
      if (!!a.esInicial !== !!b.esInicial) return a.esInicial ? 1 : -1;
      return fechaDeRegistro(b) - fechaDeRegistro(a);
    });
  empty.classList.toggle("hidden", items.length > 0);
  // Registrar y borrar reposiciones es solo para admin.
  $("#btn-add-reposicion").classList.toggle("hidden", !esAdmin);

  items.forEach(r => list.appendChild(crearFilaReposicion(r)));
}

// ---------- Reposiciones de la caja del local (solo admin) ----------
// Migración de una sola vez: el "monto inicial" de la caja era un número
// suelto en config/socios (cajaLocalMonto), de cuando todavía no existía
// el historial. Tener dos fuentes para el mismo dato se prestaba a
// contar la plata dos veces, así que se convierte en una reposición más
// y el campo viejo queda en cero (ya no se edita desde ningún lado).
//
// Es seguro correrla de más: el documento tiene un id FIJO, así que si
// varios celulares abren la app a la vez, todos escriben el MISMO doc
// con el mismo monto en vez de crear reposiciones duplicadas.
//
// Las dos escrituras (crear la reposición inicial y poner cajaLocalMonto
// en 0) van en un solo writeBatch, no una atrás de la otra: si fueran
// dos await separados, un onSnapshot de listenReposiciones() podía
// llegar justo entre medio y ver la reposición nueva SUMADA a un
// cajaLocalMonto que todavía no se había puesto en 0 — la caja se
// mostraba con el doble de plata por un instante (bug real que hubo).
// El batch hace que las dos escrituras se vean juntas o ninguna.
let migracionCajaHecha = false;
export async function migrarMontoInicialCaja() {
  if (migracionCajaHecha) return;
  migracionCajaHecha = true;
  if (!cajaLocalMonto) return;
  const negocio = NEGOCIOS.find(b => b.tieneCajaLocal);
  if (!negocio) return;

  const monto = cajaLocalMonto;
  try {
    const batch = fbSdk.writeBatch(db);
    batch.set(fbSdk.doc(db, "reposiciones", `inicial-${negocio.id}`), {
      monto,
      nota: "Plata que ya tenía la caja antes de que existiera este historial.",
      negocio: negocio.id,
      esInicial: true,
      fecha: new Date(),
      creadoEn: fbSdk.serverTimestamp()
    });
    batch.update(fbSdk.doc(db, "config", "socios"), { cajaLocalMonto: 0 });
    await batch.commit();
    marcarCajaLocalMigrada();
  } catch (e) {
    // Si falla (ej. sin señal), se reintenta en la próxima apertura: el
    // total no cambia mientras tanto, porque cajaLocalCalculo() sigue
    // sumando el campo viejo hasta que la migración se complete.
    console.error("No se pudo migrar el monto inicial de la caja:", e);
    migracionCajaHecha = false;
  }
}

export function openModalReposicion() {
  $("#input-reposicion-monto").value = "";
  $("#input-reposicion-nota").value = "";
  $("#input-reposicion-fecha").value = fechaLocalISO();
  $("#modal-reposicion-error").classList.add("hidden");
  $("#modal-add-reposicion").classList.add("active");
  setTimeout(() => $("#input-reposicion-monto").focus(), 150);
}

export function closeModalReposicion() {
  $("#modal-add-reposicion").classList.remove("active");
}

export async function saveReposicion() {
  // parseMoneyInput y no parseFloat: el campo muestra el punto de miles
  // mientras se tipea (ver formatMoneyInputMientrasTipea), así que lo que
  // hay ahí es "200.000", no "200000".
  const monto = parseMoneyInput($("#input-reposicion-monto").value);
  const nota = $("#input-reposicion-nota").value.trim();
  const fechaStr = $("#input-reposicion-fecha").value;
  const errEl = $("#modal-reposicion-error");
  errEl.classList.add("hidden");

  if (!Number.isFinite(monto) || monto <= 0) {
    errEl.textContent = "Ingresá un monto válido.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#btn-save-reposicion");
  btn.disabled = true;
  btn.textContent = "Guardando…";
  try {
    await fbSdk.addDoc(fbSdk.collection(db, "reposiciones"), {
      monto,
      nota,
      negocio: negocioActual,
      repuestoPor: usuarioActual,
      fecha: fechaStr ? new Date(fechaStr + "T12:00:00") : fbSdk.serverTimestamp(),
      creadoEn: fbSdk.serverTimestamp()
    });
    closeModalReposicion();
    showToast("Reposición registrada ✅");
  } catch (e) {
    console.error(e);
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar";
  }
}

// Solo admin (ver botón 🗑️ en renderReposiciones). Borrar una reposición
// baja el total repuesto, así que "queda" se recalcula solo.
export async function deleteReposicion(id) {
  // Defensa extra: aunque renderReposiciones() ya no muestra el botón
  // para el saldo inicial, esta función no depende de la UI para
  // protegerlo — no se puede borrar, es plata que ya estaba, no una
  // reposición cualquiera.
  const r = reposiciones.find(x => x.id === id);
  if (r && r.esInicial) {
    showToast("El saldo inicial no se puede borrar.");
    return;
  }
  if (!confirm("¿Borrar esta reposición? La caja va a quedar con menos plata cargada.")) return;
  try {
    await fbSdk.deleteDoc(fbSdk.doc(db, "reposiciones", id));
    showToast("Reposición borrada");
  } catch (e) {
    console.error(e);
    showToast("No se pudo borrar. Revisá tu conexión.");
  }
}
