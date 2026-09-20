// ============================================================
// Utilidades transversales — sin dependencias de Firebase ni de
// estado de negocio. Money, fechas, DOM, tema, CSV, etc.
// ============================================================

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Plata ----------
export function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// `null` es "todavía no sabemos" (ver cajaLocalCalculo/reposicionesCargadas),
// no "cero" — money(null) daría "$0", un monto falso. Único lugar que
// distingue ambos casos al pintar un monto de la caja del local.
export function montoOCargando(n) {
  return n === null ? "…" : money(n);
}

// Inputs de plata (Importe, Efectivo, Digital, Cierre, Caja del local): se
// muestran con punto de miles mientras se tipea (ej. "100.000"), igual que
// money() ya las muestra una vez guardadas — así se nota de un vistazo si
// faltó o sobró un cero. Por eso estos campos son type="text" en el HTML
// en vez de type="number" (que no puede mostrar el punto de miles: lo
// interpretaría como separador decimal). parseMoneyInput()/
// formatMoneyValue() traducen entre el string que ve el usuario (miles con
// ".", decimal con "," — estilo es-AR, igual que money()) y el number con
// el que trabaja el resto del código. El valor que llega acá siempre viene
// ya normalizado a "," por formatMoneyInputMientrasTipea, aunque la
// persona haya tipeado "." como decimal (ver esa función).
export function parseMoneyInput(str) {
  if (str == null) return NaN;
  const limpio = String(str).trim().replace(/\./g, "").replace(",", ".");
  return limpio === "" ? NaN : parseFloat(limpio);
}

export function formatMoneyValue(n) {
  return Number.isFinite(n) ? n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : "";
}

// Evita arrastrar el error de punto flotante de restar/sumar montos (ej.
// 10.1 - 3.3 da 6.799999999999999 en JS) antes de mostrar el resultado.
export function redondearCentavos(n) {
  return Math.round(n * 100) / 100;
}

// Filtra lo que se tipea (solo dígitos y un separador decimal) y agrega
// los puntos de miles a medida que se escribe — con "input" (cada
// tecla), a propósito distinto del cálculo cruzado entre campos
// (calcularCampoMixtoFaltante / calcularCampoFaltanteFacturado), que va
// con "change" para no calcular a medio tipear. Acá sí tiene que ser
// instantáneo: si no, el punto de miles no se vería mientras se escribe.
//
// Acepta "," O "." como separador decimal tipeado: todo iPhone (sea cual
// sea el idioma del celular) solo tiene "." en el teclado numérico, así
// que tratarlo siempre como separador de miles hacía que "1500.50"
// terminara guardado como $150.050 (bug real que hubo). Para decidir
// cuál es cuál: el ÚLTIMO "," o "." tipeado cuenta como decimal solo si
// tiene 2 dígitos o menos después — un "." seguido de 3 dígitos es el
// separador de miles que esta misma función ya insertó antes.
//
// El cursor se reubica contando cuántos dígitos había antes de él y
// buscando esa misma posición en el valor ya formateado, en vez de
// mandarlo siempre al final — así corregir un dígito a mitad del monto
// no hace saltar el cursor (bug real que hubo).
export function formatMoneyInputMientrasTipea(e) {
  const el = e.target;
  const digitosAntesDelCursor = el.value.slice(0, el.selectionStart).replace(/\D/g, "").length;

  const idxDecimal = Math.max(el.value.lastIndexOf(","), el.value.lastIndexOf("."));
  const digitosDespues = idxDecimal === -1 ? Infinity : el.value.length - idxDecimal - 1;
  const hayDecimal = idxDecimal !== -1 && digitosDespues <= 2;

  let enteros = (hayDecimal ? el.value.slice(0, idxDecimal) : el.value).replace(/\D/g, "");
  const decimales = hayDecimal ? "," + el.value.slice(idxDecimal + 1).replace(/\D/g, "").slice(0, 2) : "";
  enteros = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  el.value = enteros + decimales;

  let nuevaPos = 0;
  if (digitosAntesDelCursor > 0) {
    nuevaPos = el.value.length;
    let vistos = 0;
    for (let i = 0; i < el.value.length; i++) {
      if (/\d/.test(el.value[i])) {
        vistos++;
        if (vistos === digitosAntesDelCursor) { nuevaPos = i + 1; break; }
      }
    }
  }
  el.setSelectionRange(nuevaPos, nuevaPos);
}

export function wireMoneyInput(id) {
  $(id).addEventListener("input", formatMoneyInputMientrasTipea);
}

