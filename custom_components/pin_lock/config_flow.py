"""Config flow para PIN Lock: formulario de configuración en la UI."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.selector import (
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
    CONF_NAME,
    CONF_PIN,
    CONF_TARGET_ENTITY,
    DOMAIN,
)
from .util import hash_pin


class PinLockConfigFlow(ConfigFlow, domain=DOMAIN):
    """Flujo de configuración para PIN Lock."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Primer y único paso: recoger nombre, PIN, entidad y acción."""
        errors: dict[str, str] = {}

        if user_input is not None:
            pin = str(user_input[CONF_PIN]).strip()
            if not pin.isdigit() or len(pin) < 4:
                errors[CONF_PIN] = "invalid_pin"
            else:
                # Guardamos el HASH del PIN, nunca el PIN en claro
                return self.async_create_entry(
                    title=user_input[CONF_NAME],
                    data={
                        CONF_NAME: user_input[CONF_NAME],
                        CONF_PIN: hash_pin(pin),
                        CONF_TARGET_ENTITY: user_input[CONF_TARGET_ENTITY],
                        CONF_ACTION: user_input[CONF_ACTION],
                    },
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default="Garaje"): str,
                vol.Required(CONF_PIN): str,
                vol.Required(CONF_TARGET_ENTITY): EntitySelector(
                    EntitySelectorConfig(domain=["switch", "light", "cover", "lock"])
                ),
                vol.Required(CONF_ACTION, default=ACTION_TOGGLE): SelectSelector(
                    SelectSelectorConfig(
                        options=[ACTION_TOGGLE, ACTION_TURN_ON, ACTION_TURN_OFF],
                        mode=SelectSelectorMode.DROPDOWN,
                        translation_key="action",
                    )
                ),
            }
        )

        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )
