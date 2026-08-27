"""Config flow para PIN Lock: alta y edición de candados desde la UI."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import (
    ACTION_TOGGLE,
    ACTION_TURN_OFF,
    ACTION_TURN_ON,
    CONF_ACTION,
    CONF_CONFIRM_TEXT,
    CONF_NAME,
    CONF_NOTIFY_ENABLED,
    CONF_NOTIFY_MESSAGE,
    CONF_NOTIFY_TARGET,
    CONF_NOTIFY_TITLE,
    CONF_PIN,
    CONF_REQUIRE_PIN,
    CONF_STATUS_ENTITY,
    CONF_TARGET_ENTITY,
    DEFAULT_CONFIRM_TEXT,
    DEFAULT_NOTIFY_MESSAGE,
    DEFAULT_NOTIFY_TITLE,
    DOMAIN,
)
from .util import hash_pin


def _action_selector() -> SelectSelector:
    return SelectSelector(
        SelectSelectorConfig(
            options=[ACTION_TOGGLE, ACTION_TURN_ON, ACTION_TURN_OFF],
            mode=SelectSelectorMode.DROPDOWN,
            translation_key="action",
        )
    )


def _target_selector() -> EntitySelector:
    return EntitySelector(
        EntitySelectorConfig(domain=["switch", "light", "cover", "lock"])
    )


def _status_selector() -> EntitySelector:
    return EntitySelector(EntitySelectorConfig(domain=["binary_sensor"]))


def _notify_target_selector() -> EntitySelector:
    return EntitySelector(EntitySelectorConfig(domain=["notify"]))


def _notify_schema_fields(current: dict) -> dict:
    """Campos de notificación, compartidos entre alta y edición."""
    return {
        vol.Optional(
            CONF_NOTIFY_ENABLED, default=current.get(CONF_NOTIFY_ENABLED, False)
        ): BooleanSelector(),
        vol.Optional(
            CONF_NOTIFY_TARGET, default=current.get(CONF_NOTIFY_TARGET)
        ): _notify_target_selector(),
        vol.Optional(
            CONF_NOTIFY_TITLE,
            default=current.get(CONF_NOTIFY_TITLE, DEFAULT_NOTIFY_TITLE),
        ): str,
        vol.Optional(
            CONF_NOTIFY_MESSAGE,
            default=current.get(CONF_NOTIFY_MESSAGE, DEFAULT_NOTIFY_MESSAGE),
        ): str,
    }


def _pin_schema_fields(current: dict) -> dict:
    """Campos de protección: requerir PIN o solo confirmación."""
    return {
        vol.Optional(
            CONF_REQUIRE_PIN, default=current.get(CONF_REQUIRE_PIN, True)
        ): BooleanSelector(),
        vol.Optional(CONF_PIN): str,
        vol.Optional(
            CONF_CONFIRM_TEXT,
            default=current.get(CONF_CONFIRM_TEXT, DEFAULT_CONFIRM_TEXT),
        ): str,
    }


def _extract_notify_data(user_input: dict, data: dict) -> None:
    """Vuelca en `data` los campos de notificación válidos de `user_input`."""
    notify_enabled = bool(user_input.get(CONF_NOTIFY_ENABLED))
    data[CONF_NOTIFY_ENABLED] = notify_enabled
    notify_target = user_input.get(CONF_NOTIFY_TARGET)
    if notify_enabled and notify_target:
        data[CONF_NOTIFY_TARGET] = notify_target
        data[CONF_NOTIFY_TITLE] = (
            user_input.get(CONF_NOTIFY_TITLE) or DEFAULT_NOTIFY_TITLE
        )
        data[CONF_NOTIFY_MESSAGE] = (
            user_input.get(CONF_NOTIFY_MESSAGE) or DEFAULT_NOTIFY_MESSAGE
        )
    else:
        # Sin dispositivo elegido, la notificación no puede activarse de verdad
        data[CONF_NOTIFY_ENABLED] = False
        data.pop(CONF_NOTIFY_TARGET, None)
        data.pop(CONF_NOTIFY_TITLE, None)
        data.pop(CONF_NOTIFY_MESSAGE, None)


def _extract_pin_data(
    user_input: dict, current: dict, data: dict, errors: dict, *, is_new: bool
) -> None:
    """Procesa 'requiere PIN' + PIN + texto de confirmación.

    - Si requiere PIN: hashea el nuevo PIN si se ha escrito uno; si se deja
      en blanco al EDITAR un candado que ya tenía PIN, se mantiene el actual.
      Al CREAR uno nuevo, el PIN es obligatorio si se activa "requiere PIN".
    - Si no requiere PIN: se guarda el texto de confirmación y se elimina
      cualquier PIN que pudiera existir.
    """
    require_pin = bool(user_input.get(CONF_REQUIRE_PIN, True))
    data[CONF_REQUIRE_PIN] = require_pin

    if require_pin:
        new_pin = str(user_input.get(CONF_PIN, "")).strip()
        if new_pin:
            if not new_pin.isdigit() or len(new_pin) < 4:
                errors[CONF_PIN] = "invalid_pin"
            else:
                data[CONF_PIN] = hash_pin(new_pin)
        elif is_new or CONF_PIN not in current:
            # Alta nueva, o edición de un candado que antes no tenía PIN:
            # hace falta un PIN explícito.
            errors[CONF_PIN] = "missing_pin"
        # Edición sin PIN nuevo pero con uno ya existente: se mantiene
        # (ya está en `data` porque parte de `dict(current)`).
    else:
        data.pop(CONF_PIN, None)

    # El texto de confirmación se guarda siempre (aunque ahora no se use),
    # así no se pierde si el usuario alterna "requiere PIN" más adelante.
    data[CONF_CONFIRM_TEXT] = (
        user_input.get(CONF_CONFIRM_TEXT) or DEFAULT_CONFIRM_TEXT
    )


class PinLockConfigFlow(ConfigFlow, domain=DOMAIN):
    """Flujo de configuración para PIN Lock (alta de un nuevo candado)."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Recoge nombre, actuador, sensor, protección, notificación y acción."""
        errors: dict[str, str] = {}

        if user_input is not None:
            data = {
                CONF_NAME: user_input[CONF_NAME],
                CONF_TARGET_ENTITY: user_input[CONF_TARGET_ENTITY],
                CONF_ACTION: user_input[CONF_ACTION],
            }
            status_entity = user_input.get(CONF_STATUS_ENTITY)
            if status_entity:
                data[CONF_STATUS_ENTITY] = status_entity

            _extract_pin_data(user_input, {}, data, errors, is_new=True)
            _extract_notify_data(user_input, data)

            if not errors:
                return self.async_create_entry(
                    title=user_input[CONF_NAME], data=data
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default="Garaje"): str,
                vol.Required(CONF_TARGET_ENTITY): _target_selector(),
                vol.Optional(CONF_STATUS_ENTITY): _status_selector(),
                vol.Required(CONF_ACTION, default=ACTION_TOGGLE): _action_selector(),
                **_pin_schema_fields({}),
                **_notify_schema_fields({}),
            }
        )

        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: ConfigEntry,
    ) -> PinLockOptionsFlow:
        """Habilita editar un candado ya creado."""
        return PinLockOptionsFlow(config_entry)


