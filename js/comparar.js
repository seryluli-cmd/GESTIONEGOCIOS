// ============================================================
// Estadísticas (solo admin, y solo en los negocios con
// negocioTieneEstadisticas(): hoy Pancho Recreo y Heladería Pablo) — vistas
// calculadas sobre los gastos y cierres ya guardados, no tocan ni mueven ningún dato.
// Se eligen con fichas (X MES, X TURNO, X TRAMO, X EMPLEADO) que adelantan el
// dato clave de cada vista para el mes elegido; X TURNO solo existe en los
// negocios que trabajan por turnos (Pancho: Mañana y Noche):
//   · "Por mes":   un bloque por mes con Efectivo, Digital, suma y Gastos.
//   · "Por turno": lo facturado en cada turno del mes elegido contra el mes
//     anterior (en el mes en curso, hasta el mismo día en los dos).
//   · "Por tramo": un mes partido en días 1–10, 11–20 y 21–fin, para ver en
//     qué parte del mes entra (y sale) la plata.
//   · "Por empleado": cuánto subió o bajó el promedio por turno de cada
//     integrante contra el mes anterior, según los cierres de turno (en un
//     negocio sin turnos, como Heladería, cada cierre diario cuenta como uno).
//     Debajo, el podio de turnos: cuál de los turnos subió más su promedio
//     (solo en los negocios que trabajan por turnos).
// ============================================================
import { $, $$, escapeHtml, fechaBaseDelMes, fechaDeRegistro, mesLabel, money } from "./utilidades.js";
import { payerColorVar } from "../app.js";
import { colaboradores, gastosDelNegocio, facturacionesDelNegocio, negocioTieneTurnos } from "./datos.js";
import { negocioActual, esAdmin } from "./sesion.js";
import { idsTurnosFacturado, nombreCortoTurnoFacturado } from "./modal-facturado.js";

// Esta app baja TODO el historial de Firestore (no hay tope de meses), así que
// hasta dónde se puede retroceder lo marca el registro más viejo del negocio:
// más atrás solo hay meses vacíos.
function mesesAtrasMax() {
  const ahora = new Date();
  let max = 0;
  facturacionesDelNegocio().concat(gastosDelNegocio()).forEach(item => {
    const d = fechaDeRegistro(item);
    max = Math.max(max, (ahora.getFullYear() - d.getFullYear()) * 12 + ahora.getMonth() - d.getMonth());
  });
  return max;
}

// Para comparar a una persona contra su mes anterior hacen falta turnos
// suficientes en los dos: con 1 o 2 cierres, un solo turno bueno o malo
// movería el porcentaje y se premiaría (o castigaría) al azar.
const MIN_TURNOS = 4;

// Estado de la pantalla. Vive acá y no en `state` porque nadie más lo lee.
// `animar` hace que las columnas crezcan una sola vez al abrir o cambiar de
// vista — sin esto, cada cambio que llega de Firestore las volvería a animar.
const ui = { vista: "mes", offset: 0, modo: "total", animar: false };

const TRAMOS = [{ desde: 1, hasta: 10 }, { desde: 11, hasta: 20 }, { desde: 21, hasta: null }];

// ---------- Formato ----------

// 1.234.567 → "1,2M", 85.000 → "85K", 2.500 → "2,5K". Para etiquetas chicas
// de gráfico: el valor exacto siempre está en el tooltip y en la tabla.
function compacto(n) {
  const v = Math.round(Math.abs(n));
  if (v >= 1e6) return (Math.round(v / 1e5) / 10).toLocaleString("es-AR") + "M";
  if (v >= 1e3) {
    const k = v / 1e3;
    return (k < 10 ? Math.round(k * 10) / 10 : Math.round(k)).toLocaleString("es-AR") + "K";
  }
  return String(v);
}

// Escala del eje Y con 4 intervalos de paso "redondo" (1, 2, 2,5 o 5 × 10^n).
function escala(max) {
  const bruto = Math.max(max, 1) / 4;
  const exp = Math.pow(10, Math.floor(Math.log10(bruto)));
  const f = bruto / exp;
  const paso = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  return { paso, max: paso * 4 };
}

// "+$1.234" / "-$1.234". money() siempre recibe un valor positivo — el signo
// se antepone a mano para que no quede el "$-1.234" que da toLocaleString.
function conSigno(n) {
  const r = Math.round(n);
  return (r < 0 ? "-" : r > 0 ? "+" : "") + money(Math.abs(r));
}

function flechaResultado(n) {
  const r = Math.round(n);
  if (r === 0) return `<span class="cmp-flecha">=</span>`;
  return `<span class="cmp-flecha ${r > 0 ? "cmp-sube" : "cmp-baja"}">${r > 0 ? "▲" : "▼"}</span>`;
}

// Cuánto cambió `a` contra `p` (el mes anterior), en % con flecha. "—" si el mes
// anterior no tiene nada con qué comparar.
function deltaHtml(a, p) {
  if (p <= 0) return `<span class="cmp-delta">—</span>`;
  const pct = Math.round(((a - p) / p) * 100);
  return pct === 0
    ? `<span class="cmp-delta">= 0%</span>`
    : `<span class="cmp-delta">${flechaResultado(pct)}${Math.abs(pct)}%</span>`;
}

// ---------- Datos por tramo ----------

// El mes (offset 0 = actual, -1 = anterior...) partido en 3 tramos, con
// Efectivo / Digital / Facturado / Gastos de cada uno. `contados` son los
// días del tramo que ya pasaron: en el mes en curso el tramo de hoy está a
// medias y el que no empezó no tiene días — el promedio por día se calcula
// sobre días reales, no sobre los 10 completos.
function datosTramos(offset) {
  const base = fechaBaseDelMes(offset);
  const y = base.getFullYear();
  const m = base.getMonth();
  const diasMes = new Date(y, m + 1, 0).getDate();
  const hoy = new Date();
  const esActual = hoy.getFullYear() === y && hoy.getMonth() === m;

  const tramos = TRAMOS.map(t => {
    const hasta = t.hasta || diasMes;
    const dias = hasta - t.desde + 1;
    const contados = esActual ? Math.max(0, Math.min(hasta, hoy.getDate()) - t.desde + 1) : dias;
    return {
      desde: t.desde, hasta, dias, contados,
      label: `${t.desde}–${hasta}`,
      estado: contados === 0 ? "futuro" : contados < dias ? "curso" : "completo",
      efectivo: 0, digital: 0, total: 0, gastos: 0
    };
  });
  const tramoDe = (d) => tramos[d <= 10 ? 0 : d <= 20 ? 1 : 2];
  const fechaEnMes = (item) => {
    const d = fechaDeRegistro(item);
    return d.getFullYear() === y && d.getMonth() === m ? d : null;
  };

  facturacionesDelNegocio().forEach(f => {
    const d = fechaEnMes(f);
    if (!d) return;
    const t = tramoDe(d.getDate());
    t.efectivo += Number(f.efectivo) || 0;
    t.digital += Number(f.digital) || 0;
    t.total += Number(f.importe) || 0;
  });
  gastosDelNegocio().forEach(g => {
    const d = fechaEnMes(g);
    if (d) tramoDe(d.getDate()).gastos += Number(g.importe) || 0;
  });
  tramos.forEach(t => {
    // Cierres anteriores al desglose Efectivo/Digital: cuentan en el total
    // pero no en ninguno de los dos — se muestran aparte, sin inventar un reparto.
    t.sinDesglose = Math.max(0, t.total - t.efectivo - t.digital);
    t.resultado = t.total - t.gastos;
  });
  return { base, esActual, tramos, hayDatos: tramos.some(t => t.total || t.gastos) };
}

