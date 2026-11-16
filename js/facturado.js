import { $, money, mesLabel, fechaLocalISO, fechaDeRegistro, fechaBaseDelMes, esMismoMes, esMismoDia, escapeHtml } from "./utilidades.js";
import { facturacionesDelNegocio, negocioTieneTurnos, negocioCierraEseDia } from "./datos.js";
import { esAdmin, negocioActual } from "./sesion.js";
import { facturadoMesOffset, payerColorVar, socioInitial } from "../app.js";
import {
  cierresFaltantes, nombreTurnoFacturado, nombreCortoTurnoFacturado,
  idsTurnosFacturado, diaDelTurnoEnCurso, diaUsaTurnosFacturado
} from "./modal-facturado.js";

// ---------- Render: Facturado ----------
// Antes mostraba TODOS los cierres del negocio sin importar el mes —
// mismo problema que tenía Gastos. Ahora se ve un mes a la vez, por
// defecto el actual, con flechas para ir a meses anteriores.
//
// Dos formas de listar, según negocioTieneTurnos():
//   - con turnos (Pancho): una fila por día, con el total y lo de cada
//     turno, que al tocarla abre las tarjetas de ese día (ver
//     renderListaPorDia) — mismo diseño que Cierre de Turno de FrCruce;
//   - sin turnos (Heladería): una tarjeta por cierre, como siempre, con el
//     aviso "Caja faltante" arriba (ver renderListaPlana).
export function renderFacturado() {
  const list = $("#facturado-list");
  const empty = $("#facturado-empty");
  list.innerHTML = "";

  const base = fechaBaseDelMes(facturadoMesOffset);
  const targetMonth = base.getMonth();
  const targetYear = base.getFullYear();
  $("#facturado-mes-label").textContent = mesLabel(base);
  const esMesActual = esMismoMes(base, new Date());
  $("#btn-facturado-mes-siguiente").disabled = esMesActual;

  const items = facturacionesDelNegocio().filter(f => {
    const fecha = fechaDeRegistro(f);
    return fecha.getMonth() === targetMonth && fecha.getFullYear() === targetYear;
  });

  if (negocioTieneTurnos(negocioActual)) {
    renderListaPorDia(list, items, base);
    empty.classList.toggle("hidden", list.children.length > 0);
  } else {
    renderListaPlana(list, empty, items, esMesActual);
  }

  const totalMes = items.reduce((sum, f) => sum + (Number(f.importe) || 0), 0);
  $("#facturado-total-mes").textContent = money(totalMes);
}

// Tarjeta de UN cierre ya cargado. La usan las dos formas de listar, así que
// es el único lugar que arma ese <li>.
function crearFilaCierre(f) {
  const fecha = fechaDeRegistro(f);

  const fotoBtn = f.fotoUrl
    ? `<button type="button" class="foto-link" data-url="${escapeHtml(f.fotoUrl)}" aria-label="Ver foto del cierre">📷</button>`
    : "";
  const adminBtns = esAdmin
    ? `<button type="button" class="icon-btn cierre-edit-btn" data-id="${f.id}" aria-label="Editar cierre">✏️</button>
       <button type="button" class="icon-btn danger cierre-delete-btn" data-id="${f.id}" aria-label="Borrar cierre">🗑️</button>`
    : "";

  // Cierres viejos de Pancho (de antes de este campo) no tienen
  // "turno" guardado — quedan sin esa etiqueta en vez de inventar uno
  // (ver openModalFacturado, que obliga a elegirlo recién al editarlos).
  const turnoTexto = f.turno
    ? `<span class="cierre-turno-nombre">${escapeHtml(nombreCortoTurnoFacturado(f.turno))}</span>, `
    : "";

  // "creadoEn" es la hora REAL en que se guardó el cierre (a diferencia
  // de "fecha", que es solo el día elegido). Los cierres de antes de que
  // existiera ese campo no lo tienen: en esos casos no se muestra hora
  // en vez de mostrar una incorrecta.
  const horaCarga = f.creadoEn && f.creadoEn.toDate
    ? f.creadoEn.toDate().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
    : null;

  const li = document.createElement("li");
  li.className = "expense-item";
  // El texto (turno, quién y a qué hora) va en su propia fila arriba, con
  // todo el ancho de la tarjeta para él solo — "Mañana, Iara 14:08 hs ·
  // 04 oct" en una línea en vez de dos apretadas al lado del avatar.
  // Avatar/monto/íconos quedan abajo, mismo patrón que en Gastos (ver
  // .expense-item-top en styles.css). Mismo formato que FRWEB.
  li.innerHTML = `
    <div class="desc">${turnoTexto}${escapeHtml(f.registradoPor || "?")}${horaCarga ? " " + horaCarga + " hs" : ""} · ${fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}</div>
    <div class="expense-item-top">
      <div class="avatar" style="background:${payerColorVar(f.registradoPor)}">${socioInitial(f.registradoPor)}</div>
      <div class="amount">${money(f.importe)}</div>
      ${fotoBtn}
      ${adminBtns}
    </div>
  `;
  return li;
}

