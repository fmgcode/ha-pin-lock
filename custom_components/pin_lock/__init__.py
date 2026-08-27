"""Integración PIN Lock: valida un PIN en el backend y ejecuta una acción."""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

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
    EVENT_RESULT,
    LOCKOUT_SECONDS,
    MAX_ATTEMPTS,
    SERVICE_VALIDATE,
)
from .util import hash_pin, safe_format

_LOGGER = logging.getLogger(__name__)

# URL pública donde se sirve la card, y nombre del fichero en el paquete
CARD_URL = f"/{DOMAIN}/pin-lock-card.js"
CARD_FILENAME = "pin-lock-card.js"

# Estado en memoria de intentos fallidos por entrada de config
_attempts: dict[str, dict] = {}


def _read_manifest_version() -> str | None:
    """Lee la versión directamente del manifest.json del propio paquete."""
    manifest_path = Path(__file__).parent / "manifest.json"
    try:
        with manifest_path.open(encoding="utf-8") as f:
            return json.load(f).get("version")
    except (OSError, ValueError):
        return None


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Configurar una entrada (un candado PIN concreto)."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entry

    # Registrar el servicio y el comando websocket solo la primera vez
    if not hass.services.has_service(DOMAIN, SERVICE_VALIDATE):
        await _async_register_service(hass)
    if not hass.data[DOMAIN].get("_ws_registered"):
        websocket_api.async_register_command(hass, _websocket_list_entries)
        hass.data[DOMAIN]["_ws_registered"] = True

    # Servir y registrar la card automáticamente (solo una vez)
    await _async_register_card(hass)

    return True


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list"})
@websocket_api.async_response
async def _websocket_list_entries(hass, connection, msg):
    """Expone al frontend los datos NO sensibles de cada candado (sin el PIN)."""
    entries = []
    for entry_id, entry in hass.data.get(DOMAIN, {}).items():
        if entry_id.startswith("_"):
            continue
        name = entry.data.get(CONF_NAME, entry.title)
        requires_pin = _requires_pin(entry)
        entries.append(
            {
                "entry_id": entry_id,
                "name": name,
                "status_entity": entry.data.get(CONF_STATUS_ENTITY),
                "requires_pin": requires_pin,
                "confirm_text": None
                if requires_pin
                else safe_format(
                    entry.data.get(CONF_CONFIRM_TEXT, DEFAULT_CONFIRM_TEXT),
                    name=name,
                ),
            }
        )
    connection.send_result(msg["id"], {"entries": entries})


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

    # Añadir la card como recurso de Lovelace (modo storage), con la versión
    # del manifest para forzar recarga de caché en cada actualización.
    version = _read_manifest_version()
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


def _requires_pin(entry: ConfigEntry) -> bool:
    """Un candado requiere PIN si el toggle está activo Y tiene un PIN guardado."""
    return bool(entry.data.get(CONF_REQUIRE_PIN, True)) and entry.data.get(
        CONF_PIN
    ) is not None


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

        if not _requires_pin(entry):
            # Candado en modo "solo confirmación": no hay PIN que comparar,
            # se ejecuta la acción directamente (misma vía que un PIN correcto,
            # incluida la notificación).
            await _async_run_action(hass, entry)
            await _async_maybe_notify(hass, entry)
            hass.bus.async_fire(EVENT_RESULT, {"entry_id": entry_id, "result": "ok"})
            return

        # Control anti fuerza bruta (solo aplica a candados con PIN real)
        now = time.monotonic()
        state = _attempts.setdefault(entry_id, {"count": 0, "until": 0})
        if state["until"] > now:
            hass.bus.async_fire(
                EVENT_RESULT,
                {"entry_id": entry_id, "result": "locked", "retry_in": int(state["until"] - now)},
            )
            return

        stored_hash = entry.data.get(CONF_PIN)
        if hash_pin(pin) == stored_hash:
            # PIN correcto: resetear intentos, ejecutar acción y notificar
            state["count"] = 0
            await _async_run_action(hass, entry)
            await _async_maybe_notify(hass, entry)
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


async def _async_maybe_notify(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Envía una notificación al dispositivo configurado, si está activada."""
    if not entry.data.get(CONF_NOTIFY_ENABLED):
        return

    notify_target = entry.data.get(CONF_NOTIFY_TARGET)
    if not notify_target:
        return

    name = entry.data.get(CONF_NAME, entry.title)
    title = safe_format(
        entry.data.get(CONF_NOTIFY_TITLE, DEFAULT_NOTIFY_TITLE), name=name
    )
    message = safe_format(
        entry.data.get(CONF_NOTIFY_MESSAGE, DEFAULT_NOTIFY_MESSAGE), name=name
    )

    try:
        await hass.services.async_call(
            "notify",
            "send_message",
            {"entity_id": notify_target, "title": title, "message": message},
            blocking=False,
        )
    except Exception as err:  # noqa: BLE001
        # Un fallo al notificar no debe afectar a que la acción ya se ejecutó
        _LOGGER.warning("No se pudo enviar la notificación de PIN Lock: %s", err)
