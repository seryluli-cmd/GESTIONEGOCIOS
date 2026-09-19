import { $, money, mesLabel, fechaLocalISO, fechaDeRegistro, fechaBaseDelMes, esMismoMes, escapeHtml } from "./utilidades.js";
import { facturacionesDelNegocio } from "./datos.js";
import { esAdmin } from "./sesion.js";
import { facturadoMesOffset, payerColorVar, socioInitial } from "../app.js";
import { cierresFaltantes, nombreTurnoFacturado } from "./modal-facturado.js";

// ---------- Render: Facturado ----------
// Antes mostraba TODOS los cierres del negocio sin importar el mes —
// mismo problema que tenía Gastos. Ahora se ve un mes a la vez, por
// defecto el actual, con flechas para ir a meses anteriores.
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

  if (!items.length) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }

  // Aviso "Caja faltante": solo tiene sentido mirando el mes actual (no
  // al navegar meses viejos) — ver cierresFaltantes(). Pancho Recreo
  // puede mostrar hasta 2 avisos a la vez (uno por turno pendiente).
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

  let totalMes = 0;

  items.forEach(f => {
    const fecha = fechaDeRegistro(f);
    totalMes += Number(f.importe) || 0;

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
    const turnoTexto = f.turno ? ` — ${nombreTurnoFacturado(f.turno)}` : "";

    const li = document.createElement("li");
    li.className = "expense-item";
    // Acá los íconos se quedan en la misma fila que el texto (a
    // diferencia de Gastos) — el texto de un cierre es corto y no
    // necesita el ancho extra, así que no hacía falta tocarle nada.
    li.innerHTML = `
      <div class="expense-item-top">
        <div class="avatar" style="background:${payerColorVar(f.registradoPor)}">${socioInitial(f.registradoPor)}</div>
        <div class="info">
          <div class="desc">${fecha.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "short" })}${turnoTexto}</div>
          <div class="meta">Cargado por ${escapeHtml(f.registradoPor || "?")}</div>
        </div>
        <div class="amount">${money(f.importe)}</div>
        ${fotoBtn}
        ${adminBtns}
      </div>
    `;
    list.appendChild(li);
  });

  $("#facturado-total-mes").textContent = money(totalMes);
}