// ---------- Lista sin turnos (Heladería): una tarjeta por cierre ----------
function renderListaPlana(list, empty, items, esMesActual) {
  if (!items.length) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }

  // Aviso "Caja faltante": solo tiene sentido mirando el mes actual (no
  // al navegar meses viejos) — ver cierresFaltantes().
  const faltantes = esMesActual ? cierresFaltantes() : [];
  if (faltantes.length) {
    empty.classList.add("hidden"); // si el único "hueco" es hoy, no mostrar el cartel de "sin cierres"
    faltantes.forEach(({ turno, fecha }) => {
      const turnoTexto = turno ? ` — ${nombreTurnoFacturado(turno)}` : "";
      const aviso = document.createElement("li");
      aviso.className = "expense-item falta-abonar";
      aviso.innerHTML = `
        <div class="expense-item-top">
          <div class="info">
            <div class="desc">⚠️ Caja faltante${turnoTexto}</div>
            <div class="meta">${fecha.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "short" })} todavía no se cargó</div>
          </div>
          <button type="button" class="btn-secondary btn-cargar-faltante" data-fecha="${fechaLocalISO(fecha)}" data-turno="${turno || ""}">Cargar</button>
        </div>
      `;
      list.appendChild(aviso);
    });
  }

  items.forEach(f => list.appendChild(crearFilaCierre(f)));
}

// ---------- Lista por día (Pancho): una fila por día, con sus turnos ----------
// Qué días dejó abiertos o cerrados cada persona ("año-mes-día" -> true/false).
// Se guarda acá y no en el DOM porque renderFacturado() redibuja todo con cada
// cambio de Firestore, y sin esto un cierre nuevo que llega le cerraría el día
// que estaba mirando.
const diasAbiertos = {};

// "año-mes-día" de una fecha — la clave con que se agrupan los cierres por
// día y se recuerda qué días quedaron abiertos.
function claveDia(fecha) {
  return `${fecha.getFullYear()}-${fecha.getMonth()}-${fecha.getDate()}`;
}

// Tarjeta "CAJA NO CARGADA" de un turno ya vencido sin cierre. El botón
// "Cargar" abre el modal de Nuevo cierre con esa fecha y turno ya
// preseleccionados (ver el click de #facturado-list en app.js) — cualquiera
// puede tocarlo, igual que cualquiera puede cargar un cierre con el +.
function crearTarjetaFaltante(fecha, turno) {
  const li = document.createElement("li");
  li.className = "expense-item expense-item-faltante";
  li.innerHTML = `
    <div class="expense-item-top">
      <div class="info">
        <div class="desc falta-desc">⚠️ CAJA NO CARGADA</div>
        <div class="meta"><span class="cierre-turno-mayus">${escapeHtml(nombreCortoTurnoFacturado(turno))}</span> — ${fecha.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "short" })}</div>
      </div>
      <button type="button" class="btn-secondary btn-cargar-faltante" data-fecha="${fechaLocalISO(fecha)}" data-turno="${turno}">Cargar</button>
    </div>
  `;
  return li;
}

