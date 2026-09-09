# Reglas para que un programa aguante crecer

Escrito para los proyectos web propios (JavaScript vanilla + Firebase, sin
build): GESTIONEGOCIOS, CyberBIOS, FRWEB y los que vengan.

Casi todos los ejemplos son cosas que **pasaron de verdad** en esta app. No
son teoría: son las cicatrices.

---

## Las 10 principales

### 1. Un dato, un solo lugar que lo calcula

Si el mismo número se calcula en dos lados, tarde o temprano dan distinto.

**Pasó acá:** la caja del local se calculaba en las pantallas y *además* en el
aviso de "esto te deja en negativo". Ese aviso hacía su propia cuenta e
ignoraba las reposiciones, así que avisaba de un rojo que no existía. Hoy
todos preguntan a `cajaLocalCalculo()`.

> Antes de copiar y pegar un cálculo: extraelo a una función y usala en los
> dos lados.

### 2. Separá el cálculo de lo que se ve

Una función calcula, otra dibuja. `cajaLocalCalculo()` no sabe de colores ni
de pantallas; `renderCajaLocalCard()` no sabe de matemática.

Así podés rediseñar sin miedo a romper la plata, que es lo que importa.

### 3. Preguntale a una función, no compares textos sueltos

Mal: `if (negocio === "pancho")` repetido en diez lugares.
Bien: `negocioTieneCajaLocal(id)`.

El día que la heladería también tenga caja, cambiás **una línea** en vez de
diez, y no te olvidás ninguna. Lo mismo con `esSocio()` para los permisos.

### 4. Agrupá por secciones desde el primer día

`app.js` tiene más de 3.000 líneas. Se puede partir en archivos, pero **solo
porque está agrupado por temas** con sus comentarios de encabezado.

Ordenalo *antes* de que crezca. Después es una mudanza.

### 5. Los nombres no pueden mentir

Una clase se llamaba `stat-hero-label-2x` porque era el doble. Cuando le
bajamos el tamaño dejó de ser el doble de nada, y se renombró.

> Un nombre que miente es peor que uno feo: te hace tomar decisiones
> equivocadas sin que te des cuenta.

### 6. Comentá el porqué, no el qué

"Esto suma dos números" no sirve — eso ya lo dice el código.

"Esto no usa `toISOString()` porque de noche en Argentina adelanta un día y
los gastos caen en el mes equivocado" **sí** sirve: evita que alguien lo
"simplifique" y rompa todo seis meses después.

### 7. Todo cambio en la forma de los datos necesita una migración que se pueda correr dos veces

Cuando la caja pasó de ser un número suelto a un historial, los $600.000 ya
cargados tenían que sobrevivir. La migración usa un identificador fijo: si
tres celulares la corren al mismo tiempo, escriben lo mismo en vez de
triplicar la plata.

> Asumí siempre que se va a ejecutar más veces de las que pensás.

### 8. Probalo de verdad, no supongas

La actualización automática estaba escrita, se veía impecable, y **no
funcionaba**: una variable se calculaba una sola vez, cuando todavía no había
nada que comparar. Se descubrió solo al simular un deploy real.

> Si no lo probaste, no sabés si anda. Lo creés.

### 9. Una sola fuente de verdad del código

La notebook tenía 3 commits que GitHub no tenía, y GitHub 16 que la notebook
no. Casi se pierde un arreglo real por sincronizar a lo bruto.

GitHub manda. Todo lo demás se sincroniza contra eso, y antes de pisar algo,
se mira qué había.

### 10. Que el programa se mantenga solo

Si para que funcione hay que pedirle algo a la gente, no escala.

**Pasó acá:** había que pedirle a cada socio que cerrara y abriera la app en
cada actualización. Ahora se actualiza sola.

> Cada tarea manual que le sacás al usuario es un problema que no vas a tener
> que resolver diez veces.

---

## Las 5 que agregaría

### 11. Degradá, no rompas

Si algo secundario falla, guardá lo importante igual y avisá.

**Ejemplo de acá:** si la foto de la factura no sube, el gasto **se guarda
igual** sin foto y aparece un aviso. Mejor un gasto sin foto que un gasto
perdido.

### 12. Los datos viejos tienen que seguir funcionando

Cada vez que agregues un campo, preguntate: *¿qué pasa con lo que ya está
guardado?*

En esta app: los gastos viejos sin forma de pago se muestran como Efectivo;
los cierres viejos sin desglose quedan en blanco; las ideas sin negocio se
ven en los dos. Nunca desaparece nada.

### 13. Nada puede quedar colgado para siempre

Toda espera necesita un límite. Si Firebase no responde, la subida de la foto
corta a los 25 segundos y sigue.

**Sin eso:** el botón queda en "Subiendo…" para siempre y la única salida es
cerrar la app. Peor que un error es que no pase nada.

### 14. Cambios chicos, frecuentes y reversibles

Veinte commits chicos con mensaje claro valen más que uno gigante.

Cuando algo se rompe, con cambios chicos sabés exactamente cuál fue. Con uno
grande, tenés que revisar todo. Y cada uno se puede deshacer solo, sin
arrastrar al resto.

### 15. Escribí para vos dentro de seis meses

No vas a acordarte de por qué tomaste una decisión. Esa persona futura no
tiene tu contexto de hoy, pero tiene tus mismos problemas.

Por eso el README explica las decisiones y las trampas, y no solo qué hace
cada cosa.

---

## Dos que no son reglas de diseño, pero cuestan caro

**Todo texto que venga de afuera es peligroso** hasta que lo limpies. Todo lo
que escriben las personas pasa por `escapeHtml()` antes de mostrarse: si
alguien escribe código en la descripción de un gasto, se ve como texto en vez
de ejecutarse.

**Esconder botones no es seguridad.** Los PIN y los permisos de esta app
sirven para ordenar quién ve qué, no para frenar a alguien malintencionado
con conocimientos técnicos: los datos siguen accesibles para quien tenga la
configuración de Firebase. Está bien así para este caso — solo no lo
confundas con una caja fuerte.
