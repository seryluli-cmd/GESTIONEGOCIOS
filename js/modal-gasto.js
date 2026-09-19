// ============================================================
// Modal de carga/edición de gasto: chips de pagador, forma de pago
// (con el desglose Mixto), fotos, guardar/borrar y marcar abonado.
// ============================================================

import { $, $$, escapeHtml, showToast, parseMoneyInput, formatMoneyValue, redondearCentavos, fechaLocalISO, fechaDeRegistro, money, conTimeout } from "./utilidades.js";
import { fbSdk, db, storage } from "./firebase-sdk.js";
import { gastosDelNegocio, gastos, categoriasDelNegocio, negocioTieneCajaLocal } from "./datos.js";
import { negocioActual, usuarioActual, esAdmin } from "./sesion.js";
import { cajaLocalCalculo, esGastoCaja } from "./caja-local.js";
import { fotosDeGasto } from "./gastos.js";
import { payerColorVar, allPagadores, MAX_FOTOS_GASTO } from "../app.js";

let selectedPagador = null;
let editingGastoId = null;      // id del gasto que se está editando en el modal, o null si es uno nuevo
let selectedFormaPago = "efectivo"; // "efectivo" | "digital" | "mixto" — elegido en el modal de gasto
let mixtoUltimoEditado = null;  // "efectivo" | "digital" | null — cuál de los 2 campos del desglose se tipeó a mano por última vez (el otro se recalcula solo)
export let fotosGastoModal = []; // fotos del gasto que se está cargando/editando, en el orden del modal — cada una { tipo:"existente", url, path } (ya estaba guardada) o { tipo:"nueva", blob, previewUrl } (recién elegida, falta subir)
export let fotosGastoABorrar = []; // paths de Storage de fotos existentes que se sacaron en este modal — se borran recién si se confirma "Guardar" (cancelar el modal no borra nada)