// Un día de la lista: arriba la fila compacta (el día y su total, y abajo lo
// de cada turno, igual que "Facturado por día" en Resumen mensual, con el día
// en violeta y los turnos en celeste y en mayúscula, para ubicarlos rápido);
// al tocarla se abren debajo las tarjetas de ese día (ver alternarDiaCierres).
// En la fila, cada turno muestra:
//   - lo cargado, si ya tiene cierre;
//   - "falta", con el turno entero en rojo, si lo reclama el aviso "Caja
//     faltante" (adentro va la tarjeta "CAJA NO CARGADA" con su botón Cargar);
//   - $0, si todavía está en curso, no empezó o ese día no se reclama.
// "faltan" es el set "turno|AAAA-MM-DD" que arma renderListaPorDia() con
// cierresFaltantes(): ESE es el único lugar que decide qué turno falta (hora
// de vencimiento + margen, domingos cerrados, FECHA_INICIO_TURNOS) — acá no se
// vuelve a calcular nada de eso.
function crearFilaDia(dia, ahora, faltan, claveDiaAbiertoPorDefecto) {
  const abierto = dia.key in diasAbiertos
    ? diasAbiertos[dia.key]
    : dia.key === claveDiaAbiertoPorDefecto;
  const suma = (cierres) => cierres.reduce((s, f) => s + (Number(f.importe) || 0), 0);
  const ids = idsTurnosFacturado();

  let total = suma(dia.otros);
  const tarjetas = [];
  let turnosHtml = "";
  // Los días de antes de que existieran los 2 turnos (ver diaUsaTurnosFacturado)
  // no tienen columnas: mostrar "Mañana: $0 / Noche: $0" en un día que tuvo
  // un solo cierre sería mentira.
  const conTurnos = diaUsaTurnosFacturado(dia.fecha);
  if (conTurnos) {
    turnosHtml = ids.map(id => {
      const nombre = (clase = "") => `<span class="cierre-dia-turno${clase}">${escapeHtml(nombreCortoTurnoFacturado(id))}:</span>`;
      const cierres = dia.porTurno[id];
      if (cierres.length) {
        const monto = suma(cierres);
        total += monto;
        cierres.forEach(f => tarjetas.push(crearFilaCierre(f)));
        return `<span>${nombre()} ${money(monto)}</span>`;
      }
      if (faltan.has(`${id}|${fechaLocalISO(dia.fecha)}`)) {
        tarjetas.push(crearTarjetaFaltante(dia.fecha, id));
        // Vencido y sin cargar: el turno entero (nombre y "falta") en rojo.
        return `<span>${nombre(" vencido")} <span class="cierre-dia-falta">falta</span></span>`;
      }
      return `<span>${nombre()} ${money(0)}</span>`;
    }).join("");
  }
  dia.otros.forEach(f => tarjetas.push(crearFilaCierre(f)));

  const nombreDia = esMismoDia(dia.fecha, ahora)
    ? "Hoy"
    : dia.fecha.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "short" });

  const li = document.createElement("li");
  li.className = "cierre-dia" + (abierto ? " abierto" : "") + (conTurnos ? "" : " cierre-dia-sin-turnos");
  // --cierre-turnos: cuántas columnas tiene la fila (una por turno del negocio).
  li.innerHTML = `
    <button type="button" class="cierre-dia-head" data-dia="${dia.key}" aria-expanded="${abierto}">
      <span class="cierre-dia-row">
        <span class="cierre-dia-nombre">${escapeHtml(nombreDia)}<span class="cierre-dia-flecha" aria-hidden="true">›</span></span>
        <span class="cierre-dia-total">${money(total)}</span>
      </span>
      ${conTurnos ? `<span class="cierre-dia-turnos" style="--cierre-turnos:${ids.length}">${turnosHtml}</span>` : ""}
    </button>
    <ul class="cierre-dia-lista"></ul>
  `;
  const ul = li.querySelector(".cierre-dia-lista");
  if (tarjetas.length) {
    tarjetas.forEach(t => ul.appendChild(t));
  } else {
    ul.innerHTML = `<li class="cierre-dia-vacio">Todavía no hay cierres de este día.</li>`;
  }
  return li;
}

