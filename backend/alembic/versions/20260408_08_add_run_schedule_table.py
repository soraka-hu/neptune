"""add run schedule table

Revision ID: 20260408_08
Revises: 20260402_07
Create Date: 2026-04-08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260408_08"
down_revision = "20260402_07"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "run_schedule",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("run_type", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("suite_id", sa.BigInteger(), sa.ForeignKey("suite.id"), nullable=False),
        sa.Column("environment_id", sa.BigInteger(), sa.ForeignKey("environment.id"), nullable=False),
        sa.Column("dataset_id", sa.BigInteger(), sa.ForeignKey("dataset.id")),
        sa.Column("rule_ids", sa.JSON()),
        sa.Column("interval_minutes", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("evaluation_mode", sa.String(length=32), nullable=False, server_default="with_reference"),
        sa.Column("next_run_at", sa.DateTime(), nullable=False),
        sa.Column("last_run_at", sa.DateTime()),
        sa.Column("last_run_id", sa.BigInteger(), sa.ForeignKey("run_record.id")),
        sa.Column("trigger_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("meta_info", sa.JSON()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("run_type IN ('api_test', 'agent_eval')", name="ck_run_schedule_run_type"),
        sa.CheckConstraint("status IN ('active', 'paused', 'archived')", name="ck_run_schedule_status"),
        sa.CheckConstraint("interval_minutes >= 1", name="ck_run_schedule_interval"),
    )
    op.create_index("idx_run_schedule_project_id", "run_schedule", ["project_id"])
    op.create_index("idx_run_schedule_suite_id", "run_schedule", ["suite_id"])
    op.create_index("idx_run_schedule_status", "run_schedule", ["status"])
    op.create_index("idx_run_schedule_run_type", "run_schedule", ["run_type"])
    op.create_index("idx_run_schedule_next_run_at", "run_schedule", ["next_run_at"])


def downgrade() -> None:
    op.drop_index("idx_run_schedule_next_run_at", table_name="run_schedule")
    op.drop_index("idx_run_schedule_run_type", table_name="run_schedule")
    op.drop_index("idx_run_schedule_status", table_name="run_schedule")
    op.drop_index("idx_run_schedule_suite_id", table_name="run_schedule")
    op.drop_index("idx_run_schedule_project_id", table_name="run_schedule")
    op.drop_table("run_schedule")
