"""init core tables

Revision ID: 20260319_01
Revises:
Create Date: 2026-03-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260319_01"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("project_key", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("project_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("owner_id", sa.BigInteger()),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_key"),
    )
    op.create_table(
        "suite",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("suite_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("tags", sa.JSON()),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_suite_project_id", "suite", ["project_id"])
    op.create_index("idx_suite_type", "suite", ["suite_type"])
    op.create_table(
        "case_item",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("suite_id", sa.BigInteger(), sa.ForeignKey("suite.id")),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("case_type", sa.String(length=32), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False, server_default="manual"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("priority", sa.String(length=16), server_default="P2"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("input_payload", sa.JSON()),
        sa.Column("expected_output", sa.JSON()),
        sa.Column("assertion_config", sa.JSON()),
        sa.Column("eval_config", sa.JSON()),
        sa.Column("meta_info", sa.JSON()),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_case_project_id", "case_item", ["project_id"])
    op.create_index("idx_case_suite_id", "case_item", ["suite_id"])
    op.create_index("idx_case_type", "case_item", ["case_type"])
    op.create_index("idx_case_status", "case_item", ["status"])


def downgrade() -> None:
    op.drop_index("idx_case_status", table_name="case_item")
    op.drop_index("idx_case_type", table_name="case_item")
    op.drop_index("idx_case_suite_id", table_name="case_item")
    op.drop_index("idx_case_project_id", table_name="case_item")
    op.drop_table("case_item")
    op.drop_index("idx_suite_type", table_name="suite")
    op.drop_index("idx_suite_project_id", table_name="suite")
    op.drop_table("suite")
    op.drop_table("project")

