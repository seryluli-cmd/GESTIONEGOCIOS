import { $, money, escapeHtml } from "./utilidades.js";
import { socios, colaboradores, gastosDelNegocio } from "./datos.js";
import { esSocio } from "./sesion.js";
import { socioColorVar, colaboradorColorVar } from "../app.js";

// Reparto de gastos entre los 3 socios: NO es igualitario (1/3 cada uno)
// — cada uno "debería" poner este % del total de lo gastado, según lo
// acordado entre ellos. Si el nombre de algún socio en Firestore no
// coincide exactamente con los de acá (typo, socio nuevo, etc.),
// renderBalance() se cae a reparto igualitario como antes, en vez de
// calcular un porcentaje a medias con el resto sin cubrir.
const PORCENTAJE_SOCIO = {
  "Sergio": 0.10,
  "Pola": 0.10,
  "Leonel": 0.80,
};
// ---------- Render: Balance ----------
export function renderBalance() {
  // La pestaña Balance está escondida para un colaborador (ver
  // aplicarPermisosDeVista()), pero esta función se llama igual desde
  // selectSeccion("gastos")/listenGastos()/listenSocios() sin preguntar
  // quién está mirando — sin este guard, la plata entre socios quedaba
  // igual calculada y pintada en el DOM (visible por "Ver código fuente"
  // aunque el botón de la pestaña no se vea). Se vacía en vez de solo no
  // actualizar, para no dejar pegado un balance de otro socio en un
  // celular compartido.
  if (!esSocio()) {
    $("#total-historico").textContent = "";
    $("#socios-totales").innerHTML = "";
    $("#settlements").innerHTML = "";
    return;
  }
  if (!socios.length) return;

  const gastosNegocio = gastosDelNegocio();
  const total = gastosNegocio.reduce((sum, g) => sum + (Number(g.importe) || 0), 0);
  $("#total-historico").textContent = money(total);

  const porSocio = socios.map(() => 0);
  gastosNegocio.forEach(g => {
    const idx = socios.indexOf(g.pagadoPor);
    if (idx !== -1) porSocio[idx] += Number(g.importe) || 0;
  });

  const maxPorSocio = Math.max(1, ...porSocio);
  const totalesEl = $("#socios-totales");
  totalesEl.innerHTML = "";
  socios.forEach((nombre, idx) => {
    const pct = Math.round((porSocio[idx] / maxPorSocio) * 100);
    const card = document.createElement("div");
    card.className = "socio-total-card";
    card.innerHTML = `
      <div class="socio-total-row">
        <div class="socio-total-name">
          <span class="socio-dot" style="background:${socioColorVar(idx)}"></span>
          ${escapeHtml(nombre)}
        </div>
        <div class="socio-total-amount">${money(porSocio[idx])}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${socioColorVar(idx)}"></div></div>
    `;
    totalesEl.appendChild(card);
  });

  // Deudas: cada socio "debería" haber puesto su % de PORCENTAJE_SOCIO
  // sobre el total (ver esa constante) — si por algún motivo los nombres
  // actuales de Firestore no calzan exactamente con ese mapa, se cae a
  // reparto igualitario (total/n) en vez de calcular un porcentaje mal.
  const usaPorcentajes = socios.every(nombre => nombre in PORCENTAJE_SOCIO);
  const fairShares = usaPorcentajes
    ? socios.map(nombre => total * PORCENTAJE_SOCIO[nombre])
    : socios.map(() => total / socios.length);
  const balances = socios.map((nombre, idx) => ({
    nombre, idx, balance: porSocio[idx] - fairShares[idx]
  }));

  const settlements = computeSettlements(balances);
  const settlementsEl = $("#settlements");
  settlementsEl.innerHTML = "";

  if (!total) {
    settlementsEl.innerHTML = `<p class="settlements-empty">Todavía no hay gastos para calcular.</p>`;
  } else if (!settlements.length) {
    settlementsEl.innerHTML = `<p class="settlements-empty">✅ Las cuentas están parejas entre los 3.</p>`;
  } else {
    settlements.forEach(s => {
      const item = document.createElement("div");
      item.className = "settlement-item";
      item.innerHTML = `
        <b>${escapeHtml(s.from)}</b>
        <span class="arrow">le debe a</span>
        <b>${escapeHtml(s.to)}</b>
        <span class="amt">${money(s.amount)}</span>
      `;
      settlementsEl.appendChild(item);
    });
  }

  renderColaboradoresTotales();
}

// Pagos hechos por colaboradores (ej. la encargada): se muestran a modo
// informativo, pero NUNCA entran en el cálculo de "quién le debe a quién"
// entre los socios.
function renderColaboradoresTotales() {
  const section = $("#colaboradores-section");
  if (!colaboradores.length) {
    section.classList.add("hidden");
    return;
  }

  const porColaborador = colaboradores.map(() => 0);
  gastosDelNegocio().forEach(g => {
    const idx = colaboradores.indexOf(g.pagadoPor);
    if (idx !== -1) porColaborador[idx] += Number(g.importe) || 0;
  });

  const total = porColaborador.reduce((a, b) => a + b, 0);
  if (!total) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const maxVal = Math.max(1, ...porColaborador);
  const wrap = $("#colaboradores-totales");
  wrap.innerHTML = "";
  colaboradores.forEach((nombre, idx) => {
    const pct = Math.round((porColaborador[idx] / maxVal) * 100);
    if (!porColaborador[idx]) return;
    const card = document.createElement("div");
    card.className = "socio-total-card";
    const color = colaboradorColorVar(idx);
    card.innerHTML = `
      <div class="socio-total-row">
        <div class="socio-total-name">
          <span class="socio-dot" style="background:${color}"></span>
          ${escapeHtml(nombre)}
        </div>
        <div class="socio-total-amount">${money(porColaborador[idx])}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    `;
    wrap.appendChild(card);
  });
}

// Algoritmo simple de liquidación de deudas (minimiza transacciones)
function computeSettlements(balances) {
  const debtors = balances.filter(b => b.balance < -0.01).map(b => ({ ...b, balance: -b.balance }));
  const creditors = balances.filter(b => b.balance > 0.01).map(b => ({ ...b }));
  debtors.sort((a, b) => b.balance - a.balance);
  creditors.sort((a, b) => b.balance - a.balance);

  const result = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const amount = Math.min(d.balance, c.balance);
    if (amount > 0.01) {
      result.push({ from: d.nombre, to: c.nombre, amount });
    }
    d.balance -= amount;
    c.balance -= amount;
    if (d.balance <= 0.01) i++;
    if (c.balance <= 0.01) j++;
  }
  return result;
}
