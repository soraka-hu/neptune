"""allow nullable suite_id in run_schedule

Revision ID: 20260410_10
Revises: 20260408_09
Create Date: 2026-04-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260410_10"
down_revision = "20260408_09"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("run_schedule") as batch_op:
        batch_op.alter_column(
            "suite_id",
            existing_type=sa.BigInteger(),
            nullable=True,
        )


def downgrade() -> None:
    with op.batch_alter_table("run_schedule") as batch_op:
        batch_op.alter_column(
            "suite_id",
            existing_type=sa.BigInteger(),
            nullable=False,
        )
