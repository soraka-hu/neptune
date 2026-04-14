"""add is_deleted column to run_record for soft delete

Revision ID: 20260402_07
Revises: 20260402_06
Create Date: 2026-04-02
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260402_07"
down_revision = "20260402_06"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "run_record",
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index("idx_run_record_is_deleted", "run_record", ["is_deleted"])
    # 兼容历史软删除标记：summary._deleted = true
    op.execute(
        """
        UPDATE run_record
        SET is_deleted = true
        WHERE summary IS NOT NULL
          AND CAST(summary AS TEXT) LIKE '%"_deleted": true%'
        """
    )


def downgrade() -> None:
    op.drop_index("idx_run_record_is_deleted", table_name="run_record")
    op.drop_column("run_record", "is_deleted")
