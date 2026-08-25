"""Integración PIN Lock: valida un PIN en el backend y ejecuta una acción."""

from __future__ import annotations

import hashlib
import logging
import time

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import (
    ACTION_TOGGLE,
    ACTION_TURN_OFF,
    ACTION_TURN_ON,
    CONF_ACTION,
    CONF_PIN,
    CONF_TARGET_ENTITY,
    DOMAIN,
    EVENT_RESULT,
    LOCKOUT_SECONDS,
    MAX_ATTEMPTS,
    SERVICE_VALIDATE,
)

_LOGGER = logging.getLogger(__name__)

# Estado en memoria de intentos fallidos por entrada de config
_attempts: dict[str, dict] = {}


def _hash_pin(pin: str) -> str:
    """Devuelve el hash SHA-256 de un PIN."""
    return hashlib.sha256(pin.encode()).hexdigest()


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Configurar una entrada (un candado PIN concreto)."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entry

    # Registrar el servicio solo la primera vez
    if not hass.services.has_service(DOMAIN, SERVICE_VALIDATE):
        await _async_register_service(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Descargar una entrada."""
    hass.data[DOMAIN].pop(entry.entry_id, None)
    _attempts.pop(entry.entry_id, None)

    # Si ya no quedan entradas, quitar el servicio
    if not hass.data[DOMAIN]:
        hass.services.async_remove(DOMAIN, SERVICE_VALIDATE)

    return True


async def _async_register_service(hass: HomeAssistant) -> None:
    """Registrar el servicio pin_lock.validate."""

    async def handle_validate(call: ServiceCall) -> None:
        entry_id = call.data.get("entry_id")
        pin = str(call.data.get("pin", ""))

        entry = hass.data[DOMAIN].get(entry_id)
        if entry is None:
            _LOGGER.warning("pin_lock.validate: entry_id desconocido %s", entry_id)
            hass.bus.async_fire(
                EVENT_RESULT, {"entry_id": entry_id, "result": "error"}
            )
            return

        # Control anti fuerza bruta
        now = time.monotonic()
        state = _attempts.setdefault(entry_id, {"count": 0, "until": 0})
        if state["until"] > now:
            hass.bus.async_fire(
                EVENT_RESULT,
                {"entry_id": entry_id, "result": "locked", "retry_in": int(state["until"] - now)},
            )
            return

        stored_hash = entry.data.get(CONF_PIN)
        if _hash_pin(pin) == stored_hash:
            # PIN correcto: resetear intentos y ejecutar acción
            state["count"] = 0
            await _async_run_action(hass, entry)
            hass.bus.async_fire(
                EVENT_RESULT, {"entry_id": entry_id, "result": "ok"}
            )
        else:
            state["count"] += 1
            if state["count"] >= MAX_ATTEMPTS:
                state["until"] = now + LOCKOUT_SECONDS
                state["count"] = 0
                hass.bus.async_fire(
                    EVENT_RESULT,
                    {"entry_id": entry_id, "result": "locked", "retry_in": LOCKOUT_SECONDS},
                )
            else:
                hass.bus.async_fire(
                    EVENT_RESULT,
                    {
                        "entry_id": entry_id,
                        "result": "fail",
                        "attempts_left": MAX_ATTEMPTS - state["count"],
                    },
                )

    hass.services.async_register(
        DOMAIN,
        SERVICE_VALIDATE,
        handle_validate,
        schema=vol.Schema(
            {
                vol.Required("entry_id"): cv.string,
                vol.Required("pin"): cv.string,
            }
        ),
    )


async def _async_run_action(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Ejecutar la acción configurada sobre la entidad objetivo."""
    target = entry.data.get(CONF_TARGET_ENTITY)
    action = entry.data.get(CONF_ACTION, ACTION_TOGGLE)
    if not target:
        return

    domain = target.split(".")[0]
    service = {
        ACTION_TOGGLE: "toggle",
        ACTION_TURN_ON: "turn_on",
        ACTION_TURN_OFF: "turn_off",
    }.get(action, "toggle")

    await hass.services.async_call(
        domain, service, {"entity_id": target}, blocking=True
    )