// Valor de un tramo según el modo elegido: total del tramo o promedio por día.
function valor(t, k) {
  return ui.modo === "dia" ? (t.contados ? t[k] / t.contados : 0) : t[k];
}

const etiquetaModo = () => ui.modo === "dia" ? "por día" : "del tramo";

// ---------- Vista "Por tramo": resumen ----------

function heroHtml(act) {
  const tr = act.tramos;
  const totalMes = tr.reduce((s, t) => s + t.total, 0);
  const gastosMes = tr.reduce((s, t) => s + t.gastos, 0);
  const resultado = totalMes - gastosMes;

  // Frase de conclusión: el tramo más fuerte (en total, o por día según el
  // modo — por día es la comparación justa cuando los tramos tienen distinta cantidad de días).
  const candidatos = tr.filter(t => t.contados > 0 && t.total > 0);
  let frase = "Todavía no hay cierres cargados este mes.";
  if (candidatos.length) {
    const mejor = candidatos.reduce((a, b) => valor(b, "total") > valor(a, "total") ? b : a);
    frase = ui.modo === "dia"
      ? `Mejor ritmo: días ${mejor.label}, con ${money(Math.round(valor(mejor, "total")))} por día.`
      : `El tramo ${mejor.label} concentró el ${Math.round((mejor.total / totalMes) * 100)}% de lo facturado.`;
  }

  const cinta = totalMes > 0
    ? `<div class="cmp-cinta" role="img" aria-label="Reparto de lo facturado por tramo">${
        tr.map((t, i) => t.total > 0 ? `<span class="cmp-t${i}" style="flex:${t.total}"></span>` : "").join("")
      }</div>
      <div class="cmp-cinta-leyenda">${
        tr.map((t, i) => `<span><i class="cmp-t${i}"></i>${t.label}<b>${totalMes ? Math.round((t.total / totalMes) * 100) : 0}%</b></span>`).join("")
      }</div>`
    : "";

  return `
    <section class="cmp-card cmp-hero">
      <div class="cmp-hero-label">Facturado en ${mesLabel(act.base)}</div>
      <div class="cmp-hero-valor">${money(totalMes)}</div>
      <p class="cmp-hero-frase">${frase}</p>
      ${cinta}
      <div class="cmp-hero-stats">
        <div><span class="cmp-stat-label"><i class="cmp-pt cmp-ga"></i>Gastos</span><b>${money(gastosMes)}</b></div>
        <div><span class="cmp-stat-label">Resultado</span><b>${flechaResultado(resultado)}${conSigno(resultado)}</b></div>
      </div>
    </section>`;
}

// ---------- Vista "Por tramo": gráfico principal ----------

// Un SVG a mano (sin librerías): por tramo, una columna de Facturado
// (Efectivo y Digital apilados) y una de Gastos, en el mismo eje.
function graficoHtml(act) {
  const tr = act.tramos;
  const W = 340, H = 252, L = 34, R = 6, T = 22, B = 46;
  const pw = W - L - R, ph = H - T - B, gw = pw / 3, bw = 24, sep = 6;
  const maxVal = Math.max(1, ...tr.flatMap(t => [valor(t, "total"), valor(t, "gastos")]));
  const esc = escala(maxVal);
  const yDe = (v) => T + ph - (v / esc.max) * ph;
  const base = T + ph;

  // Rectángulo con el borde de arriba redondeado (4px) y el de abajo recto.
  const columna = (clase, x, y, h) => {
    const r = Math.min(4, h / 2);
    return `<path class="${clase}" d="M${x} ${y + h}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${bw - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h}Z"/>`;
  };

  let svg = `<svg class="cmp-svg${ui.animar ? " cmp-anim" : ""}" viewBox="0 0 ${W} ${H}" role="group" aria-label="Facturado y gastos por tramo del mes">`;
  for (let i = 0; i <= 4; i++) {
    const yy = yDe(esc.paso * i);
    svg += `<line class="cmp-grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="cmp-tick" x="${L - 6}" y="${yy + 3.5}" text-anchor="end">${i === 0 ? "0" : compacto(esc.paso * i)}</text>`;
  }

  tr.forEach((t, i) => {
    const gx = L + i * gw;
    const cx = gx + gw / 2;
    const x0 = cx - (bw * 2 + sep) / 2;
    const futuro = t.estado === "futuro";

    // Segmentos de Facturado, de abajo hacia arriba, con 2px de aire entre ellos.
    const segs = [["cmp-ef", valor(t, "efectivo")], ["cmp-di", valor(t, "digital")], ["cmp-sd", valor(t, "sinDesglose")]]
      .filter(([, v]) => v > 0);
    let acum = 0;
    let col = "";
    segs.forEach(([clase, v], j) => {
      const h = (v / esc.max) * ph;
      const yAbajo = base - acum;
      const yArriba = yAbajo - h;
      acum += h;
      const top = yArriba + (j < segs.length - 1 ? 1 : 0);
      const bottom = yAbajo - (j > 0 ? 1 : 0);
      if (bottom - top <= 0.5) return;
      col += j === segs.length - 1
        ? columna(clase, x0, top, bottom - top)
        : `<rect class="${clase}" x="${x0}" y="${top}" width="${bw}" height="${bottom - top}"/>`;
    });
    const hG = (valor(t, "gastos") / esc.max) * ph;
    if (hG > 0.5) col += columna("cmp-ga", x0 + bw + sep, base - hG, hG);

    const totalV = valor(t, "total");
    const gastosV = valor(t, "gastos");
    const etiquetas =
      (totalV > 0 ? `<text class="cmp-val" x="${x0 + bw / 2}" y="${yDe(totalV) - 5}" text-anchor="middle">${compacto(totalV)}</text>` : "") +
      (gastosV > 0 ? `<text class="cmp-val" x="${x0 + bw + sep + bw / 2}" y="${yDe(gastosV) - 5}" text-anchor="middle">${compacto(gastosV)}</text>` : "");

    const sub = futuro ? "sin comenzar" : t.estado === "curso" ? `en curso · día ${t.contados}` : `${t.dias} días`;
    svg += `
      <g class="cmp-grupo" data-i="${i}">
        <rect class="cmp-hit" x="${gx}" y="${T - 14}" width="${gw}" height="${ph + B + 14}" rx="10" tabindex="0" role="button"
          aria-label="Días ${t.label}: facturado ${money(Math.round(totalV))}, gastos ${money(Math.round(gastosV))} ${etiquetaModo()}"/>
        <g class="cmp-col">${col}</g>
        ${etiquetas}
        <text class="cmp-x1" x="${cx}" y="${H - B + 17}" text-anchor="middle">Días ${t.label}</text>
        <text class="cmp-x2" x="${cx}" y="${H - B + 32}" text-anchor="middle">${sub}</text>
      </g>`;
  });
  svg += `<line class="cmp-base" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/></svg>`;

  const haySd = tr.some(t => t.sinDesglose > 0.5);
  const resultados = tr.map(t => {
    if (t.estado === "futuro") return `<div class="cmp-res-celda cmp-res-nada">—</div>`;
    const r = valor(t, "resultado");
    return `<div class="cmp-res-celda">${flechaResultado(r)}<b>${Math.round(r) < 0 ? "-" : "+"}$${compacto(r)}</b></div>`;
  }).join("");

  return `
    <section class="cmp-card">
      <h3 class="cmp-card-titulo">Facturado y gastos por tramo</h3>
      <p class="cmp-card-sub">${ui.modo === "dia" ? "Promedio por día de cada tramo" : "Total de cada tramo"}</p>
      <div class="cmp-leyenda">
        <span><i class="cmp-pt cmp-ef"></i>Efectivo</span>
        <span><i class="cmp-pt cmp-di"></i>Digital</span>
        <span><i class="cmp-pt cmp-ga"></i>Gastos</span>
        ${haySd ? `<span><i class="cmp-pt cmp-sd"></i>Sin desglose</span>` : ""}
      </div>
      <div class="cmp-chart" id="cmp-chart">${svg}<div class="cmp-tip hidden" id="cmp-tip" role="status"></div></div>
      <div class="cmp-res-titulo">Resultado ${etiquetaModo()} · facturado menos gastos</div>
      <div class="cmp-res-fila">${resultados}</div>
    </section>`;
}

// ---------- Vista "Por tramo": contra el mes anterior ----------

function contraAnteriorHtml(act, ant) {
  const antTotal = ant.tramos.reduce((s, t) => s + t.total, 0);
  const nombreAnt = mesLabel(ant.base);
  const cabecera = `
      <h3 class="cmp-card-titulo">Contra ${nombreAnt}</h3>
      <p class="cmp-card-sub">Facturado ${etiquetaModo()}, tramo por tramo</p>`;
  if (!antTotal) {
    return `<section class="cmp-card">${cabecera}<p class="cmp-vacio-chico">No hay cierres cargados en ${nombreAnt} para comparar.</p></section>`;
  }

  const maxVal = Math.max(1, ...act.tramos.map(t => valor(t, "total")), ...ant.tramos.map(t => valor(t, "total")));
  const ancho = (v) => Math.max(v > 0 ? 2 : 0, (v / maxVal) * 100);
  const filas = act.tramos.map((t, i) => {
    const a = valor(t, "total");
    const p = valor(ant.tramos[i], "total");
    let delta;
    if (t.estado === "futuro") delta = `<span class="cmp-delta">sin comenzar</span>`;
    else if (t.estado === "curso" && ui.modo === "total") delta = `<span class="cmp-delta">en curso</span>`;
    else delta = deltaHtml(a, p);
    return `
      <div class="cmp-vs-fila">
        <div class="cmp-vs-tramo">Días ${t.label}</div>
        <div class="cmp-vs-barras">
          <div class="cmp-vs-linea"><span class="cmp-vs-barra cmp-vs-act" style="width:${ancho(a)}%"></span><em>${a > 0 ? compacto(a) : ""}</em></div>
          <div class="cmp-vs-linea"><span class="cmp-vs-barra cmp-vs-ant" style="width:${ancho(p)}%"></span><em>${p > 0 ? compacto(p) : ""}</em></div>
        </div>
        ${delta}
      </div>`;
  }).join("");

  return `
    <section class="cmp-card">
      ${cabecera}
      <div class="cmp-leyenda">
        <span><i class="cmp-pt cmp-vs-act"></i>${mesLabel(act.base)}</span>
        <span><i class="cmp-pt cmp-vs-ant"></i>${nombreAnt}</span>
      </div>
      ${filas}
    </section>`;
}

// ---------- Vista "Por tramo": tabla ----------

function tablaHtml(act) {
  const tr = act.tramos;
  const celdas = (t) => ["efectivo", "digital", "total", "gastos", "resultado"]
    .map(k => `<td>${k === "resultado" ? conSigno(valor(t, k)) : money(Math.round(valor(t, k)))}</td>`).join("");
  const mes = {
    efectivo: 0, digital: 0, total: 0, gastos: 0, resultado: 0, contados: 0
  };
  tr.forEach(t => { ["efectivo", "digital", "total", "gastos", "resultado", "contados"].forEach(k => { mes[k] += t[k]; }); });
  return `
    <details class="cmp-card cmp-tabla">
      <summary>Ver los números en tabla</summary>
      <div class="cmp-tabla-scroll">
        <table>
          <caption>${ui.modo === "dia" ? "Promedio por día" : "Total"} de cada tramo — ${mesLabel(act.base)}</caption>
          <thead><tr><th scope="col">Tramo</th><th scope="col">Efectivo</th><th scope="col">Digital</th><th scope="col">Facturado</th><th scope="col">Gastos</th><th scope="col">Resultado</th></tr></thead>
          <tbody>
            ${tr.map(t => `<tr><th scope="row">Días ${t.label}</th>${celdas(t)}</tr>`).join("")}
          </tbody>
          <tfoot><tr><th scope="row">Mes</th>${celdas(mes)}</tr></tfoot>
        </table>
      </div>
    </details>`;
}

// ---------- Tooltip del gráfico ----------

function ocultarTip() {
  const tip = $("#cmp-tip");
  if (tip) tip.classList.add("hidden");
}

function mostrarTip(i, act) {
  const chart = $("#cmp-chart");
  const tip = $("#cmp-tip");
  const t = act.tramos[i];
  if (!chart || !tip) return;
  const fila = (clase, nombre, v, signo) =>
    `<div class="cmp-tip-fila"><span>${clase ? `<i class="cmp-pt ${clase}"></i>` : ""}${nombre}</span><b>${signo ? conSigno(v) : money(Math.round(v))}</b></div>`;
  tip.innerHTML = `
    <div class="cmp-tip-titulo">Días ${t.label} <small>${ui.modo === "dia" ? "promedio por día" : `${t.dias} días`}</small></div>
    ${fila("cmp-ef", "Efectivo", valor(t, "efectivo"))}
    ${fila("cmp-di", "Digital", valor(t, "digital"))}
    ${t.sinDesglose > 0.5 ? fila("cmp-sd", "Sin desglose", valor(t, "sinDesglose")) : ""}
    ${fila("", "Facturado", valor(t, "total"))}
    ${fila("cmp-ga", "Gastos", valor(t, "gastos"))}
    ${fila("", "Resultado", valor(t, "resultado"), true)}`;
  tip.classList.remove("hidden");
  // Centrado sobre el tramo, sin salirse del gráfico.
  const grupo = chart.querySelector(`.cmp-grupo[data-i="${i}"] .cmp-hit`).getBoundingClientRect();
  const caja = chart.getBoundingClientRect();
  const centro = grupo.left - caja.left + grupo.width / 2;
  const izq = Math.min(Math.max(4, centro - tip.offsetWidth / 2), caja.width - tip.offsetWidth - 4);
  tip.style.left = izq + "px";
}

function conectarTip(act) {
  $$("#cmp-chart .cmp-grupo").forEach(g => {
    const i = Number(g.dataset.i);
    const hit = g.querySelector(".cmp-hit");
    g.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") mostrarTip(i, act); });
    g.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") ocultarTip(); });
    hit.addEventListener("focus", () => mostrarTip(i, act));
    hit.addEventListener("blur", ocultarTip);
    g.addEventListener("click", () => mostrarTip(i, act));
  });
}

// ---------- Vista "Por empleado" ----------

