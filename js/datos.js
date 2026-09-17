// ============================================================
// Capa de datos: config de socios, listeners en tiempo real de
// Firestore (gastos, facturación, reposiciones, ideas) y los filtros
// "del negocio actualmente seleccionado". Nadie fuera de acá reasigna
// estas variables de estado.
// ============================================================

import { $$ } from "./utilidades.js";
import { fbSdk, db, initFirebase } from "./firebase-sdk.js";
import {
  NEGOCIOS, LS_CONFIG_KEY, LS_SOCIOS_CACHE, LS_COLAB_CACHE,
  bootApp,
  renderPagadorChips, renderPagadorChipsFacturado, renderAjustesSocios,
  renderBalance, renderGastos, renderGastosAdmin, renderFacturado, renderIdeas, renderResumen,
  limpiarFotosVencidas
} from "../app.js";
import { migrarMontoInicialCaja, renderCajaLocalDetalle } from "./caja-local.js";
import {
  negocioActual, usuarioActual, setEsAdmin, aplicarPermisosDeVista, renderNegocioCards
} from "./sesion.js";

// Categorías de gastos: distintas por negocio, porque Pancho Recreo y
// Heladería Pablo venden cosas totalmente distintas. Son simples nombres,
// editables por un admin desde Ajustes → "Categorías de gastos" (ver
// renderAjustesCategorias) — sin ninguna noción de privacidad: un gasto
// se marca como privado con el checkbox "🔒 Gasto Admin" (campo soloAdmin
// del gasto, ver openModal), independiente de su categoría. Se guardan en
// Firestore (config/socios, campo categoriasGasto, un array por negocio)
// para que un admin pueda crear/borrar una categoría sin tocar código —
// ver aplicarConfigSocios(). CATEGORIAS_GASTO_DEFAULT es la semilla para
// instalaciones viejas que todavía no tienen ese campo (las mismas
// categorías que antes estaban fijas en este archivo).
const CATEGORIAS_GASTO_DEFAULT = {
  pancho: ["Panchos", "Bebidas", "Papelería", "Publicidad", "Topping", "Sueldos", "Otros"],
  heladeria: ["Helado", "Tortas de repostería", "Café", "Medialunas", "Fiambres",
              "Art Limpieza", "Sueldos", "Vale $$$", "Gastos Fijos", "Gastos varios"]
};

// ---------- Estado ----------
export let socios = [];           // ["Sergio", "Ana", "Marcos"] — los 3 socios, entran en el reparto
export let colaboradores = [];    // ["Encargada"] — pueden pagar/cargar, NO entran en el reparto
export let colaboradorNegocio = {}; // { "Encargada": "pancho" | "heladeria" } — si un colaborador no
                              // aparece acá, ve los 2 negocios (ver negociosPermitidos()). Los
                              // 3 socios siempre ven los 2, nunca están en este mapa.
export let admins = [];           // subconjunto de nombres (normalmente socios) con permiso para editar/borrar
export let pins = {};             // { "Sergio": "1234", ... } — PIN fijo de 4 dígitos por persona (ver README: no es seguridad real, solo identificación)
export let claveMaestraAdmin = ""; // clave compartida entre los admins, solo para CREAR su PIN la primera vez
                             // en un celular nuevo (ver openPinModal/confirmPinModal) — evita que cualquiera
                             // tocando "Sergio" por primera vez se autoasigne el PIN de admin sin saberla.
                             // Si no está configurada (vacía), no se pide — no es seguridad real, ver README.
export let cajaLocalMonto = 0;     // OBSOLETO: era el total repuesto de la caja del local cuando se
                             // manejaba con un solo número editable desde Ajustes. Ahora eso vive
                             // en la colección "reposiciones" y este campo lo migra a cero
                             // migrarMontoInicialCaja(). No se edita desde ningún lado; se sigue
                             // sumando en cajaLocalCalculo() solo por si todavía no se migró (o un
                             // celular tiene la config vieja en caché) — es plata real pendiente de
                             // pasar a "reposiciones", no un parche para tapar una carga lenta (eso
                             // lo maneja reposicionesCargadas).
export let gastos = [];           // TODOS los gastos, de los 2 negocios — [{id, importe, descripcion, categoria, pagadoPor, fecha, negocio}]
export let facturaciones = [];    // TODOS los cierres diarios, de los 2 negocios — [{id, importe, registradoPor, fecha, negocio}]
export let reposiciones = [];     // TODAS las reposiciones de la caja del local, de los 2 negocios — [{id, monto, nota, negocio, repuestoPor, fecha}], filtradas por reposicionesDelNegocio()
export let reposicionesCargadas = false; // false hasta el primer snapshot de listenReposiciones() — antes de eso, reposiciones=[] no significa "caja vacía", significa "todavía no sabemos". Ver cajaLocalCalculo().
export let ideas = [];            // TODAS las ideas de mejora, de los 2 negocios — [{id, texto, estado, propuestoPor, negocio, creadoEn}], filtradas por ideasDelNegocio()
export let categoriasGasto = CATEGORIAS_GASTO_DEFAULT;
export let categoriasGastoSembrado = false; // evita reescribir el default más de una vez por sesión
let fotosLimpiezaHecha = false;

