"""add daily_time to run_schedule

Revision ID: 20260408_09
Revises: 20260408_08
Create Date: 2026-04-08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260408_09"
down_revision = "20260408_08"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("run_schedule") as batch_op:
        batch_op.add_column(sa.Column("daily_time", sa.String(length=5), nullable=False, server_default="09:00"))


def downgrade() -> None:
    with op.batch_alter_table("run_schedule") as batch_op:
        batch_op.drop_column("daily_time")