// Los cierres del mes cargados por integrantes del equipo (colaboradores),
// agrupados por persona: cuántos turnos hizo, cuánto vendió y su promedio por
// turno. `esperado` es lo que habría vendido si en cada uno de sus turnos
// hubiera vendido lo que vendió el equipo en promedio ese mes en ese mismo
// turno — con eso se arma el índice que corrige por trabajar turnos más
// fuertes (noche) o más flojos (mañana).
function datosEquipo(offset) {
  const base = fechaBaseDelMes(offset);
  const y = base.getFullYear();
  const m = base.getMonth();
  const equipo = new Set(colaboradores);
  // En un negocio con turnos solo cuenta el cierre que tiene turno. Los de antes
  // de que se cargaran por turno (ver FECHA_INICIO_TURNOS en modal-facturado.js)
  // son el total de TODO el día: mezclados con los de medio día inflarían el
  // promedio por turno de ese mes y harían parecer una baja lo que no lo es.
  const idsTurnos = negocioTieneTurnos(negocioActual) ? idsTurnosFacturado() : null;
  let sinTurno = 0;
  const cierres = facturacionesDelNegocio().filter(f => {
    if (!equipo.has(f.registradoPor)) return false;
    const d = fechaDeRegistro(f);
    if (d.getFullYear() !== y || d.getMonth() !== m) return false;
    if (idsTurnos && !idsTurnos.includes(f.turno)) { sinTurno++; return false; }
    return true;
  });

  const porTurno = new Map();
  cierres.forEach(f => {
    const k = f.turno || "?";
    const t = porTurno.get(k) || { suma: 0, n: 0 };
    t.suma += Number(f.importe) || 0;
    t.n++;
    porTurno.set(k, t);
  });

  const personas = new Map();
  cierres.forEach(f => {
    const p = personas.get(f.registradoPor) || { nombre: f.registradoPor, turnos: 0, total: 0, esperado: 0 };
    const t = porTurno.get(f.turno || "?");
    p.turnos++;
    p.total += Number(f.importe) || 0;
    p.esperado += t.suma / t.n;
    personas.set(f.registradoPor, p);
  });
  personas.forEach(p => {
    p.promedio = p.total / p.turnos;
    p.indice = p.esperado > 0 ? (p.total / p.esperado) * 100 : null;
  });
  return { base, personas, hayEquipo: equipo.size > 0, sinTurno };
}

// Cuánto subió o bajó (en %) el promedio por turno de `p` contra el del mes
// anterior `q`. null si no hay mes anterior o si en alguno de los dos hay menos
// de MIN_TURNOS cierres. Único lugar que lo calcula: lo usan las personas y
// también los turnos.
function variacionDelPromedio(p, q) {
  const comparable = q && p.turnos >= MIN_TURNOS && q.turnos >= MIN_TURNOS && q.promedio > 0;
  return comparable ? (p.promedio / q.promedio - 1) * 100 : null;
}

// De la que más subió a la que más bajó; al final, los que no se pueden comparar.
function ordenarPorVariacion(filas) {
  const clave = (f) => f.variacion === null ? -Infinity : f.variacion;
  return filas.sort((a, b) => clave(a) === clave(b) ? b.promedio - a.promedio : clave(b) - clave(a));
}

// Cada persona del mes con su variación del promedio por turno contra el mes
// anterior (null si no hay turnos suficientes en alguno de los dos), de la
// que más subió a la que más bajó; al final quienes no se pueden comparar.
function evolucionEquipo(act, ant) {
  const filas = Array.from(act.personas.values()).map(p => {
    const q = ant.personas.get(p.nombre) || null;
    return { ...p, previo: q, variacion: variacionDelPromedio(p, q) };
  });
  return ordenarPorVariacion(filas);
}

// ---------- Turnos ----------

// Los turnos del negocio, en orden: el id que se guarda en el cierre y su nombre.
// Único lugar que dice cuáles son; un cierre sin turno (los de antes de que se
// cargaran por turno) no entra al podio.
function turnosDelNegocio() {
  return negocioTieneTurnos(negocioActual)
    ? idsTurnosFacturado().map(id => ({ id, nombre: nombreCortoTurnoFacturado(id) }))
    : [];
}

// Los cierres del mes de todo el negocio agrupados por turno: cuántos hubo
// (`turnos`, igual que en las personas), cuánto se vendió y el promedio de cada
// uno. A diferencia de datosEquipo no se limita a lo que cargó el equipo: un
// turno rinde lo mismo lo cierre quien lo cierre. `hastaDia` corta el mes en ese
// día (inclusive): sirve para comparar el mes en curso con el anterior hasta el
// mismo día, sin poner un mes entero contra uno a medias. `sinTurno` cuenta los
// cierres del mes que no son de ningún turno (los de antes de FECHA_INICIO_TURNOS).
function datosTurnos(offset, hastaDia = Infinity) {
  const base = fechaBaseDelMes(offset);
  const y = base.getFullYear();
  const m = base.getMonth();
  const turnos = new Map(turnosDelNegocio().map(t => [t.id, { ...t, turnos: 0, total: 0 }]));
  let sinTurno = 0;
  facturacionesDelNegocio().forEach(f => {
    const d = fechaDeRegistro(f);
    if (d.getFullYear() !== y || d.getMonth() !== m || d.getDate() > hastaDia) return;
    const t = turnos.get(f.turno);
    if (!t) { sinTurno++; return; }
    t.turnos++;
    t.total += Number(f.importe) || 0;
  });
  turnos.forEach(t => { t.promedio = t.turnos ? t.total / t.turnos : 0; });
  return { base, turnos, sinTurno };
}

// Cada turno del mes con su variación del promedio contra el mes anterior, del
// que más subió al que más bajó (mismas reglas que las personas).
function evolucionTurnos(act, ant) {
  const filas = Array.from(act.turnos.values()).filter(t => t.turnos > 0).map(t => {
    const q = ant.turnos.get(t.id);
    const previo = q && q.turnos > 0 ? q : null;
    return { ...t, previo, variacion: variacionDelPromedio(t, previo) };
  });
  return ordenarPorVariacion(filas);
}

// " (mañana y noche)" — los turnos del negocio, para explicar el índice sin
// escribirlos a mano en el texto. Vacío si el negocio no trabaja por turnos.
function turnosEntreParentesis() {
  if (!negocioTieneTurnos(negocioActual)) return "";
  const nombres = idsTurnosFacturado().map(id => nombreCortoTurnoFacturado(id).toLowerCase());
  return ` (${new Intl.ListFormat("es", { type: "conjunction" }).format(nombres)})`;
}

const pctTexto = (v) => `${Math.abs(Math.round(v))}%`;

const CORONA = `<svg class="cmp-corona" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>`;

// El círculo con la inicial: el color es el de la persona en el resto de la app.
function avatarHtml(nombre, clase = "") {
  return `<span class="cmp-av ${clase}" style="background:${payerColorVar(nombre)}" aria-hidden="true">${escapeHtml(nombre.trim().charAt(0).toUpperCase())}</span>`;
}

// Quiénes van al podio: los que más subieron y, si nadie subió, los que menos
// bajaron — así en un mes a la baja el podio no queda vacío. `filas` ya viene
// ordenado de la mejor variación a la peor. Único lugar que lo decide: lo usan
// el podio, la tarjeta de "Mayor baja" y las medallas del ranking.
function podioDe(filas) {
  const comparables = filas.filter(f => f.variacion !== null);
  const subieron = comparables.filter(f => f.variacion > 0);
  return subieron.length
    ? { modo: "sube", top: subieron.slice(0, 3) }
    : { modo: "baja", top: comparables.slice(0, 3) };
}

// Un ícono por turno (sol que sale, sol que baja, luna) en el lugar de la inicial:
// es lo que deja reconocer de un vistazo cuál es. La clave es el id sin tildes ni
// eñe ("mañana" → "manana"). Los colores son de identidad, no de estado: el verde
// y el rojo quedan reservados para lo que sube y lo que baja.
const ICONOS_TURNO = {
  manana: { color: "#d8901c", trazo: `<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>` },
  tarde: { color: "#e5683a", trazo: `<path d="M6.5 16a5.5 5.5 0 0 1 11 0"/><path d="M3 16h18M8 20h8M12 5v2.5M4.8 8.8l1.8 1.8M19.2 8.8l-1.8 1.8"/>` },
  noche: { color: "#4f56c9", trazo: `<path d="M20 14.2A8.5 8.5 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2z"/>` },
};

