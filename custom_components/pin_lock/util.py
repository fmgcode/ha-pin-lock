"""Utilidades compartidas de la integración PIN Lock."""

from __future__ import annotations

import hashlib


def hash_pin(pin: str) -> str:
    """Devuelve el hash SHA-256 de un PIN."""
    return hashlib.sha256(pin.encode()).hexdigest()


def safe_format(template: str, **kwargs) -> str:
    """Aplica str.format() sin romper si el usuario escribió un placeholder
    inválido (p.ej. `{algo_que_no_existe}`): en ese caso devuelve el texto
    original tal cual, en vez de lanzar una excepción."""
    try:
        return template.format(**kwargs)
    except (KeyError, ValueError, IndexError):
        return template
