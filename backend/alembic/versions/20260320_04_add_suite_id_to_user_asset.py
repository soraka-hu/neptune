"""add suite_id to user_asset

Revision ID: 20260320_04
Revises: 20260320_03
Create Date: 2026-03-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260320_04"
down_revision = "20260320_03"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    columns = {column["name"] for column in inspector.get_columns("user_asset")}
    if "suite_id" not in columns:
        # Keep this migration SQLite-compatible by avoiding inline FK add.
        op.add_column("user_asset", sa.Column("suite_id", sa.BigInteger(), nullable=True))

    indexes = {index["name"] for index in inspector.get_indexes("user_asset")}
    if "idx_user_asset_suite_id" not in indexes:
        op.create_index("idx_user_asset_suite_id", "user_asset", ["suite_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    indexes = {index["name"] for index in inspector.get_indexes("user_asset")}
    if "idx_user_asset_suite_id" in indexes:
        op.drop_index("idx_user_asset_suite_id", table_name="user_asset")

    columns = {column["name"] for column in inspector.get_columns("user_asset")}
    if "suite_id" in columns:
        op.drop_column("user_asset", "suite_id")