const iconoTurno = (id) => ICONOS_TURNO[id.normalize("NFD").replace(/[\u0300-\u036f]/g, "")];

function turnoAvatarHtml(id, clase = "") {
  const icono = iconoTurno(id);
  if (!icono) return `<span class="cmp-av ${clase}" style="background:var(--text-secondary)" aria-hidden="true">${escapeHtml(id.charAt(0).toUpperCase())}</span>`;
  return `<span class="cmp-av ${clase}" style="background:${icono.color}" aria-hidden="true"><svg viewBox="0 0 24 24">${icono.trazo}</svg></span>`;
}

// Lo único que cambia entre el podio de empleados y el de turnos: el círculo de
// cada puesto y los textos. Quién entra (podioDe) y cómo se dibuja es uno solo.
const PODIO_EMPLEADOS = {
  clase: "",
  avatar: (f, clase) => avatarHtml(f.nombre, clase),
  tituloSube: "Quién más subió",
  tituloBaja: "Quién bajó menos",
  ariaSube: "Quienes más subieron su promedio por turno",
  ariaBaja: "Quienes menos bajaron su promedio por turno",
  notaBaja: "Nadie subió su promedio por turno este mes: gana quien menos bajó.",
  sinDatos: (act, ant) => `Todavía no hay integrantes con al menos ${MIN_TURNOS} turnos en ${mesLabel(act.base)} y en ${mesLabel(ant.base)} para comparar.`,
  todasLasBajas: false,
};
const PODIO_TURNOS = {
  clase: " cmp-podio-turnos",
  avatar: (f, clase) => turnoAvatarHtml(f.id, clase),
  tituloSube: "Qué turno más subió",
  tituloBaja: "Qué turno bajó menos",
  ariaSube: "Turnos que más subieron su promedio",
  ariaBaja: "Turnos que menos bajaron su promedio",
  notaBaja: "Ningún turno subió su promedio este mes: gana el que menos bajó.",
  sinDatos: (act, ant) => `Todavía no hay al menos ${MIN_TURNOS} cierres de cada turno en ${mesLabel(act.base)} y en ${mesLabel(ant.base)} para comparar.`,
  todasLasBajas: true, // son pocos: se muestran todos los que cayeron, no solo el peor
};

// Hasta tres en el orden de un podio: 2.º, 1.º y 3.º. Lo que sube o baja cada una
// va con flecha y porcentaje; la altura del escalón marca el puesto, no el valor.
function podioHtml(top, modo, textos) {
  const columnas = [top[1], top[0], top[2]].map((f) => {
    if (!f) return `<div></div>`;
    const puesto = top.indexOf(f) + 1;
    return `
      <div class="cmp-pd cmp-pd-${puesto}">
        <div class="cmp-pd-av">${puesto === 1 ? CORONA : ""}${textos.avatar(f)}</div>
        <div class="cmp-pd-nombre">${escapeHtml(f.nombre)}</div>
        <div class="cmp-pd-pct">${flechaResultado(f.variacion)}${pctTexto(f.variacion)}</div>
        <div class="cmp-pd-det">${compacto(f.previo.promedio)} → ${compacto(f.promedio)}</div>
        <div class="cmp-pd-base"><span>${puesto}</span></div>
      </div>`;
  });
  const etiqueta = modo === "sube" ? textos.ariaSube : textos.ariaBaja;
  return `<div class="cmp-podio" role="list" aria-label="${etiqueta}">${columnas.join("")}</div>`;
}

// La tarjeta del podio: título, podio y los que cayeron sin entrar a él. La usan
// los empleados y los turnos; `filas` ya viene ordenado de la mejor variación a
// la peor.
function podioCardHtml(filas, act, ant, textos) {
  const comparables = filas.filter(f => f.variacion !== null);
  const nombreAnt = mesLabel(ant.base);
  const { modo, top } = podioDe(filas);
  const peor = comparables[comparables.length - 1];
  const detalle = (f) => `${money(Math.round(f.previo.promedio))} → ${money(Math.round(f.promedio))} por turno`;

  let cuerpo;
  if (!comparables.length) {
    cuerpo = `<p class="cmp-hero-frase">${textos.sinDatos(act, ant)}</p>`;
  } else {
    const nota = modo === "baja" ? `<p class="cmp-podio-nota">${textos.notaBaja}</p>` : "";
    cuerpo = nota + podioHtml(top, modo, textos);
  }

  // Los que cayeron y no son del podio: en empleados alcanza con el que más bajó
  // ("Mayor baja"); los turnos son pocos, así que van todos.
  const cayeron = comparables.filter(f => f.variacion < 0 && !top.includes(f));
  const baja = (textos.todasLasBajas ? cayeron : cayeron.slice(-1)).map(f =>
    `<div class="cmp-baja-fila">
        ${textos.avatar(f, "cmp-av-s")}
        <div class="cmp-baja-txt"><span class="cmp-baja-rotulo">${f === peor ? "Mayor baja" : "También bajó"}</span><b>${escapeHtml(f.nombre)}</b><small>${detalle(f)}</small></div>
        <div class="cmp-baja-pct"><span class="cmp-flecha cmp-baja">▼</span>${pctTexto(f.variacion)}</div>
      </div>`
  ).join("");

  return `
    <section class="cmp-card cmp-podio-card${textos.clase}${ui.animar ? " cmp-anim" : ""}">
      <div class="cmp-podio-cab"><h3 class="cmp-podio-titulo">${comparables.length && modo === "baja" ? textos.tituloBaja : textos.tituloSube}</h3><span class="cmp-podio-mes">contra ${nombreAnt}</span></div>
      ${cuerpo}
      ${baja}
    </section>`;
}

// Barras que salen del centro: a la derecha (verde) lo que subió, a la
// izquierda (rojo) lo que bajó. Cada una con su flecha y su porcentaje, así el
// estado no depende solo del color.
function equipoVariacionHtml(ant, filas, top) {
  const maxAbs = Math.max(10, ...filas.map(f => Math.abs(f.variacion || 0)));
  const items = filas.map((f) => {
    const puesto = top.indexOf(f);
    const medalla = puesto >= 0 ? ` cmp-m${puesto + 1}` : "";
    const nombre = `<div class="cmp-eq-nombre">${avatarHtml(f.nombre, "cmp-av-s" + medalla)}<span>${escapeHtml(f.nombre)}<small>${f.turnos} ${f.turnos === 1 ? "turno" : "turnos"}</small></span></div>`;
    if (f.variacion === null) {
      const motivo = !f.previo ? `sin turnos en ${mesLabel(ant.base)}` : `menos de ${MIN_TURNOS} turnos`;
      return `<div class="cmp-eq-fila">${nombre}<div class="cmp-eq-pocos">${motivo}</div></div>`;
    }
    const sube = f.variacion >= 0;
    const ancho = Math.max(1.5, (Math.abs(f.variacion) / maxAbs) * 50);
    return `
      <div class="cmp-eq-fila">${nombre}
        <div class="cmp-eq-div"><span class="cmp-eq-eje"></span><span class="cmp-eq-barra ${sube ? "cmp-eq-sube" : "cmp-eq-baja-b"}" style="width:${ancho}%"></span></div>
        <div class="cmp-eq-pct">${flechaResultado(f.variacion)}${f.variacion === 0 ? "0%" : pctTexto(f.variacion)}</div>
      </div>`;
  }).join("");
  return `
    <section class="cmp-card">
      <h3 class="cmp-card-titulo">Ranking de variación</h3>
      <p class="cmp-card-sub">Contra ${mesLabel(ant.base)}. Solo se comparan quienes tienen al menos ${MIN_TURNOS} turnos en los dos meses.</p>
      ${items}
    </section>`;
}

