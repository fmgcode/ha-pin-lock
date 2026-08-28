# PIN Lock para Home Assistant

Integración que protege una acción (abrir un garaje, encender algo, etc.) con
un código PIN validado **en el backend**. El PIN nunca se expone en el
frontend: se guarda como hash SHA-256 en el registro de configuración de Home
Assistant.

Incluye:

- Una **integración** (`pin_lock`) que valida el PIN y ejecuta la acción.
- Una **card** (`pin-lock-card`) con teclado numérico o confirmación simple,
  según lo que exija cada candado.
- Protección **anti fuerza bruta** (bloqueo temporal tras varios fallos).

## Instalación con HACS

1. En HACS, menú de tres puntos → **Repositorios personalizados**.
2. Añade la URL de este repositorio, categoría **Integración**.
3. Busca **PIN Lock** en HACS e instálalo.
4. Reinicia Home Assistant.

La card se **auto-registra** al reiniciar. No hace falta añadir recursos a
mano en *Ajustes → Paneles de control → Recursos*.

## Configurar un candado PIN

1. *Ajustes → Dispositivos y servicios → Añadir integración → PIN Lock*.
2. Rellena el formulario:
   - **Nombre**: p.ej. `Garaje`.
   - **Entidad a controlar (actuador)**: tu switch, luz, cover o lock.
   - **Sensor de estado (opcional)**: un `binary_sensor` que indique si la
     puerta está abierta o cerrada. Si lo defines, la card lo mostrará
     automáticamente — **no hace falta configurarlo también en la card**.
   - **Acción**: alternar, encender o apagar cuando se valide.
   - **Requiere PIN**: activado por defecto. Si lo **desactivas**, el
     candado deja de pedir un código y en su lugar la card muestra un
     panel de confirmación simple ("¿Estás seguro?" / Cancelar / Confirmar),
     como el `confirmation` nativo de Lovelace pero ejecutado por esta
     integración (con el mismo soporte de notificación).
     - Con PIN activado: código obligatorio, solo dígitos, mínimo 4.
     - Sin PIN: puedes personalizar el **texto de confirmación**, con
       `{name}` como placeholder para el nombre del candado (por defecto:
       *"¿Estás seguro de que quieres activar {name}?"*).
   - **Notificar a un dispositivo (opcional)**: si lo activas, elige el
     dispositivo destino, el título y el mensaje. Se envía siempre que la
     acción se ejecuta con éxito — **tanto si fue por PIN correcto como si
     fue por una confirmación simple** (candado sin PIN). En el mensaje
     puedes usar `{name}`.

     **Requisito**: el dispositivo debe estar disponible como **entidad
     `notify`** (p.ej. `notify.iphone_de_fermin`). Esto lo proveen
     automáticamente los teléfonos con la app Companion en versiones
     recientes de HA. Si tu dispositivo aparece como servicio antiguo
     (`notify.mobile_app_xxx`) pero no como entidad, no aparecerá en el
     selector — actualiza la app Companion/HA para que se cree la entidad.

Puedes configurar **varios candados** añadiendo la integración varias veces.

### Editar un candado ya creado

*Ajustes → Dispositivos y servicios → PIN Lock → [tu candado] → Configurar.*
Puedes cambiar el actuador, el sensor de estado y la acción. El PIN solo se
actualiza si rellenas el campo; si lo dejas en blanco, se mantiene el actual.

## Añadir la card al dashboard

*Editar dashboard → Añadir tarjeta → **PIN Lock Card***.

En el editor visual:

- **Candado PIN Lock**: desplegable con los candados que hayas configurado.
  Es el único dato "de negocio" que la card necesita — el actuador y el
  sensor de puerta viven en la integración, no aquí.
  El modo de la card se determina automáticamente según **Requiere PIN** del
  candado: con PIN, teclado numérico siempre visible; sin PIN, un tile
  compacto que abre un diálogo de confirmación al pulsarlo.
- **Nombre a mostrar** e **icono**: preferencias visuales de esta card en
  concreto (puedes tener el mismo candado en varias cards con distinto
  nombre/icono si quieres).
- **Icono secundario** (`secondary_icon`, por defecto `mdi:lock`): solo se
  usa en candados sin PIN, junto al nombre en la tile, para indicar que al
  pulsar se pedirá confirmación.
- **Estado de puerta**: si el candado elegido tiene un sensor asociado, la
  card lo detecta sola y te deja personalizar **colores** y **textos** de
  abierto/cerrado. Si no tiene sensor, este apartado no aparece.

### Ejemplo de YAML

```yaml
type: custom:pin-lock-card
entry_id: TU_ENTRY_ID
name: Garaje
icon: mdi:garage
secondary_icon: mdi:lock
color_open: "#d84343"
color_closed: "#2e8b57"
text_open: Abierto
text_closed: Cerrado
```

(`status_entity` ya no se configura aquí — se toma automáticamente del
candado elegido en `entry_id`.)

## Uso

**Candados con PIN**: se introducen los dígitos del PIN y **se pulsa la V**
(✓) para validar. La longitud es libre. La tecla ⌫ borra el último dígito.

**Candados sin PIN (solo confirmación)**: la card muestra el texto de
confirmación configurado y dos botones, **Cancelar** y **Confirmar**. Al
confirmar, se ejecuta la acción directamente — sin código, igual que el
`confirmation` nativo de Lovelace, pero pasando por la misma integración
(con soporte de notificación).

En candados sin PIN, si la acción se ejecuta con éxito el diálogo de
confirmación se cierra automáticamente.

Con PIN, si el código es incorrecto se muestra "Código incorrecto" (en su
propia línea, bajo el teclado, sin mezclarse con el estado de la puerta) y
se reinicia el teclado. Tras 5 intentos fallidos consecutivos, el candado se
bloquea 30 segundos. Este bloqueo **no aplica** a los candados sin PIN, ya
que no hay nada que "adivinar".

## Seguridad

- El PIN se guarda **hasheado** con SHA-256. Nunca se almacena ni se
  transmite en claro.
- La validación se hace en el backend: la card solo envía el código
  tecleado, y el servidor decide.
- El PIN correcto nunca sale del servidor hacia el navegador.
- El comando websocket que usa la card para saber qué sensor de puerta
  mostrar (`pin_lock/list`) expone únicamente `entry_id`, `name` y
  `status_entity` — **nunca** el PIN ni su hash.
- Anti fuerza bruta: 5 intentos fallidos → bloqueo de 30 segundos.

## Servicio expuesto

```yaml
action: pin_lock.validate
data:
  entry_id: TU_ENTRY_ID
  pin: "1234"
```

El resultado se emite como evento `pin_lock_result` con
`result: ok / fail / locked / error`.

## Cambios importantes en la v2.0.0

- `status_entity` (el sensor de puerta) se configura ahora **en la
  integración**, junto al actuador — no en la card. Esto evita tener el
  actuador y el sensor del mismo dispositivo definidos en dos sitios
  distintos.
- Si venías de una versión anterior con `status_entity` en el YAML de tu
  card, ese valor deja de tener efecto: vuelve a *Ajustes → Dispositivos y
  servicios → PIN Lock → tu candado → Configurar* y añade ahí el sensor.
- Ahora se puede **editar** un candado ya creado (actuador, sensor, acción y
  PIN) sin tener que borrarlo y recrearlo.
