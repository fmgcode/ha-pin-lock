# PIN Lock para Home Assistant

Integración que protege una acción (abrir un garaje, encender algo, etc.) con un
código PIN validado **en el backend**. El PIN nunca se expone en el frontend: se
guarda como hash SHA-256 en el registro de configuración de Home Assistant.

Incluye:

- Una **integración** (`pin_lock`) que valida el PIN y ejecuta la acción.
- Una **card** (`pin-lock-card`) con teclado numérico.
- Protección **anti fuerza bruta** (bloqueo temporal tras varios fallos).

## Instalación con HACS

1. En HACS, menú de tres puntos → **Repositorios personalizados**.
2. Añade la URL de este repositorio, categoría **Integración**.
3. Busca **PIN Lock** en HACS e instálalo.
4. Reinicia Home Assistant.

## Registrar la card como recurso

La card (`pin-lock-card.js`) se descarga junto al repo. Añádela como recurso:

1. *Ajustes → Paneles de control → Recursos → Añadir recurso*.
2. URL: `/hacsfiles/ha-pin-lock/pin-lock-card.js`
3. Tipo: **Módulo JavaScript**.

## Configurar un candado PIN

1. *Ajustes → Dispositivos y servicios → Añadir integración → PIN Lock*.
2. Rellena el formulario:
   - **Nombre**: p.ej. `Garaje`.
   - **PIN**: solo dígitos, mínimo 4.
   - **Entidad a controlar**: tu switch/luz/cover/lock.
   - **Acción**: alternar / encender / apagar.
3. Al guardar, se crea una entrada. Necesitas su **entry_id** para la card.

### Obtener el entry_id

*Ajustes → Dispositivos y servicios → PIN Lock* → en la entrada, menú de tres
puntos → **Copiar ID de entrada**.

## Añadir la card al dashboard

```yaml
type: custom:pin-lock-card
entry_id: PEGA_AQUI_EL_ENTRY_ID
name: Garaje
icon: mdi:garage
pin_length: 4
```

## Seguridad

- El PIN se guarda **hasheado** (SHA-256), nunca en claro.
- La validación ocurre en el servidor; el frontend solo envía el código tecleado.
- Tras 5 intentos fallidos, el candado se bloquea 30 segundos.
