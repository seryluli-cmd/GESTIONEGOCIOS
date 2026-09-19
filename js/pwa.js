import { $ } from "./utilidades.js";

// ---------- Instalación PWA ----------
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $("#btn-install").classList.remove("hidden");
});
$("#btn-install")?.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#btn-install").classList.add("hidden");
});

// ---------- Service worker + actualización automática ----------
// La app queda instalada en el celular y guarda una copia del código para
// poder abrir sin internet (ver service-worker.js). El efecto colateral es
// que una versión nueva no se ve hasta que la pantalla se recarga, y una
// PWA instalada casi nunca se cierra de verdad: se suspende y se retoma,
// así que puede quedarse semanas mostrando código viejo. Pasó de verdad:
// un socio siguió viendo la app sin la Caja del local mucho después de
// publicarla, y no hay forma de pedirle a cada persona que la cierre a
// mano cada vez que se sube un cambio.
//
// Por eso acá se actualiza sola: se pregunta si hay versión nueva al
// abrir y cada vez que se vuelve a la app, y cuando el service worker
// nuevo toma el control se recarga la pantalla una sola vez.
if ("serviceWorker" in navigator) {
  // Un cambio de controlador significa "salió una versión nueva"... salvo
  // el primero de todos, que es la instalación inicial (ahí no hay nada
  // viejo que reemplazar, y recargar haría que la app se reinicie sola la
  // primera vez que alguien la abre).
  //
  // OJO: esto tiene que ser una variable que se ACTUALIZA, no una foto del
  // momento de cargar. En la primera visita todavía no hay controlador, así
  // que si se dejara fija en `false` nunca se recargaría por más versiones
  // que se publiquen — es exactamente el bug que tenía este bloque.
  let controlada = !!navigator.serviceWorker.controller;
  let recargaPendiente = false;
  let recargando = false;

  // No cortar a alguien que está a medio cargar un gasto: si hay un modal
  // abierto se espera, y se reintenta cuando vuelve a la app. En el peor
  // caso la actualización entra la próxima vez que la abra.
  function recargarSiNoMolesta() {
    if (!recargaPendiente || recargando) return;
    if (document.querySelector(".modal-overlay.active")) return;
    recargando = true;
    location.reload();
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlada) {
      controlada = true;  // era la instalación inicial; de acá en más, sí
      return;
    }
    recargaPendiente = true;
    recargarSiNoMolesta();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        reg.update();            // ¿hay versión nueva publicada?
        recargarSiNoMolesta();   // ¿quedó una pendiente de antes?
      });
    }).catch(console.warn);
  });
}