// ---------- Render: chips de pagador (modal) ----------
export function renderPagadorChips() {
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

export function setDefaultFecha() {
  $("#input-fecha").value = fechaLocalISO();
}

// ---------- Modal: agregar gasto ----------

function resetFotoField() {
  // Las fotos "nueva" tienen un object URL propio (URL.createObjectURL)
  // que hay que liberar a mano o se queda en memoria — las "existente"
  // apuntan a Storage, no hace falta nada con ellas acá.
  fotosGastoModal.forEach(f => { if (f.tipo === "nueva") URL.revokeObjectURL(f.previewUrl); });
  fotosGastoModal = [];
  fotosGastoABorrar = [];
  $("#input-foto").value = "";
  renderFotoStrip();
}

// Único lugar que dibuja la tira de miniaturas del modal de gasto (nuevo
// o edición) — se llama cada vez que cambia fotosGastoModal.
export function renderFotoStrip() {
  const strip = $("#foto-strip");
  strip.innerHTML = fotosGastoModal.map((f, idx) => `
    <div class="foto-preview-wrap">
      <img class="foto-preview-img" src="${escapeHtml(f.tipo === "nueva" ? f.previewUrl : f.url)}" alt="Vista previa de la factura ${idx + 1}">
      <button type="button" class="foto-remove-btn" data-idx="${idx}" aria-label="Quitar esta foto">×</button>
    </div>
  `).join("");
  // Al llegar al máximo se esconden los botones de agregar — más simple
  // para quien carga el gasto que un mensaje de error al tocar "Tomar foto".
  $("#foto-btns-row").classList.toggle("hidden", fotosGastoModal.length >= MAX_FOTOS_GASTO);
}

// Llena el <select> de categoría con las que correspondan al negocio
// activo (ver categoriasGasto/categoriasDelNegocio) — se llama cada vez
// que se abre el modal, así siempre refleja el negocio en el que se está
// parado. Siempre todas las categorías del negocio, para admin y equipo
// por igual (la privacidad ahora es un flag por gasto individual, ver el
// checkbox "Gasto Admin" en openModal, no algo de la categoría).
// categoriaActual se agrega igual aunque ya no exista en la lista (un
// admin la borró después de cargada), para no perder el valor guardado de
// un gasto viejo al editarlo.
function renderCategoriaOptions(categoriaActual) {
  const sel = $("#input-categoria");
  let cats = categoriasDelNegocio(negocioActual).slice();
  if (categoriaActual && !cats.includes(categoriaActual)) {
    cats = cats.concat([categoriaActual]);
  }
  sel.innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  return cats.length;
}

// Sin argumento: alta de un gasto nuevo. Con un gasto existente: edición
// (solo accesible para el admin, ver botón ✏️ en renderGastos).
// Forma de pago del gasto: Efectivo, Digital, o Mixto. Solo Mixto muestra
// el desglose Efectivo/Digital, que debe sumar el Importe total.
export function selectFormaPago(forma) {
  selectedFormaPago = forma;
  $$("#forma-pago-options .pagador-chip").forEach(c => c.classList.toggle("selected", c.dataset.forma === forma));
  $("#campo-mixto").classList.toggle("hidden", forma !== "mixto");
  if (forma !== "mixto") mixtoUltimoEditado = null;
}

// Cálculo cruzado del desglose Mixto: al salir de Efectivo o Digital (o de
// Importe), el otro se completa solo para que sume el Importe (mismo
// criterio que el desglose Total/Efectivo/Digital de Facturado más abajo,
// pero acá el "total" ya es el campo Importe que está siempre visible
// arriba). Los listeners usan "change" (instantáneo) + "input" con
// debounce (red de seguridad para iPhone) — ver wireEvents().
export function registrarEdicionMixto(campo) {
  mixtoUltimoEditado = campo;
  calcularCampoMixtoFaltante();
}

export function calcularCampoMixtoFaltante() {
  if (!mixtoUltimoEditado) return;
  const importe = parseMoneyInput($("#input-importe").value);
  if (!Number.isFinite(importe)) return;
  if (mixtoUltimoEditado === "efectivo") {
    const efectivo = parseMoneyInput($("#input-mixto-efectivo").value);
    if (!Number.isFinite(efectivo)) return;
    $("#input-mixto-digital").value = formatMoneyValue(redondearCentavos(importe - efectivo));
  } else {
    const digital = parseMoneyInput($("#input-mixto-digital").value);
    if (!Number.isFinite(digital)) return;
    $("#input-mixto-efectivo").value = formatMoneyValue(redondearCentavos(importe - digital));
  }
}

// Red de seguridad para saveGasto(): en iPhone, tocar "Guardar gasto"
// justo después de tipear el segundo campo del desglose Mixto puede
// disparar el click del botón ANTES que el "change" de ese campo (bug
// conocido de Safari en iOS: en algunos casos dispara el click de un
// botón antes que el blur/change del input que tenía el foco). Si eso
// pasa, calcularCampoMixtoFaltante() todavía no corrió y el otro campo
// llega vacío al guardar, aunque el usuario ya haya completado los 2 que
// tenía que completar. Se fuerza acá el mismo cálculo (nunca se duplica
// la cuenta) si falta justo uno de los dos.
function asegurarDesgloseMixtoAntesDeGuardar() {
  const efectivoStr = $("#input-mixto-efectivo").value.trim();
  const digitalStr = $("#input-mixto-digital").value.trim();
  if (efectivoStr !== "" && digitalStr === "") {
    mixtoUltimoEditado = "efectivo";
    calcularCampoMixtoFaltante();
  } else if (digitalStr !== "" && efectivoStr === "") {
    mixtoUltimoEditado = "digital";
    calcularCampoMixtoFaltante();
  }
}

export function openModal(gasto, opts) {
  const cantCategorias = renderCategoriaOptions(gasto ? gasto.categoria : null);
  if (!cantCategorias) {
    showToast("Creá primero una categoría en Ajustes.");
    return;
  }

  editingGastoId = gasto ? gasto.id : null;
  // Gasto nuevo: se registra directo a nombre de quien está logueado en
  // este celular — no tiene sentido preguntarle "¿quién pagó?" si la app
  // ya sabe quién es. El selector de chips solo se muestra al EDITAR un
  // gasto ya cargado (solo accesible para el admin), por si hace falta
  // corregir un error de a quién se le atribuyó.
  selectedPagador = gasto ? gasto.pagadoPor : usuarioActual;
  $("#campo-pagador").classList.toggle("hidden", !gasto);

  $("#input-importe").value = gasto ? formatMoneyValue(gasto.importe) : "";
  $("#input-descripcion").value = gasto ? (gasto.descripcion || "") : "";
  if (gasto) $("#input-categoria").value = gasto.categoria || "Otros";
  $("#input-falta-abonar").checked = gasto ? !!gasto.faltaAbonar : false;
  // "Gasto Admin" (soloAdmin): solo un admin puede ver este checkbox y
  // tildarlo — quien no sea admin ni lo tiene en el modal, así que un
  // gasto que carga nunca puede quedar marcado privado por accidente. Al
  // abrir desde "Gastos S/Admin" (ver fab-add-gastos-admin) llega
  // pre-tildado vía opts.soloAdmin, pero el admin lo puede destildar igual.
  $("#campo-gasto-admin").classList.toggle("hidden", !esAdmin);
  $("#input-gasto-admin").checked = gasto ? !!gasto.soloAdmin : !!(opts && opts.soloAdmin);
  $("#input-nota").value = gasto ? (gasto.nota || "") : "";

  // Gastos cargados antes de que existiera "forma de pago" no tienen el
  // campo guardado — se muestran como Efectivo por default (no se puede
  // inventar cómo se pagaron los viejos).
  mixtoUltimoEditado = null;
  $("#input-mixto-efectivo").value = gasto && gasto.montoEfectivo != null ? formatMoneyValue(gasto.montoEfectivo) : "";
  $("#input-mixto-digital").value = gasto && gasto.montoDigital != null ? formatMoneyValue(gasto.montoDigital) : "";

  // Kiara es la encargada de compras de Pancho: todo lo que paga sale de
  // la Caja del local, siempre — no tiene sentido pedirle que elija la
  // forma de pago cada vez si la respuesta es siempre la misma. A
  // propósito es específico de ella por nombre (no "cualquier
  // colaborador"), porque el resto del equipo podría no manejar esa
  // caja. Para un gasto NUEVO cargado por Kiara, se fuerza "caja" solo
  // y se esconde el selector entero (con un aviso de que quedó así). Al
  // EDITAR un gasto ya cargado (admin-only) el selector completo sigue
  // disponible, por si hay que corregirlo a otra forma de pago.
  const esKiaraConCaja = !gasto
    && usuarioActual === "Kiara"
    && negocioTieneCajaLocal(negocioActual);
  $("#campo-forma-pago").classList.toggle("hidden", esKiaraConCaja);
  $("#aviso-forma-pago-auto").classList.toggle("hidden", !esKiaraConCaja);
  if (esKiaraConCaja) {
    selectFormaPago("caja");
  } else {
    // "Caja del local" es una forma de pago exclusiva de los negocios con
    // tieneCajaLocal:true en NEGOCIOS (ver renderResumen/renderAjustesSocios).
    $("#chip-forma-caja").classList.toggle("hidden", !negocioTieneCajaLocal(negocioActual));
    selectFormaPago(gasto ? (gasto.formaPago || "efectivo") : "efectivo");
  }

  if (gasto) {
    $("#input-fecha").value = fechaLocalISO(fechaDeRegistro(gasto));
  } else {
    setDefaultFecha();
  }
  resetFotoField(); // limpia la selección de una edición anterior
  if (gasto) {
    // Precarga las fotos que ya tenía para que se puedan ver, sacar o
    // completar hasta el máximo — no se suben de nuevo, solo se muestran
    // (fotosDeGasto ya entiende el formato viejo de una sola foto).
    fotosGastoModal = fotosDeGasto(gasto).map(f => ({ tipo: "existente", url: f.url, path: f.path }));
    renderFotoStrip();
  }

  $("#modal-add-title").textContent = gasto ? "Editar gasto" : "Nuevo gasto";
  $("#btn-save-add").textContent = gasto ? "Guardar cambios" : "Guardar gasto";
  $$("#pagador-options .pagador-chip").forEach(c => c.classList.toggle("selected", c.textContent === selectedPagador));
  $("#modal-error").classList.add("hidden");
  $("#modal-add").classList.add("active");
  setTimeout(() => $("#input-importe").focus(), 150);
}

export function closeModal() {
  $("#modal-add").classList.remove("active");
  editingGastoId = null;
  resetFotoField(); // libera los object URL de las fotos elegidas, se cancele o se haya guardado
}

export async function saveGasto() {
  const importe = parseMoneyInput($("#input-importe").value);
  const descripcion = $("#input-descripcion").value.trim();
  const categoria = $("#input-categoria").value;
  const nota = $("#input-nota").value.trim();
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

  let montoEfectivo = null, montoDigital = null;
  if (selectedFormaPago === "mixto") {
    asegurarDesgloseMixtoAntesDeGuardar();
    montoEfectivo = parseMoneyInput($("#input-mixto-efectivo").value);
    montoDigital = parseMoneyInput($("#input-mixto-digital").value);
    if (!Number.isFinite(montoEfectivo) || !Number.isFinite(montoDigital) || montoEfectivo < 0 || montoDigital < 0) {
      errEl.textContent = "Completá el desglose Efectivo y Digital.";
      errEl.classList.remove("hidden");
      return;
    }
    if (Math.abs((montoEfectivo + montoDigital) - importe) > 0.01) {
      errEl.textContent = "Efectivo + Digital debe sumar el Importe total.";
      errEl.classList.remove("hidden");
      return;
    }
  }

  // Aviso suave (no bloquea) si este gasto deja la Caja del local en
  // negativo — para pescar errores de carga (elegir "Caja del local" por
  // error, o un importe mal tipeado) sin impedir guardarlo si realmente
  // se gastó de más y después se repone. Al
  // editar un gasto que YA era "caja", se excluye su monto viejo del
  // cálculo para no descontarlo dos veces.
  if (selectedFormaPago === "caja") {
    // El saldo sale de cajaLocalCalculo() y no de un cálculo propio, para
    // que este aviso cuente lo mismo que las 3 vistas de la caja (antes
    // usaba solo el monto inicial e ignoraba las reposiciones, así que
    // avisaba de un rojo inexistente en cuanto se reponía plata).
    // Al editar un gasto que YA era "caja", se le devuelve su monto viejo
    // al saldo para no descontarlo dos veces.
    //
    // Si todavía no cargó `reposiciones` (cargando: true, apenas se abrió
    // la app), no hay saldo real con qué comparar — mejor no avisar nada
    // que avisar un rojo falso calculado sobre una caja "vacía" a medias.
    const { queda, cargando } = cajaLocalCalculo();
    if (!cargando) {
      const gastoViejo = editingGastoId
        ? gastosDelNegocio().find(g => g.id === editingGastoId && esGastoCaja(g))
        : null;
      const saldoSinEste = queda + (gastoViejo ? Number(gastoViejo.importe) || 0 : 0);
      const saldoResultante = saldoSinEste - importe;
      if (saldoResultante < 0) {
        const saldoTexto = (saldoResultante < 0 ? "-" : "") + money(Math.abs(saldoResultante));
        if (!confirm(`Ojo: esto deja la Caja del local en ${saldoTexto}. ¿Guardar igual?`)) return;
      }
    }
  }

  const btn = $("#btn-save-add");
  const isEdit = !!editingGastoId;
  const fotosNuevas = fotosGastoModal.filter(f => f.tipo === "nueva");
  btn.disabled = true;
  btn.textContent = fotosNuevas.length ? "Subiendo fotos…" : "Guardando…";

  try {
    // Cada foto se sube en paralelo (son independientes entre sí) y se
    // tolera que alguna falle — mejor guardar el gasto con las que sí
    // subieron que perderlo entero por una sola foto que no salió (mismo
    // criterio que antes con una sola foto).
    const resultadosSubida = await Promise.allSettled(fotosNuevas.map(async f => {
      const path = `recibos/${negocioActual}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      const storageRef = fbSdk.ref(storage, path);
      const TIMEOUT_MSG = "La subida de una foto tardó demasiado.";
      await conTimeout(
        fbSdk.uploadBytes(storageRef, f.blob, { contentType: "image/jpeg" }),
        25000,
        TIMEOUT_MSG
      );
      const url = await conTimeout(fbSdk.getDownloadURL(storageRef), 15000, TIMEOUT_MSG);
      return { url, path };
    }));
    let fotosFallidas = 0;
    const fotosSubidas = [];
    resultadosSubida.forEach(r => {
      if (r.status === "fulfilled") {
        fotosSubidas.push(r.value);
      } else {
        console.error("No se pudo subir una foto, se guarda el gasto sin ella:", r.reason);
        fotosFallidas++;
      }
    });
    if (fotosNuevas.length) btn.textContent = "Guardando…";

    const fotosExistentesConservadas = fotosGastoModal
      .filter(f => f.tipo === "existente")
      .map(f => ({ url: f.url, path: f.path }));
    const fotosFinales = fotosExistentesConservadas.concat(fotosSubidas);

    const gastoData = {
      importe,
      descripcion,
      categoria,
      nota,
      pagadoPor: selectedPagador,
      negocio: negocioActual,
      faltaAbonar: $("#input-falta-abonar").checked,
      // Quien no sea admin ni ve el checkbox (ver openModal) — esAdmin
      // acá asegura que nunca quede en true por un valor colgado del campo.
      soloAdmin: esAdmin ? $("#input-gasto-admin").checked : false,
      fecha: fechaStr ? new Date(fechaStr + "T12:00:00") : fbSdk.serverTimestamp(),
      formaPago: selectedFormaPago
    };
    // montoEfectivo/montoDigital solo existen si es Mixto — si se edita un
    // gasto y se cambia a Efectivo/Digital "puro", hay que borrar el
    // desglose viejo explícitamente (updateDoc no toca campos que no se
    // le pasan, así que quedaría un desglose stale sin esto).
    if (selectedFormaPago === "mixto") {
      gastoData.montoEfectivo = montoEfectivo;
      gastoData.montoDigital = montoDigital;
    } else if (isEdit) {
      gastoData.montoEfectivo = fbSdk.deleteField();
      gastoData.montoDigital = fbSdk.deleteField();
    }
    // `fotos` reemplaza al formato viejo (fotoUrl/fotoPath, una sola
    // foto) — se escribe cada vez que el gasto queda con alguna foto, así
    // un gasto viejo editado migra solo al formato nuevo, sin necesidad
    // de una migración aparte (ver fotosDeGasto()).
    if (fotosFinales.length) {
      gastoData.fotos = fotosFinales;
      if (isEdit) {
        gastoData.fotoUrl = fbSdk.deleteField();
        gastoData.fotoPath = fbSdk.deleteField();
      }
    } else if (isEdit && fotosGastoABorrar.length) {
      // Se sacaron todas las fotos que tenía, sin agregar ninguna nueva.
      gastoData.fotos = fbSdk.deleteField();
      gastoData.fotoUrl = fbSdk.deleteField();
      gastoData.fotoPath = fbSdk.deleteField();
    }

    if (isEdit) {
      await fbSdk.updateDoc(fbSdk.doc(db, "gastos", editingGastoId), gastoData);
    } else {
      gastoData.creadoEn = fbSdk.serverTimestamp();
      await fbSdk.addDoc(fbSdk.collection(db, "gastos"), gastoData);
    }

    // Recién ahora que el gasto quedó guardado se borran del Storage las
    // fotos que se sacaron en este modal — si algo de arriba falla antes
    // de llegar acá, no se pierde ninguna foto todavía referenciada.
    for (const path of fotosGastoABorrar) {
      try {
        await fbSdk.deleteObject(fbSdk.ref(storage, path));
      } catch (e) {
        console.warn("No se pudo borrar una foto quitada:", e.message);
      }
    }

    closeModal();
    if (fotosFallidas) {
      showToast(isEdit
        ? `Gasto actualizado, pero ${fotosFallidas} foto${fotosFallidas === 1 ? "" : "s"} no se pudo subir ⚠️`
        : `Gasto guardado, pero ${fotosFallidas} foto${fotosFallidas === 1 ? "" : "s"} no se pudo subir ⚠️`);
    } else {
      showToast(isEdit ? "Gasto actualizado ✅" : "Gasto guardado ✅");
    }
  } catch (e) {
    errEl.textContent = "No se pudo guardar. Revisá tu conexión.";
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
export async function deleteGasto(id) {
  if (!confirm("¿Borrar este gasto? No se puede deshacer.")) return;
  const gasto = gastos.find(g => g.id === id);
  try {
    if (gasto) {
      for (const f of fotosDeGasto(gasto)) {
        if (!f.path) continue;
        try {
          await fbSdk.deleteObject(fbSdk.ref(storage, f.path));
        } catch (e) {
          console.warn("No se pudo borrar una foto del gasto:", e.message);
        }
      }
    }
    await fbSdk.deleteDoc(fbSdk.doc(db, "gastos", id));
    showToast("Gasto borrado");
  } catch (e) {
    console.error(e);
    showToast("No se pudo borrar. Revisá tu conexión.");
  }
}

// Tocar el aviso "⚠️ Falta abonar" en la lista lo marca como pagado
// directo, sin pasar por el modal de Editar.
export async function marcarAbonado(id) {
  try {
    await fbSdk.updateDoc(fbSdk.doc(db, "gastos", id), { faltaAbonar: false });
    showToast("Gasto marcado como pagado ✅");
  } catch (e) {
    console.error(e);
    showToast("No se pudo actualizar. Revisá tu conexión.");
  }
}