class PinLockOptionsFlow(OptionsFlow):
    """Permite editar un candado existente sin tener que recrearlo."""

    def __init__(self, entry: ConfigEntry) -> None:
        self.entry = entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        current = self.entry.data

        if user_input is not None:
            new_data = dict(current)
            new_data[CONF_TARGET_ENTITY] = user_input[CONF_TARGET_ENTITY]
            new_data[CONF_ACTION] = user_input[CONF_ACTION]

            status_entity = user_input.get(CONF_STATUS_ENTITY)
            if status_entity:
                new_data[CONF_STATUS_ENTITY] = status_entity
            else:
                new_data.pop(CONF_STATUS_ENTITY, None)

            _extract_pin_data(user_input, current, new_data, errors, is_new=False)
            _extract_notify_data(user_input, new_data)

            if not errors:
                self.hass.config_entries.async_update_entry(
                    self.entry, data=new_data
                )
                return self.async_create_entry(title="", data={})

        schema = vol.Schema(
            {
                vol.Optional(CONF_PIN): str,
                vol.Required(
                    CONF_TARGET_ENTITY, default=current.get(CONF_TARGET_ENTITY)
                ): _target_selector(),
                vol.Optional(
                    CONF_STATUS_ENTITY, default=current.get(CONF_STATUS_ENTITY)
                ): _status_selector(),
                vol.Required(
                    CONF_ACTION, default=current.get(CONF_ACTION, ACTION_TOGGLE)
                ): _action_selector(),
                vol.Optional(
                    CONF_REQUIRE_PIN, default=current.get(CONF_REQUIRE_PIN, True)
                ): BooleanSelector(),
                vol.Optional(
                    CONF_CONFIRM_TEXT,
                    default=current.get(CONF_CONFIRM_TEXT, DEFAULT_CONFIRM_TEXT),
                ): str,
                **_notify_schema_fields(current),
            }
        )

        return self.async_show_form(
            step_id="init", data_schema=schema, errors=errors
        )
