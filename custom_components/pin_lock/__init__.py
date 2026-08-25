"""Integración PIN Lock: valida un PIN en el backend y ejecuta una acción."""

from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

import voluptuous as vol

from homeassistant.components.http import StaticPathConfig
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

# URL pública donde se sirve la card, y nombre del fichero en el paquete
CARD_URL = f"/{DOMAIN}/pin-lock-card.js"
CARD_FILENAME = "pin-lock-card.js"

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

    # Servir y registrar la card automáticamente (solo una vez)
    await _async_register_card(hass)

    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Servir el JS de la card y añadirlo como recurso de Lovelace automáticamente."""
    if hass.data[DOMAIN].get("_card_registered"):
        return

    card_path = Path(__file__).parent / CARD_FILENAME
    if not card_path.exists():
        _LOGGER.warning("No se encontró la card en %s", card_path)
        return

    # Servir el fichero estático bajo CARD_URL
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(card_path), cache_headers=False)]
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("No se pudo servir la card: %s", err)
        return

    # Añadir la card como recurso de Lovelace (modo storage)
    version = None
    try:
        integration = hass.data.get("integrations", {}).get(DOMAIN)
        if integration is not None:
            version = str(integration.version)
    except Exception:  # noqa: BLE001
        version = None

    url = f"{CARD_URL}?v={version}" if version else CARD_URL

    try:
        lovelace = hass.data.get("lovelace")
        resources = getattr(lovelace, "resources", None)
        if resources is not None:
            if not resources.loaded:
                await resources.async_load()
                resources.loaded = True
            already = any(
                item.get("url", "").split("?")[0] == CARD_URL
                for item in resources.async_items()
            )
            if not already:
                await resources.async_create_item(
                    {"res_type": "module", "url": url}
                )
                _LOGGER.info("Card PIN Lock registrada como recurso: %s", url)
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning(
            "No se pudo registrar la card como recurso automáticamente "
            "(añádela manualmente como %s): %s",
            CARD_URL,
            err,
        )

    hass.data[DOMAIN]["_card_registered"] = True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Descargar una entrada."""
    hass.data[DOMAIN].pop(entry.entry_id, None)
    _attempts.pop(entry.entry_id, None)

    # Contar solo entradas reales (ignorar claves de control internas)
    remaining = [k for k in hass.data[DOMAIN] if not k.startswith("_")]
    if not remaining:
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
