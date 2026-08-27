"""Constantes de la integración PIN Lock."""

DOMAIN = "pin_lock"

# Claves de configuración
CONF_NAME = "name"
CONF_PIN = "pin"
CONF_REQUIRE_PIN = "require_pin"
CONF_CONFIRM_TEXT = "confirm_text"
CONF_TARGET_ENTITY = "target_entity"
CONF_STATUS_ENTITY = "status_entity"
CONF_ACTION = "action"
CONF_NOTIFY_ENABLED = "notify_enabled"
CONF_NOTIFY_TARGET = "notify_target"
CONF_NOTIFY_TITLE = "notify_title"
CONF_NOTIFY_MESSAGE = "notify_message"

# Valores por defecto de la notificación
DEFAULT_NOTIFY_TITLE = "PIN Lock"
DEFAULT_NOTIFY_MESSAGE = "Se ha activado {name}"

# Valor por defecto del texto de confirmación (cuando no se exige PIN)
DEFAULT_CONFIRM_TEXT = "¿Estás seguro de que quieres activar {name}?"

# Acciones posibles al validar el PIN
ACTION_TOGGLE = "toggle"
ACTION_TURN_ON = "turn_on"
ACTION_TURN_OFF = "turn_off"

# Servicio expuesto y evento emitido
SERVICE_VALIDATE = "validate"
EVENT_RESULT = "pin_lock_result"

# Anti fuerza bruta
MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 30
