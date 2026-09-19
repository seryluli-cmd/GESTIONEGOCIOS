import { $, $$, escapeHtml, showToast, fechaDeRegistro, fechaLocalISO, downloadCSV } from "./utilidades.js";
import { fbSdk, db, auth } from "./firebase-sdk.js";
import {
  socios, admins, colaboradores, colaboradorNegocio, categoriasDelNegocio,
  setClaveMaestraLocal, gastosDelNegocio, facturacionesDelNegocio
} from "./datos.js";
import { esAdmin, usuarioActual, negocioActual, cargarHistorialLogins } from "./sesion.js";
import { NEGOCIOS, socioColorVar, colaboradorColorVar, allPagadores } from "../app.js";
import { nombreTurnoFacturado } from "./modal-facturado.js";

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
export function renderAjustesCategorias() {
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

export async function agregarCategoriaDesdeAjustes() {
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
export async function quitarCategoria(nombre) {
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
export function openModalColaborador() {
  $("#input-colaborador-nombre").value = "";
  $("#input-colaborador-negocio").innerHTML = `<option value="">Ambos negocios</option>` +
    NEGOCIOS.map(biz => `<option value="${biz.id}">${escapeHtml(biz.nombre)}</option>`).join("");
  $("#modal-colaborador-error").classList.add("hidden");
  $("#modal-add-colaborador").classList.add("active");
  setTimeout(() => $("#input-colaborador-nombre").focus(), 150);
}

export function closeModalColaborador() {
  $("#modal-add-colaborador").classList.remove("active");
}

export async function saveColaborador() {
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
export async function toggleAdminSocio(nombre) {
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
export async function guardarClaveMaestra() {
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

export function exportGastosCSV() {
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

export function exportFacturacionCSV() {
  const rows = [["Fecha", "Turno", "Importe", "Registrado por"]];
  facturacionesDelNegocio()
    .slice()
    .sort((a, b) => fechaDeRegistro(a) - fechaDeRegistro(b))
    .forEach(f => {
      rows.push([
        fechaDeRegistro(f).toLocaleDateString("es-AR"),
        f.turno ? nombreTurnoFacturado(f.turno) : "",
        Number(f.importe) || 0,
        f.registradoPor || ""
      ]);
    });
  downloadCSV(`facturacion-${negocioActual}-${fechaLocalISO()}.csv`, rows);
}