function equipoPromedioHtml(act, ant, filas) {
  const maxVal = Math.max(1, ...filas.flatMap(f => [f.promedio, f.previo ? f.previo.promedio : 0]));
  const ancho = (v) => Math.max(v > 0 ? 2 : 0, (v / maxVal) * 100);
  const items = filas.map(f => {
    const p = f.previo ? f.previo.promedio : 0;
    const delta = f.variacion === null
      ? `<span class="cmp-delta">—</span>`
      : `<span class="cmp-delta">${flechaResultado(f.variacion)}${pctTexto(f.variacion)}</span>`;
    return `
      <div class="cmp-vs-fila cmp-vs-persona">
        <div class="cmp-vs-tramo">${escapeHtml(f.nombre)}</div>
        <div class="cmp-vs-barras">
          <div class="cmp-vs-linea"><span class="cmp-vs-barra cmp-vs-act" style="width:${ancho(f.promedio)}%"></span><em>${compacto(f.promedio)}</em></div>
          <div class="cmp-vs-linea"><span class="cmp-vs-barra cmp-vs-ant" style="width:${ancho(p)}%"></span><em>${p > 0 ? compacto(p) : ""}</em></div>
        </div>
        ${delta}
      </div>`;
  }).join("");
  return `
    <section class="cmp-card">
      <h3 class="cmp-card-titulo">Promedio vendido por turno</h3>
      <p class="cmp-card-sub">Lo que cierra cada integrante en un turno típico</p>
      <div class="cmp-leyenda">
        <span><i class="cmp-pt cmp-vs-act"></i>${mesLabel(act.base)}</span>
        <span><i class="cmp-pt cmp-vs-ant"></i>${mesLabel(ant.base)}</span>
      </div>
      ${items}
    </section>`;
}

function equipoTablaHtml(act, ant, filas) {
  const fila = (f) => `
    <tr><th scope="row">${escapeHtml(f.nombre)}</th>
      <td>${f.turnos}</td>
      <td>${money(Math.round(f.total))}</td>
      <td>${money(Math.round(f.promedio))}</td>
      <td>${f.previo ? money(Math.round(f.previo.promedio)) : "—"}</td>
      <td>${f.variacion === null ? "—" : (f.variacion < 0 ? "-" : "+") + pctTexto(f.variacion)}</td>
      <td>${f.indice === null ? "—" : Math.round(f.indice)}</td>
    </tr>`;
  return `
    <details class="cmp-card cmp-tabla">
      <summary>Ver los números en tabla</summary>
      <div class="cmp-tabla-scroll">
        <table>
          <caption>Rendimiento por turno — ${mesLabel(act.base)} contra ${mesLabel(ant.base)}</caption>
          <thead><tr><th scope="col">Integrante</th><th scope="col">Turnos</th><th scope="col">Vendido</th><th scope="col">Prom. por turno</th><th scope="col">Mes anterior</th><th scope="col">Variación</th><th scope="col">Índice</th></tr></thead>
          <tbody>${filas.map(fila).join("")}</tbody>
        </table>
      </div>
      <p class="cmp-nota-tabla">Índice: 100 es vender lo mismo que el promedio del equipo en esos mismos turnos${turnosEntreParentesis()}. Por encima de 100, rindió más que el equipo; ajusta por trabajar en turnos más fuertes o más flojos.</p>
    </details>`;
}

// El podio de turnos va debajo del de empleados. Sale de los cierres de todo el
// negocio, así que se muestra aunque no haya equipo cargado; sin ningún cierre en
// el mes no se dibuja (el aviso de que no hay cierres ya lo da la vista).
function turnosPodioHtml() {
  const act = datosTurnos(ui.offset);
  if (!Array.from(act.turnos.values()).some(t => t.turnos > 0)) return "";
  const ant = datosTurnos(ui.offset - 1);
  return podioCardHtml(evolucionTurnos(act, ant), act, ant, PODIO_TURNOS);
}

function renderEquipo() {
  const act = datosEquipo(ui.offset);
  const ant = datosEquipo(ui.offset - 1);
  actualizarNavMes(act.base);
  const cont = $("#cmp-equipo-contenido");
  const turnos = turnosPodioHtml();
  if (!act.hayEquipo) {
    cont.innerHTML = `<div class="cmp-card"><p class="cmp-vacio-chico">No hay integrantes del equipo cargados. Se agregan en Ajustes → Otras personas.</p></div>${turnos}`;
    return;
  }
  if (!act.personas.size) {
    cont.innerHTML = `<div class="cmp-card"><p class="cmp-vacio-chico">No hay cierres de turno del equipo en ${mesLabel(act.base)}.</p></div>${turnos}`;
    return;
  }
  const filas = evolucionEquipo(act, ant);
  const enCurso = ui.offset === 0
    ? `<p class="cmp-nota-mes">Mes en curso: se compara el promedio por turno de lo cargado hasta hoy.</p>`
    : "";
  const omitidos = act.sinTurno + ant.sinTurno;
  const sinTurnoNota = omitidos
    ? `<p class="cmp-nota-mes">No se cuentan ${omitidos} ${omitidos === 1 ? "cierre" : "cierres"} de antes de que se cargaran por turno.</p>`
    : "";
  cont.innerHTML = podioCardHtml(filas, act, ant, PODIO_EMPLEADOS) + turnos + enCurso + sinTurnoNota + equipoVariacionHtml(ant, filas, podioDe(filas).top) + equipoPromedioHtml(act, ant, filas) + equipoTablaHtml(act, ant, filas);
}

// ---------- Vista "Por turno" (solo negocios con turnos) ----------

const cierresTxt = (n) => `${n} ${n === 1 ? "cierre" : "cierres"}`;

// Lo facturado en cada turno del mes elegido contra el mes anterior. En el mes en
// curso los dos se cortan en el día de hoy: poner 26 días contra 30 haría ver una
// caída que no existe. En un mes ya cerrado se comparan los dos meses enteros.
// Si el mes anterior tiene cierres de antes de que se cargaran por turno, sus
// turnos están incompletos: no se compara contra él (haría ver una suba que no existe).
function datosPorTurno() {
  const corte = ui.offset === 0 ? new Date().getDate() : Infinity;
  const act = datosTurnos(ui.offset, corte);
  const ant = datosTurnos(ui.offset - 1, corte);
  const filas = turnosDelNegocio().map(t => ({ ...t, a: act.turnos.get(t.id), p: ant.turnos.get(t.id) }));
  const suma = (k, campo) => filas.reduce((s, f) => s + f[k][campo], 0);
  return {
    act, ant, corte, filas, comparable: !ant.sinTurno,
    totalAct: suma("a", "total"), totalAnt: suma("p", "total"),
    cierresAct: suma("a", "turnos"), cierresAnt: suma("p", "turnos")
  };
}

const textoCorte = (d) => d.corte === Infinity ? "" : `, hasta el día ${d.corte} en los dos meses`;

