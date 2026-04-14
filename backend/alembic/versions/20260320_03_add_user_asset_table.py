"""add user asset table for asset center uploads

Revision ID: 20260320_03
Revises: 20260319_02
Create Date: 2026-03-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260320_03"
down_revision = "20260319_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_asset",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("asset_type", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("file_name", sa.String(length=255)),
        sa.Column("content_text", sa.Text()),
        sa.Column("content_json", sa.JSON()),
        sa.Column("meta_info", sa.JSON()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_user_asset_project_id", "user_asset", ["project_id"])
    op.create_index("idx_user_asset_type", "user_asset", ["asset_type"])
    op.create_index("idx_user_asset_status", "user_asset", ["status"])


def downgrade() -> None:
    op.drop_index("idx_user_asset_status", table_name="user_asset")
    op.drop_index("idx_user_asset_type", table_name="user_asset")
    op.drop_index("idx_user_asset_project_id", table_name="user_asset")
    op.drop_table("user_asset")
