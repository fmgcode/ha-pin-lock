"""Utilidades compartidas de la integración PIN Lock."""

from __future__ import annotations

import hashlib


def hash_pin(pin: str) -> str:
    """Devuelve el hash SHA-256 de un PIN."""
    return hashlib.sha256(pin.encode()).hexdigest()