// Devuelve una versión de `fn` que espera `ms` sin que la vuelvan a llamar
// para recién ahí ejecutarla — se usa para el cálculo cruzado de Mixto y
// Facturado (ver más abajo): en iPhone el "change" (dispara al perder el
// foco el campo) a veces no llega a tiempo, o llega DESPUÉS del click de
// "Guardar" en vez de antes (bug conocido de Safari/WebKit en iOS), y el
// campo calculado quedaba vacío por más que los otros dos ya estuvieran
// completos. Escuchando también "input" con este debounce, el cálculo se
// dispara solo con que la persona deje de tipear un rato, sin depender de
// que el foco cambie de campo.
export function debounce(fn, ms) {
  let temporizador;
  return (...args) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Fechas ----------
export const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export function mesLabel(date) {
  return `${MESES[date.getMonth()]} ${date.getFullYear()}`;
}
export function fechaDeRegistro(item) {
  return item.fecha && item.fecha.toDate ? item.fecha.toDate() : new Date(item.fecha || Date.now());
}

// Primer día del mes que resulta de sumarle offsetMeses al mes actual —
// usado por los navegadores de mes de Gastos, Gastos S/Admin, Facturado y
// Resumen mensual (cada pantalla con su propio offset independiente).
export function fechaBaseDelMes(offsetMeses) {
  const d = new Date();
  d.setDate(1); // evita saltos raros de mes al sumar/restar meses
  d.setMonth(d.getMonth() + offsetMeses);
  return d;
}

export function esMismoMes(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

// Fecha de un Date en formato "AAAA-MM-DD", en hora LOCAL — a propósito
// NO se usa .toISOString() para esto: esa función siempre da la fecha en
// UTC, así que de noche en Argentina (UTC-3), pasadas las ~21:00 ya es
// "mañana" en UTC — el campo de fecha quedaba pre-completado con el día
// (a veces hasta el mes) siguiente al real, y esos gastos/cierres
// terminaban sin sumar en el mes correcto en Gastos ni en Resumen mensual.
export function fechaLocalISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Compara solo año/mes/día (ignora la hora) — usado por cierreFaltanteHoy()
// para saber si un cierre guardado corresponde al día que se está esperando.
export function esMismoDia(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// ---------- Imágenes ----------
// Redimensiona y comprime la foto en el navegador antes de subirla, para que
// no pese varios MB (como sale de la cámara) sino unos cientos de KB.
export function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error("No se pudo procesar la imagen."));
      }, "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen."));
    };
    img.src = url;
  });
}

// ---------- Toast / pantallas ----------
export function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

export function showScreen(id) {
  $$(".screen").forEach(s => s.classList.remove("active"));
  $("#" + id).classList.add("active");
}

// ---------- Tema (Claro/Oscuro/Auto) ----------
// Todo pasa por el atributo data-theme en <html>: la paleta oscura vive en
// un solo lugar, :root[data-theme="dark"] (ver styles.css) — "Auto" no es
// más que este mismo mecanismo, decidido acá copiando matchMedia en vez de
// por elección del usuario. La primera aplicación (antes de que este
// script exista) ya la hace un script sincrónico al principio de
// index.html, para que no haya flash del tema equivocado; si se cambia la
// cuenta de acá, cambiar también esa.
export const LS_TEMA_KEY = "gn_tema"; // "auto" | "light" | "dark"
export const MQ_OSCURO = window.matchMedia("(prefers-color-scheme: dark)");

export function esOscuroSegunTema(tema) {
  return tema === "dark" || (tema !== "light" && MQ_OSCURO.matches);
}

export function aplicarTema(tema) {
  document.documentElement.setAttribute("data-theme", esOscuroSegunTema(tema) ? "dark" : "light");
  $$(".tema-btn").forEach(b => b.classList.toggle("active", b.dataset.tema === tema));
}

export function elegirTema(tema) {
  localStorage.setItem(LS_TEMA_KEY, tema);
  aplicarTema(tema);
}

// Si la app queda abierta en "Auto" y cambia el modo del celular (ej. se
// hace de noche y el sistema pasa a oscuro solo), hay que enterarse en el
// momento, no recién la próxima vez que se abra.
MQ_OSCURO.addEventListener("change", () => {
  if ((localStorage.getItem(LS_TEMA_KEY) || "auto") === "auto") aplicarTema("auto");
});

// ---------- Seguridad ----------
// Todo texto que viene de Firestore (descripción, nombres) pasa por acá antes
// de insertarse con innerHTML, para evitar XSS. Cualquier campo de texto
// nuevo que se agregue a un template debe escaparse igual.
export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- Exportar datos (CSV) ----------
export function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

export function downloadCSV(filename, rows) {
  const csv = rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
  // BOM al principio para que Excel detecte UTF-8 y no rompa los acentos.
  const BOM = String.fromCharCode(0xFEFF);
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Promesas ----------
// Si Storage no responde (bucket no activado, reglas, red que ni siquiera
// llega a fallar), uploadBytes/getDownloadURL pueden quedar la promesa
// colgada para siempre — el botón "Subiendo foto…" no volvía nunca y no
// había forma de reintentar. Este timeout garantiza que siempre termine.
export function conTimeout(promise, ms, mensajeTimeout) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(mensajeTimeout)), ms))
  ]);
}

// ---------- Tabs ----------
// OJO: el selector de acá adentro está limitado a #screen-app a propósito.
// Las pantallas de Facturado / Resumen / Fotos guardadas también usan la
// clase .tab (para heredar el mismo estilo de scroll/padding) pero no son
// parte de este tabbar — si se les sacara "active" con un $$(".tab") global,
// quedarían en blanco la primera vez que se toque cualquier pestaña.
export function switchTab(name) {
  $("#screen-app").querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  $$(".tabbtn").forEach(b => b.classList.remove("active"));
  $("#tab-" + name).classList.add("active");
  $(`.tabbtn[data-tab="${name}"]`).classList.add("active");
  $("#fab-add").classList.toggle("hidden", name !== "gastos");
}
