"""normalize run_record.run_type from benchmark to agent_eval

Revision ID: 20260402_06
Revises: 20260330_05
Create Date: 2026-04-02
"""

from __future__ import annotations

from alembic import op


revision = "20260402_06"
down_revision = "20260330_05"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE run_record SET run_type = 'agent_eval' WHERE run_type = 'benchmark'")


def downgrade() -> None:
    # 数据归一化迁移，默认不回滚，避免误将新写入的 agent_eval 数据改回 benchmark。
    pass