function turnoTotalesHtml(d) {
  const nombreAct = mesLabel(d.act.base);
  const nombreAnt = mesLabel(d.ant.base);
  const maxVal = Math.max(1, ...d.filas.flatMap(f => [f.a.total, f.p.total]));
  const ancho = (v) => Math.max(v > 0 ? 2 : 0, (v / maxVal) * 100);
  const delta = (a, p) => deltaHtml(a, d.comparable ? p : 0);
  const filas = d.filas.map(f => {
    const parte = d.totalAct ? Math.round((f.a.total / d.totalAct) * 100) : 0;
    return `
      <div class="cmp-tu-fila">
        <div class="cmp-tu-cab">
          ${turnoAvatarHtml(f.id, "cmp-av-s")}
          <div class="cmp-tu-nom"><b>${escapeHtml(f.nombre)}</b><small>${cierresTxt(f.a.turnos)} · ${parte}% del total</small></div>
          <div class="cmp-tu-val"><b>${money(Math.round(f.a.total))}</b>${delta(f.a.total, f.p.total)}</div>
        </div>
        <div class="cmp-vs-barras">
          <div class="cmp-vs-linea"><span class="cmp-vs-barra cmp-vs-act" style="width:${ancho(f.a.total)}%"></span></div>
          <div class="cmp-vs-linea"><span class="cmp-vs-barra cmp-vs-ant" style="width:${ancho(f.p.total)}%"></span><em>${f.p.total > 0 ? money(Math.round(f.p.total)) : "sin cierres"}</em></div>
        </div>
      </div>`;
  }).join("");
  const notas = [];
  if (d.act.sinTurno) notas.push(`No se cuentan ${cierresTxt(d.act.sinTurno)} de ${nombreAct} de antes de que se cargaran por turno.`);
  if (!d.comparable && !d.cierresAnt) notas.push(`En ${nombreAnt} todavía no se cargaba por turno: no hay con qué comparar.`);
  else if (!d.comparable) notas.push(`En ${nombreAnt} hay ${cierresTxt(d.ant.sinTurno)} de antes de que se cargaran por turno: sus turnos quedan incompletos, así que no se compara contra ese mes.`);
  else if (!d.totalAnt) notas.push(`No hay cierres cargados en ${nombreAnt} para comparar.`);
  return `
    <section class="cmp-card">
      <h3 class="cmp-card-titulo">Total de cada turno</h3>
      <p class="cmp-card-sub">Facturado en ${nombreAct} contra ${nombreAnt}${textoCorte(d)}</p>
      <div class="cmp-leyenda">
        <span><i class="cmp-pt cmp-vs-act"></i>${nombreAct}</span>
        <span><i class="cmp-pt cmp-vs-ant"></i>${nombreAnt}</span>
      </div>
      ${filas}
      <div class="cmp-tu-fila cmp-tu-suma">
        <div class="cmp-tu-cab">
          <div class="cmp-tu-nom"><b>Total de los turnos</b><small>${nombreAnt}: ${money(Math.round(d.totalAnt))}</small></div>
          <div class="cmp-tu-val"><b>${money(Math.round(d.totalAct))}</b>${delta(d.totalAct, d.totalAnt)}</div>
        </div>
      </div>
      ${notas.map(n => `<p class="cmp-nota-mes">${n}</p>`).join("")}
    </section>`;
}

function turnoTablaHtml(d) {
  const variacion = (a, p) => {
    if (!d.comparable || p <= 0) return "—";
    const pct = Math.round(((a - p) / p) * 100);
    return (pct < 0 ? "-" : pct > 0 ? "+" : "") + Math.abs(pct) + "%";
  };
  const celdas = (cierresA, a, cierresP, p) => `
      <td>${cierresA}</td><td>${money(Math.round(a))}</td>
      <td>${cierresP}</td><td>${money(Math.round(p))}</td>
      <td>${variacion(a, p)}</td>`;
  return `
    <details class="cmp-card cmp-tabla">
      <summary>Ver los números en tabla</summary>
      <div class="cmp-tabla-scroll">
        <table>
          <caption>Total de cada turno — ${mesLabel(d.act.base)} contra ${mesLabel(d.ant.base)}${textoCorte(d)}</caption>
          <thead><tr><th scope="col">Turno</th><th scope="col">Cierres</th><th scope="col">Total</th><th scope="col">Cierres mes ant.</th><th scope="col">Total mes ant.</th><th scope="col">Variación</th></tr></thead>
          <tbody>
            ${d.filas.map(f => `<tr><th scope="row">${escapeHtml(f.nombre)}</th>${celdas(f.a.turnos, f.a.total, f.p.turnos, f.p.total)}</tr>`).join("")}
          </tbody>
          <tfoot><tr><th scope="row">Total</th>${celdas(d.cierresAct, d.totalAct, d.cierresAnt, d.totalAnt)}</tr></tfoot>
        </table>
      </div>
    </details>`;
}

// ---------- Fichas del selector ----------

// Cada ficha adelanta el dato clave de su vista para el mes elegido, sin tener
// que entrar: el total facturado y cuánto cambió contra el mes anterior, las
// barras de los turnos, las columnas de los tres tramos y el podio de
// empleados. Son las mismas cuentas de cada vista, así los números coinciden.
// Sin datos en el mes la miniatura queda apagada, en vez de dibujar nada.

function fichaMesHtml(act, ant) {
  const total = act.tramos.reduce((s, t) => s + t.total, 0);
  const previo = ant.tramos.reduce((s, t) => s + t.total, 0);
  if (!total) return `<small class="cmp-ficha-nada">Sin cierres</small>`;
  return `<b>$${compacto(total)}</b>${deltaHtml(total, previo)}`;
}

function fichaTurnosHtml(turnos) {
  const filas = turnosDelNegocio().map(t => ({ ...t, total: turnos.turnos.get(t.id).total }));
  const max = Math.max(...filas.map(f => f.total));
  const ancho = (v) => max > 0 ? Math.max(6, Math.round((v / max) * 100)) : 20;
  const barras = filas.map(f => {
    const icono = iconoTurno(f.id);
    return `<i style="--w:${ancho(f.total)}%${icono ? `;--c:${icono.color}` : ""}"></i>`;
  }).join("");
  return `<span class="cmp-mini cmp-mini-turnos${max > 0 ? "" : " cmp-mini-vacio"}">${barras}</span>`;
}

function fichaTramosHtml(act) {
  const max = Math.max(...act.tramos.map(t => t.total));
  const alto = (v) => max > 0 ? Math.max(8, Math.round((v / max) * 100)) : 60;
  const columnas = act.tramos.map(t => `<i style="--h:${alto(t.total)}%"></i>`).join("");
  return `<span class="cmp-mini cmp-mini-tramos${max > 0 ? "" : " cmp-mini-vacio"}">${columnas}</span>`;
}

// Las iniciales de quienes están en el podio (1.º, 2.º y 3.º, con su medalla).
// Si todavía no hay podio, los tres escalones apagados.
function fichaEquipoHtml(act, ant) {
  const top = podioDe(evolucionEquipo(act, ant)).top;
  if (!top.length) return `<span class="cmp-mini cmp-mini-podio cmp-mini-vacio"><i></i><i></i><i></i></span>`;
  return `<span class="cmp-mini cmp-mini-podio">${top.map((f, i) => avatarHtml(f.nombre, `cmp-m${i + 1}`)).join("")}</span>`;
}

function renderFichas(conTurnos) {
  const act = datosTramos(ui.offset);
  const ant = datosTramos(ui.offset - 1);
  const dato = (k, html) => { $(`#cmp-vista [data-dato="${k}"]`).innerHTML = html; };
  dato("mes", fichaMesHtml(act, ant));
  dato("turno", conTurnos ? fichaTurnosHtml(datosTurnos(ui.offset)) : "");
  dato("tramo", fichaTramosHtml(act));
  dato("equipo", fichaEquipoHtml(datosEquipo(ui.offset), datosEquipo(ui.offset - 1)));
}

// ---------- Render ----------

