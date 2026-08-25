"""Constantes de la integración PIN Lock."""

DOMAIN = "pin_lock"

# Claves de configuración
CONF_NAME = "name"
CONF_PIN = "pin"
CONF_TARGET_ENTITY = "target_entity"
CONF_ACTION = "action"

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
