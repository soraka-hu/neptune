"""deprecated placeholder migration kept for revision chain compatibility.

Revision ID: 20260330_05
Revises: 20260320_04
Create Date: 2026-03-30
"""

from __future__ import annotations


revision = "20260330_05"
down_revision = "20260320_04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Intentionally no-op: deprecated schema logic has been removed from codebase.
    pass


def downgrade() -> None:
    # Intentionally no-op.
    pass
