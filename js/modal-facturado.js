import { $, $$, fechaLocalISO, fechaDeRegistro, parseMoneyInput, formatMoneyValue, showToast, conTimeout, esMismoDia } from "./utilidades.js";
import { fbSdk, db, storage } from "./firebase-sdk.js";
import { facturaciones, facturacionesDelNegocio, negocioTieneTurnos } from "./datos.js";
import { negocioActual, usuarioActual } from "./sesion.js";
import { allPagadores, payerColorVar } from "../app.js";

export let selectedFotoFacturadoBlob = null; // foto comprimida, lista para subir (modal de Cierre de Turno — sigue siendo una sola, no forma parte de este cambio)
export function setSelectedFotoFacturadoBlob(blob) { selectedFotoFacturadoBlob = blob; }
let selectedRegistrador = null;
let selectedTurnoFacturado = null; // "manana" | "noche" | null — solo aplica a negocios con negocioTieneTurnos()
let editingCierreId = null;     // id del cierre que se está editando en el modal, o null si es uno nuevo

// Turnos de Cierre de Turno para los negocios con negocioTieneTurnos().
// horaFinMinutos + margenMinutos definen cuándo el aviso "Caja faltante"
// empieza a reclamar ese turno (ver turnosFacturadoFaltantes()) — recién
// pasado ese horario, nunca antes. crucaMedianoche indica si el turno
// arranca un día calendario y termina de madrugada al otro (como el
// único turno que ya existía para el resto de los negocios).
const MARGEN_AVISO_TURNO_MINUTOS = 30;
const TURNOS_FACTURADO = [
  { id: "manana", nombre: "Turno Mañana", horaInicioMinutos: 10 * 60, horaFinMinutos: 19 * 60 + 50, crucaMedianoche: false },
  { id: "noche", nombre: "Turno Noche", horaInicioMinutos: 19 * 60, horaFinMinutos: 3 * 60, crucaMedianoche: true },
];
export function nombreTurnoFacturado(id) {
  const turno = TURNOS_FACTURADO.find(t => t.id === id);
  return turno ? turno.nombre : "";
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

export function resetFotoFieldFact() {
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
function cierreFaltanteHoy() {
  const hoy = new Date();
  if (hoy.getHours() < 5) return null;
  const diaEsperado = new Date(hoy);
  diaEsperado.setDate(diaEsperado.getDate() - 1);
  const yaCargado = facturacionesDelNegocio().some(f => esMismoDia(fechaDeRegistro(f), diaEsperado));
  return yaCargado ? null : diaEsperado;
}

// Desde acá se empezaron a usar los 2 turnos en Pancho — antes de esta
// fecha los cierres no tienen "turno" guardado, y eso NO significa que
// falten: el campo todavía no existía. turnosFacturadoFaltantes() nunca
// reclama para más atrás de este día.
const FECHA_INICIO_TURNOS = new Date(2026, 8, 17);

// Misma idea que cierreFaltanteHoy() (avisar recién pasado un margen,
// nunca antes) pero para negocios con negocioTieneTurnos(), donde cada
// turno tiene su propio horario y hay que chequearlos por separado — acá
// SÍ importa el campo "turno" del cierre, a diferencia de
// cierreFaltanteHoy() que no distingue turnos.
// A diferencia de cierreFaltanteHoy() (que solo mira AYER), acá se
// camina día por día hacia atrás hasta FECHA_INICIO_TURNOS, así un turno
// que se saltea un día y no se corrige sigue apareciendo al día
// siguiente y al otro — antes se perdía solo con el cambio de día (bug
// real reportado: el empleado nunca cargó un solo Turno Mañana desde que
// existen los 2 turnos, y a la mañana siguiente el aviso ya no estaba).
// - Turno Mañana no cruza la medianoche: el primer día a chequear es HOY,
//   una vez pasada su hora de fin + margen (antes de eso, ni se empieza).
// - Turno Noche sí cruza la medianoche (empieza un día, termina de
//   madrugada al otro) — mismo criterio que el negocio de un solo turno:
//   el primer día a chequear es AYER.
// Cierres viejos de Pancho (de antes de que existiera este campo, o de
// antes de FECHA_INICIO_TURNOS) no tienen "turno" guardado, así que no
// cuentan como "ya cargado" para ninguno de los dos.
function turnosFacturadoFaltantes() {
  const ahora = new Date();
  const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();
  const pendientes = [];
  TURNOS_FACTURADO.forEach(turno => {
    const dia = new Date(ahora);
    if (turno.crucaMedianoche) dia.setDate(dia.getDate() - 1);
    // El día de hoy (o de ayer, si cruza medianoche) todavía no venció
    // -> arrancar a chequear recién desde el día anterior a ese.
    if (minutosAhora < turno.horaFinMinutos + MARGEN_AVISO_TURNO_MINUTOS) {
      dia.setDate(dia.getDate() - 1);
    }
    while (dia >= FECHA_INICIO_TURNOS) {
      const yaCargado = facturacionesDelNegocio().some(f =>
        f.turno === turno.id && esMismoDia(fechaDeRegistro(f), dia)
      );
      if (!yaCargado) pendientes.push({ turno: turno.id, fecha: new Date(dia) });
      dia.setDate(dia.getDate() - 1);
    }
  });
  return pendientes;
}

// Punto único que usa renderFacturado() para el aviso "Caja faltante":
// decide según el negocio si hay que chequear 1 cierre por día
// (cierreFaltanteHoy) o los turnos de Pancho (turnosFacturadoFaltantes),
// y siempre devuelve una lista (puede tener varios elementos si hay
// turnos de más de un día sin cargar) para que renderFacturado() no
// necesite saber la diferencia entre negocios.
export function cierresFaltantes() {
  if (negocioTieneTurnos(negocioActual)) return turnosFacturadoFaltantes();
  const fecha = cierreFaltanteHoy();
  return fecha ? [{ turno: null, fecha }] : [];
}

// Turno que corresponde a la hora actual, para dejarlo preseleccionado al
// tocar "+" a mano (sin venir de "Cargar" en el aviso ni editando uno
// existente) — se puede tocar el otro chip igual, es solo el punto de
// partida. Usa el mismo horario+margen de TURNOS_FACTURADO que ya define
// el aviso "Caja faltante" (turnosFacturadoFaltantes()), para no repetir
// esos números con otro criterio: dentro de la franja de Turno Mañana
// (10 a 19hs, + margen) sugiere "manana"; el resto del día —incluida la
// madrugada, que es cuando se cierra el Turno Noche— sugiere "noche".
function turnoFacturadoSugerido() {
  const ahora = new Date();
  const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();
  const manana = TURNOS_FACTURADO.find(t => t.id === "manana");
  const dentroDeManana = minutosAhora >= manana.horaInicioMinutos
    && minutosAhora < manana.horaFinMinutos + MARGEN_AVISO_TURNO_MINUTOS;
  return dentroDeManana ? "manana" : "noche";
}

export function selectTurnoFacturado(turno) {
  selectedTurnoFacturado = turno;
  $$("#turno-options-fact .pagador-chip").forEach(c => c.classList.toggle("selected", c.dataset.turno === turno));
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

export function registrarEdicionManualFacturado(campo) {
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
// en renderFacturado(). "presetTurno" viaja junto con "presetFecha" desde
// ese mismo botón, para los negocios con negocioTieneTurnos().
export function openModalFacturado(cierre, presetFecha, presetTurno) {
  editingCierreId = cierre ? cierre.id : null;
  // Cierre nuevo: se registra directo a nombre de quien está logueado
  // (mismo criterio que "Nuevo gasto" — ver openModal()) — el selector
  // de chips solo se muestra al EDITAR un cierre ya cargado (admin-only),
  // por si hace falta corregir quién lo cargó en realidad.
  selectedRegistrador = cierre ? cierre.registradoPor : usuarioActual;
  $("#campo-registrador").classList.toggle("hidden", !cierre);

  // El selector de turno solo existe para Pancho Recreo (ver
  // negocioTieneTurnos()) — al editar, un cierre viejo sin turno guardado
  // queda sin ningún chip seleccionado, así se obliga a elegirlo antes de
  // poder guardar (ver saveCierre()), en vez de inventar uno.
  const tieneTurnos = negocioTieneTurnos(negocioActual);
  $("#campo-turno-fact").classList.toggle("hidden", !tieneTurnos);
  selectTurnoFacturado(tieneTurnos
    ? (cierre ? (cierre.turno || null) : (presetTurno || turnoFacturadoSugerido()))
    : null);

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

export function closeModalFacturado() {
  $("#modal-add-facturado").classList.remove("active");
  editingCierreId = null;
}

export async function saveCierre() {
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
  if (negocioTieneTurnos(negocioActual)) {
    if (!selectedTurnoFacturado) {
      errEl.textContent = "Elegí qué turno estás cerrando.";
      errEl.classList.remove("hidden");
      return;
    }
    // Solo al cargar uno nuevo — al editar, se puede seguir guardando el
    // mismo turno+fecha que ya tenía (no está "duplicándose", es el
    // mismo cierre). Evita que alguien cargue el mismo turno 2 veces por
    // apurado, sin impedir la corrección de un cierre ya cargado.
    if (!editingCierreId) {
      const yaExiste = facturacionesDelNegocio().some(f =>
        f.turno === selectedTurnoFacturado && fechaLocalISO(fechaDeRegistro(f)) === fechaStr
      );
      if (yaExiste) {
        errEl.textContent = `Ya hay un cierre de ${nombreTurnoFacturado(selectedTurnoFacturado)} cargado ese día. Para corregirlo, editalo desde la lista.`;
        errEl.classList.remove("hidden");
        return;
      }
    }
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
    // Solo los negocios con negocioTieneTurnos() guardan este campo — el
    // resto sigue igual que siempre (un cierre por día, sin turno).
    if (negocioTieneTurnos(negocioActual)) {
      data.turno = selectedTurnoFacturado;
    }
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
export async function deleteCierre(id) {
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