// Setters para el único otro código (fuera de este módulo) que necesita
// tocar este estado sin pasar por Firestore primero: guardarClaveMaestra()
// y migrarMontoInicialCaja() en app.js, después de que su propia
// escritura a Firestore ya se confirmó.
export function setClaveMaestraLocal(valor) {
  claveMaestraAdmin = valor;
}
export function marcarCajaLocalMigrada() {
  cajaLocalMonto = 0;
}

// La Caja del local hoy es "solo de Pancho", pero en vez de repetir
// comparaciones con el string "pancho" desparramadas en cada función que
// la muestra/oculta (render, modal de gasto, etc.), se pregunta acá — si
// el día de mañana Heladería también quiere una, alcanza con poner
// tieneCajaLocal:true en su entrada de NEGOCIOS, sin tocar el resto.
export function negocioTieneCajaLocal(id) {
  const biz = NEGOCIOS.find(b => b.id === id);
  return !!(biz && biz.tieneCajaLocal);
}

export function categoriasDelNegocio(negocioId) {
  return categoriasGasto[negocioId] || categoriasGasto.pancho || [];
}

// Vuelca el doc config/socios en las variables globales — se llama desde
// los 3 lugares donde se lee ese doc (connectAndBoot, listenSocios,
// handleSetupConnect) para no repetir el mismo bloque 3 veces. Si el día
// de mañana se agrega un campo nuevo al doc (como pasó con
// cajaLocalMonto), alcanza con tocar esta única función.
export function aplicarConfigSocios(data) {
  socios = data.socios;
  colaboradores = Array.isArray(data.colaboradores) ? data.colaboradores : [];
  colaboradorNegocio = data.colaboradorNegocio && typeof data.colaboradorNegocio === "object" ? data.colaboradorNegocio : {};
  admins = Array.isArray(data.admins) ? data.admins : [];
  pins = data.pins && typeof data.pins === "object" ? data.pins : {};
  claveMaestraAdmin = typeof data.claveMaestraAdmin === "string" ? data.claveMaestraAdmin : "";
  cajaLocalMonto = Number(data.cajaLocalMonto) || 0;
  if (data.categoriasGasto && typeof data.categoriasGasto === "object") {
    categoriasGasto = data.categoriasGasto;
  }
}

export async function connectAndBoot(config, namesFromInput, colabFromInput) {
  await initFirebase(config);
  const sdk = fbSdk;

  const socioDocRef = sdk.doc(db, "config", "socios");
  const snap = await sdk.getDoc(socioDocRef);

  if (snap.exists() && Array.isArray(snap.data().socios) && snap.data().socios.length === 3) {
    const data = snap.data();
    aplicarConfigSocios(data);
    if (!(data.categoriasGasto && typeof data.categoriasGasto === "object")) {
      // Instalación de antes de que existiera este campo — se siembra una
      // sola vez con el default, para que quede persistido en Firestore.
      categoriasGastoSembrado = true;
      categoriasGasto = CATEGORIAS_GASTO_DEFAULT;
      await sdk.updateDoc(socioDocRef, { categoriasGasto }).catch(() => {});
    }
  } else {
    if (!namesFromInput || namesFromInput.some(n => !n.trim())) {
      throw new Error("Completá los nombres de los 3 socios.");
    }
    socios = namesFromInput.map(n => n.trim());
    colaboradores = (colabFromInput || []).map(n => n.trim()).filter(Boolean);
    colaboradorNegocio = {};
    admins = [];
    pins = {};
    claveMaestraAdmin = "llavez";
    categoriasGasto = CATEGORIAS_GASTO_DEFAULT;
    categoriasGastoSembrado = true;
    await sdk.setDoc(socioDocRef, { socios, colaboradores, colaboradorNegocio, admins, pins, claveMaestraAdmin, categoriasGasto });
  }

  localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(config));
  localStorage.setItem(LS_SOCIOS_CACHE, JSON.stringify(socios));
  localStorage.setItem(LS_COLAB_CACHE, JSON.stringify(colaboradores));

  bootApp();
}

// Gastos del negocio actualmente seleccionado (de la lista completa que
// ya sincronizamos con Firestore).
export function gastosDelNegocio() {
  return gastos.filter(g => g.negocio === negocioActual);
}

// Cierres de facturación del negocio actualmente seleccionado.
export function facturacionesDelNegocio() {
  return facturaciones.filter(f => f.negocio === negocioActual);
}

