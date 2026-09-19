import { $, $$, escapeHtml } from "./utilidades.js";
import { fbSdk, db, parseFirebaseConfig, initFirebase } from "./firebase-sdk.js";
import {
  socios, colaboradores, admins, pins, claveMaestraAdmin, colaboradorNegocio,
  aplicarConfigSocios
} from "./datos.js";
import { NEGOCIOS, LS_CONFIG_KEY, LS_SOCIOS_CACHE, LS_COLAB_CACHE, bootApp } from "../app.js";

let pendingFirebaseConfig = null; // config guardada entre el paso 1 y 2 del setup inicial
// ---------- Setup screen ----------
export function addColaboradorRow(value, negocioAsignado) {
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
export async function handleSetupConnect() {
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
export async function handleSetupGuardar() {
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

// ---------- Reset ----------
export function resetLocalConfig() {
  if (!confirm("¿Desconectar este celular? No se borran los gastos.")) return;
  localStorage.removeItem(LS_CONFIG_KEY);
  localStorage.removeItem(LS_SOCIOS_CACHE);
  localStorage.removeItem(LS_COLAB_CACHE);
  location.reload();
}