function actualizarNavMes(base) {
  $("#cmp-mes-label").textContent = mesLabel(base);
  $("#cmp-mes-anterior").disabled = ui.offset <= -mesesAtrasMax();
  $("#cmp-mes-siguiente").disabled = ui.offset >= 0;
}

function renderTramo() {
  const act = datosTramos(ui.offset);
  const ant = datosTramos(ui.offset - 1);
  actualizarNavMes(act.base);
  $$("#cmp-modo button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.modo === ui.modo)));

  const cont = $("#cmp-tramo-contenido");
  if (!act.hayDatos) {
    cont.innerHTML = `<div class="cmp-card"><p class="cmp-vacio-chico">No hay cierres ni gastos cargados en ${mesLabel(act.base)}.</p></div>`;
    return;
  }
  cont.innerHTML = heroHtml(act) + graficoHtml(act) + contraAnteriorHtml(act, ant) + tablaHtml(act);
  conectarTip(act);
}

function renderTurno() {
  const d = datosPorTurno();
  actualizarNavMes(d.act.base);
  const cont = $("#cmp-turno-contenido");
  if (!d.cierresAct) {
    const viejos = d.act.sinTurno ? ": los que hay son de antes de que se cargaran por turno" : "";
    cont.innerHTML = `<div class="cmp-card"><p class="cmp-vacio-chico">No hay cierres de turno cargados en ${mesLabel(d.act.base)}${viejos}.</p></div>`;
    return;
  }
  cont.innerHTML = turnoTotalesHtml(d) + turnoTablaHtml(d);
}

// Variación porcentual contra el mes anterior, como texto corto con flecha.
// Vacío si el mes anterior no tiene nada con qué comparar.
function variacionHtml(actual, anterior, subeEsBueno) {
  if (!anterior) return "";
  const pct = Math.round(((actual - anterior) / anterior) * 100);
  if (pct === 0) return `<span class="comparar-var">= 0%</span>`;
  const bueno = (pct > 0) === subeEsBueno;
  return `<span class="comparar-var" style="color:var(--${bueno ? "good" : "critical"})">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%</span>`;
}

// Un bloque por mes con datos (de los meses que ya trae el historial
// cargado de Firestore), del más reciente al más antiguo. Usa las mismas
// cuentas que Resumen mensual — el total facturado es la suma de los
// importes de los cierres, así que ambas pantallas muestran el mismo número.
function renderMeses() {
  const wrap = $("#comparar-meses");
  const meses = new Map();
  const mesDe = (item) => {
    const d = fechaDeRegistro(item);
    const key = d.getFullYear() * 12 + d.getMonth();
    if (!meses.has(key)) {
      meses.set(key, { fecha: new Date(d.getFullYear(), d.getMonth(), 1), efectivo: 0, digital: 0, total: 0, gastos: 0 });
    }
    return meses.get(key);
  };
  facturacionesDelNegocio().forEach(f => {
    const m = mesDe(f);
    m.efectivo += Number(f.efectivo) || 0;
    m.digital += Number(f.digital) || 0;
    m.total += Number(f.importe) || 0;
  });
  gastosDelNegocio().forEach(g => { mesDe(g).gastos += Number(g.importe) || 0; });

  const lista = Array.from(meses.entries()).sort((a, b) => b[0] - a[0]);
  wrap.innerHTML = "";
  $("#comparar-empty").classList.toggle("hidden", lista.length > 0);
  const maxVal = Math.max(1, ...lista.map(([, m]) => Math.max(m.total, m.gastos)));

  lista.forEach(([key, m]) => {
    const prev = meses.get(key - 1);
    // Cierres cargados antes del desglose Efectivo/Digital no tienen esos
    // campos: el total sí los cuenta, pero Efectivo+Digital queda más bajo.
    const sinDesglose = m.total - (m.efectivo + m.digital) > 0.5;
    const card = document.createElement("div");
    card.className = "socio-total-card";
    card.innerHTML = `
      <div class="socio-total-row">
        <div class="socio-total-name">${mesLabel(m.fecha)}</div>
      </div>
      <div class="comparar-fila"><span><span class="socio-dot" style="background:var(--good)"></span> Efectivo</span><b>${money(m.efectivo)}</b></div>
      <div class="comparar-fila"><span><span class="socio-dot" style="background:var(--series-1)"></span> Digital</span><b>${money(m.digital)}</b></div>
      <div class="comparar-fila comparar-fila-total"><span>Efectivo + Digital</span><b>${money(m.total)}${variacionHtml(m.total, prev && prev.total, true)}</b></div>
      ${sinDesglose ? `<div class="comparar-nota">Hay cierres viejos sin desglose Efectivo/Digital.</div>` : ""}
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round((m.total / maxVal) * 100)}%;background:var(--good)"></div></div>
      <div class="comparar-fila comparar-fila-gastos"><span>🧾 Gastos totales</span><b>${money(m.gastos)}${variacionHtml(m.gastos, prev && prev.gastos, false)}</b></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round((m.gastos / maxVal) * 100)}%;background:var(--text-muted)"></div></div>
    `;
    wrap.appendChild(card);
  });
}

// Se llama en cada cambio que llega de Firestore: si la pantalla no está
// abierta no hace nada (abrirComparar() redibuja al entrar).
export function renderComparar() {
  const pantalla = $("#screen-comparar");
  if (!pantalla || !esAdmin || !pantalla.classList.contains("active")) return;

  // Un negocio sin turnos (Heladería) no tiene ficha X TURNO; si se venía de esa
  // vista en Pancho, se vuelve a "Por mes".
  const conTurnos = negocioTieneTurnos(negocioActual);
  if (!conTurnos && ui.vista === "turno") ui.vista = "mes";
  $("#cmp-vista").classList.toggle("cmp-sin-turnos", !conTurnos);
  $$("#cmp-vista button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.vista === ui.vista)));
  renderFichas(conTurnos);
  $("#cmp-vista-mes").classList.toggle("hidden", ui.vista !== "mes");
  $("#cmp-nav").classList.toggle("hidden", ui.vista === "mes");
  $("#cmp-vista-tramo").classList.toggle("hidden", ui.vista !== "tramo");
  $("#cmp-vista-turno").classList.toggle("hidden", ui.vista !== "turno");
  $("#cmp-vista-equipo").classList.toggle("hidden", ui.vista !== "equipo");
  if (ui.vista === "mes") renderMeses();
  else if (ui.vista === "tramo") renderTramo();
  else if (ui.vista === "turno") renderTurno();
  else renderEquipo();
  ui.animar = false;
}

// Al entrar desde el selector de secciones: siempre arranca en el mes
// actual, y las columnas crecen una vez.
export function abrirComparar() {
  ui.offset = 0;
  ui.animar = true;
  renderComparar();
}

export function initComparar() {
  $("#cmp-vista").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-vista]");
    if (!b) return;
    ui.vista = b.dataset.vista;
    ui.animar = true;
    renderComparar();
  });
  $("#cmp-modo").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-modo]");
    if (!b) return;
    ui.modo = b.dataset.modo;
    ui.animar = true;
    renderComparar();
  });
  $("#cmp-mes-anterior").addEventListener("click", () => {
    if (ui.offset <= -mesesAtrasMax()) return;
    ui.offset--;
    ui.animar = true;
    renderComparar();
  });
  $("#cmp-mes-siguiente").addEventListener("click", () => {
    if (ui.offset >= 0) return;
    ui.offset++;
    ui.animar = true;
    renderComparar();
  });
  // Tocar fuera de un tramo cierra el tooltip (en el celular no hay "hover" que lo cierre).
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".cmp-grupo")) ocultarTip();
  });
}