// Ideas/Metas del negocio actualmente seleccionado. Antes eran
// compartidas entre los 2 negocios (sin campo "negocio"); ahora cada
// negocio tiene las suyas, igual que gastos y facturación. Las ideas
// viejas, creadas antes de este cambio, no tienen "negocio" guardado —
// se siguen mostrando en los dos negocios (en vez de desaparecer) hasta
// que alguien las recargue como nuevas, ya con negocio asignado.
// Reposiciones de la caja del negocio actualmente seleccionado. Mismo
// criterio que ideasDelNegocio(): si algún doc quedara sin "negocio"
// (no debería pasar, pero un import viejo o manual podría hacerlo), se
// sigue mostrando en los dos negocios en vez de desaparecer sin aviso.
export function reposicionesDelNegocio() {
  return reposiciones.filter(r => r.negocio === negocioActual || !r.negocio);
}

export function ideasDelNegocio() {
  return ideas.filter(i => i.negocio === negocioActual || !i.negocio);
}

export function listenSocios() {
  const socioDocRef = fbSdk.doc(db, "config", "socios");
  fbSdk.onSnapshot(socioDocRef, (snap) => {
    if (snap.exists() && Array.isArray(snap.data().socios)) {
      const data = snap.data();
      aplicarConfigSocios(data);
      if (!(data.categoriasGasto && typeof data.categoriasGasto === "object") && !categoriasGastoSembrado) {
        // Instalación de antes de que existiera este campo — se siembra una
        // sola vez con el default, para que quede persistido en Firestore.
        categoriasGastoSembrado = true;
        categoriasGasto = CATEGORIAS_GASTO_DEFAULT;
        fbSdk.updateDoc(socioDocRef, { categoriasGasto }).catch(() => {});
      }
      localStorage.setItem(LS_SOCIOS_CACHE, JSON.stringify(socios));
      localStorage.setItem(LS_COLAB_CACHE, JSON.stringify(colaboradores));
      setEsAdmin(usuarioActual ? admins.includes(usuarioActual) : false);
      migrarMontoInicialCaja();
      aplicarPermisosDeVista();
      renderPagadorChips();
      renderPagadorChipsFacturado();
      renderAjustesSocios();
      renderNegocioCards();
      renderBalance();
      renderGastos();
      renderGastosAdmin();
      renderFacturado();
      renderIdeas();
      if (negocioActual) renderResumen();
    }
  });
}

export function listenGastos() {
  const q = fbSdk.query(fbSdk.collection(db, "gastos"), fbSdk.orderBy("fecha", "desc"));
  fbSdk.onSnapshot(q, (snapshot) => {
    gastos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderGastos();
    renderGastosAdmin();
    renderBalance();
    // La pantalla "Caja del local — Detalle" también lista gastos (los
    // "caja"), no solo reposiciones — si no se refresca acá, editar o
    // borrar uno desde esa pantalla la dejaba con datos viejos hasta que
    // cambiara algo de reposiciones (bug real que hubo).
    renderCajaLocalDetalle();
    if (negocioActual) renderResumen();
    setSyncOffline(false);
    if (!fotosLimpiezaHecha) {
      fotosLimpiezaHecha = true;
      limpiarFotosVencidas();
    }
  }, (err) => {
    console.error(err);
    setSyncOffline(true);
  });
}

export function listenFacturacion() {
  const q = fbSdk.query(fbSdk.collection(db, "facturacion"), fbSdk.orderBy("fecha", "desc"));
  fbSdk.onSnapshot(q, (snapshot) => {
    facturaciones = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFacturado();
    if (negocioActual) renderResumen();
    setSyncOffline(false);
  }, (err) => {
    console.error(err);
    setSyncOffline(true);
  });
}

// Reposiciones de la caja del local (ver cajaLocalCalculo). Es una
// colección aparte y no un número en config/socios como el monto
// inicial, justamente para tener el historial de quién puso cuánto,
// cuándo y por qué.
export function listenReposiciones() {
  const q = fbSdk.query(fbSdk.collection(db, "reposiciones"), fbSdk.orderBy("fecha", "desc"));
  fbSdk.onSnapshot(q, (snapshot) => {
    reposiciones = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    reposicionesCargadas = true;
    renderGastos();          // la card de Caja del local vive en la pestaña Gastos
    renderCajaLocalDetalle();
    if (negocioActual) renderResumen();
    setSyncOffline(false);
  }, (err) => {
    console.error(err);
    setSyncOffline(true);
  });
}

// Compartidas entre los 2 negocios a propósito — no se filtran por "negocio".
export function listenIdeas() {
  const q = fbSdk.query(fbSdk.collection(db, "ideas"), fbSdk.orderBy("creadoEn", "desc"));
  fbSdk.onSnapshot(q, (snapshot) => {
    ideas = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderIdeas();
    setSyncOffline(false);
  }, (err) => {
    console.error(err);
    setSyncOffline(true);
  });
}

export function setSyncOffline(isOffline) {
  $$(".sync-dot").forEach(d => d.classList.toggle("offline", isOffline));
}

export function listenConnectivity() {
  const update = () => setSyncOffline(!navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}