// Abre o cierra un día de la lista (el botón de su fila). Se cambia en el
// lugar, sin redibujar toda la lista, y se recuerda para los redibujos.
export function alternarDiaCierres(boton) {
  const li = boton.closest(".cierre-dia");
  const abierto = !li.classList.contains("abierto");
  li.classList.toggle("abierto", abierto);
  boton.setAttribute("aria-expanded", String(abierto));
  diasAbiertos[boton.dataset.dia] = abierto;
}

function renderListaPorDia(list, itemsMes, base) {
  const ahora = new Date();
  const ids = idsTurnosFacturado();

  // Cada día es una fila y, al tocarla, se abren abajo las tarjetas de sus
  // turnos. Más reciente primero; los días sin nada cargado también salen
  // (con $0 o "falta") para que el hueco se note de un vistazo.
  const dias = new Map(); // "año-mes-día" -> { key, fecha, porTurno, otros }
  const diaDe = (fecha) => {
    const key = claveDia(fecha);
    if (!dias.has(key)) {
      dias.set(key, {
        key,
        fecha: new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()),
        porTurno: Object.fromEntries(ids.map(id => [id, []])),
        otros: []
      });
    }
    return dias.get(key);
  };

  // Los días del mes elegido: del 1 hasta hoy (o hasta fin de mes si ya
  // pasó). Un día sin cierres solo sale si se espera uno: no los que el
  // negocio no abre (domingos en Pancho) ni los de antes de los 2 turnos —
  // pero si ahí se cargó algo igual, el día aparece por el cierre (más abajo).
  const fin = esMismoMes(base, ahora) ? ahora : new Date(base.getFullYear(), base.getMonth() + 1, 0);
  for (let d = new Date(base.getFullYear(), base.getMonth(), 1); d <= fin; d.setDate(d.getDate() + 1)) {
    if (diaUsaTurnosFacturado(d) && !negocioCierraEseDia(negocioActual, d)) diaDe(d);
  }

  // Si un mismo turno se cargó dos veces (por edición) se ven las dos y
  // suman; los cierres sin turno (datos viejos) van al final de su día.
  const horaDeCarga = (f) => (f.creadoEn && f.creadoEn.toMillis ? f.creadoEn.toMillis() : 0);
  itemsMes.slice().sort((a, b) => horaDeCarga(a) - horaDeCarga(b)).forEach(f => {
    const dia = diaDe(fechaDeRegistro(f));
    if (diaUsaTurnosFacturado(dia.fecha) && ids.includes(f.turno)) dia.porTurno[f.turno].push(f);
    else dia.otros.push(f);
  });

  const faltan = new Set(cierresFaltantes().map(({ turno, fecha }) => `${turno}|${fechaLocalISO(fecha)}`));

  // De entrada queda abierto el día del turno que se está trabajando (a las
  // 2 de la mañana es el de ayer, porque esa Noche arrancó ayer); el resto
  // cerrado. Lo que cada uno abre o cierra a mano se respeta en cada
  // redibujo (ver diasAbiertos).
  const claveDiaAbiertoPorDefecto = claveDia(diaDelTurnoEnCurso());
  Array.from(dias.values())
    .sort((a, b) => b.fecha - a.fecha)
    .forEach(dia => list.appendChild(crearFilaDia(dia, ahora, faltan, claveDiaAbiertoPorDefecto)));
}
