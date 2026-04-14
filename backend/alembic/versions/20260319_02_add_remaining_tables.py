"""add remaining v1 tables

Revision ID: 20260319_02
Revises: 20260319_01
Create Date: 2026-03-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260319_02"
down_revision = "20260319_01"
branch_labels = None
depends_on = None


def _status_check(column_name: str, values: list[str], constraint_name: str) -> sa.CheckConstraint:
    quoted_values = ", ".join(f"'{value}'" for value in values)
    return sa.CheckConstraint(f"{column_name} IN ({quoted_values})", name=constraint_name)


def upgrade() -> None:
    op.create_table(
        "rule_definition",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("rule_type", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_rule_type", "rule_definition", ["rule_type"])
    op.create_index("idx_rule_content_gin", "rule_definition", ["content"])

    op.create_table(
        "rule_project_rel",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("rule_id", sa.BigInteger(), sa.ForeignKey("rule_definition.id"), nullable=False),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("rule_id", "project_id"),
    )

    op.create_table(
        "rule_suite_rel",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("rule_id", sa.BigInteger(), sa.ForeignKey("rule_definition.id"), nullable=False),
        sa.Column("suite_id", sa.BigInteger(), sa.ForeignKey("suite.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("rule_id", "suite_id"),
    )

    op.create_table(
        "dataset",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("dataset_type", sa.String(length=32), nullable=False),
        sa.Column("schema_definition", sa.JSON()),
        sa.Column("generation_config", sa.JSON()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_dataset_project_id", "dataset", ["project_id"])
    op.create_index("idx_dataset_schema_gin", "dataset", ["schema_definition"])

    op.create_table(
        "dataset_item",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("dataset_id", sa.BigInteger(), sa.ForeignKey("dataset.id"), nullable=False),
        sa.Column("case_id", sa.BigInteger(), sa.ForeignKey("case_item.id")),
        sa.Column("input_data", sa.JSON(), nullable=False),
        sa.Column("reference_answer", sa.JSON()),
        sa.Column("meta_info", sa.JSON()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_dataset_item_dataset_id", "dataset_item", ["dataset_id"])
    op.create_index("idx_dataset_item_input_gin", "dataset_item", ["input_data"])

    op.create_table(
        "evaluator",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("evaluator_type", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_evaluator_type", "evaluator", ["evaluator_type"])
    op.create_index("idx_evaluator_config_gin", "evaluator", ["config"])

    op.create_table(
        "environment",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("env_type", sa.String(length=32), nullable=False),
        sa.Column("base_url", sa.String(length=1024)),
        sa.Column("headers", sa.JSON()),
        sa.Column("variables", sa.JSON()),
        sa.Column("secrets_ref", sa.JSON()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_environment_project_id", "environment", ["project_id"])

    op.create_table(
        "prompt_template",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("template_type", sa.String(length=32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("variables_schema", sa.JSON()),
        sa.Column("model_config", sa.JSON()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("updated_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )

    op.create_table(
        "run_record",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("run_no", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("project.id"), nullable=False),
        sa.Column("suite_id", sa.BigInteger(), sa.ForeignKey("suite.id")),
        sa.Column("dataset_id", sa.BigInteger(), sa.ForeignKey("dataset.id")),
        sa.Column("run_type", sa.String(length=32), nullable=False),
        sa.Column("trigger_type", sa.String(length=32), nullable=False),
        sa.Column("source_id", sa.BigInteger()),
        sa.Column("environment_id", sa.BigInteger(), sa.ForeignKey("environment.id")),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("progress", sa.Numeric(5, 2), server_default="0"),
        sa.Column("request_snapshot", sa.JSON()),
        sa.Column("summary", sa.JSON()),
        sa.Column("started_at", sa.DateTime()),
        sa.Column("finished_at", sa.DateTime()),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_no"),
        _status_check(
            "status",
            ["pending", "queued", "running", "partially_success", "success", "failed", "canceled", "timeout"],
            "ck_run_record_status",
        ),
    )
    op.create_index("idx_run_project_id", "run_record", ["project_id"])
    op.create_index("idx_run_suite_id", "run_record", ["suite_id"])
    op.create_index("idx_run_status", "run_record", ["status"])
    op.create_index("idx_run_type", "run_record", ["run_type"])
    op.create_index("ux_run_record_idempotency_key", "run_record", ["idempotency_key"], unique=True)

    op.create_table(
        "run_item",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("run_id", sa.BigInteger(), sa.ForeignKey("run_record.id"), nullable=False),
        sa.Column("case_id", sa.BigInteger(), sa.ForeignKey("case_item.id")),
        sa.Column("dataset_item_id", sa.BigInteger(), sa.ForeignKey("dataset_item.id")),
        sa.Column("item_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("duration_ms", sa.Integer()),
        sa.Column("request_data", sa.JSON()),
        sa.Column("response_data", sa.JSON()),
        sa.Column("parsed_output", sa.JSON()),
        sa.Column("assertion_result", sa.JSON()),
        sa.Column("score_result", sa.JSON()),
        sa.Column("error_info", sa.JSON()),
        sa.Column("started_at", sa.DateTime()),
        sa.Column("finished_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'retrying', 'success', 'failed', 'skipped', 'canceled')",
            name="ck_run_item_status",
        ),
    )
    op.create_index("idx_run_item_run_id", "run_item", ["run_id"])
    op.create_index("idx_run_item_case_id", "run_item", ["case_id"])
    op.create_index("idx_run_item_status", "run_item", ["status"])
    op.create_index("idx_run_item_score_gin", "run_item", ["score_result"])

    op.create_table(
        "run_log",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("run_id", sa.BigInteger(), sa.ForeignKey("run_record.id")),
        sa.Column("run_item_id", sa.BigInteger(), sa.ForeignKey("run_item.id")),
        sa.Column("log_level", sa.String(length=16), nullable=False),
        sa.Column("log_type", sa.String(length=32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("meta_info", sa.JSON()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_run_log_run_id", "run_log", ["run_id"])
    op.create_index("idx_run_log_run_item_id", "run_log", ["run_item_id"])
    op.create_index("idx_run_log_run_created_at", "run_log", ["run_id", "created_at"])

    op.create_table(
        "judge_record",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("run_item_id", sa.BigInteger(), sa.ForeignKey("run_item.id"), nullable=False),
        sa.Column("evaluator_id", sa.BigInteger(), sa.ForeignKey("evaluator.id")),
        sa.Column("prompt_snapshot", sa.Text(), nullable=False),
        sa.Column("input_snapshot", sa.JSON()),
        sa.Column("output_snapshot", sa.JSON()),
        sa.Column("raw_response", sa.JSON()),
        sa.Column("parsed_result", sa.JSON()),
        sa.Column("model_name", sa.String(length=128)),
        sa.Column("model_version", sa.String(length=128)),
        sa.Column("token_usage", sa.JSON()),
        sa.Column("latency_ms", sa.Integer()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_judge_record_run_item_id", "judge_record", ["run_item_id"])
    op.create_index("idx_judge_record_run_item_created_at", "judge_record", ["run_item_id", "created_at"])

    op.create_table(
        "report_record",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("run_id", sa.BigInteger(), sa.ForeignKey("run_record.id"), nullable=False),
        sa.Column("report_type", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=255)),
        sa.Column("content_json", sa.JSON()),
        sa.Column("file_url", sa.String(length=1024)),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("idx_report_run_id", "report_record", ["run_id"])

    op.create_table(
        "version_snapshot",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("resource_type", sa.String(length=32), nullable=False),
        sa.Column("resource_id", sa.BigInteger(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("snapshot_data", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("resource_type", "resource_id", "version"),
    )


def downgrade() -> None:
    op.drop_table("version_snapshot")
    op.drop_index("idx_report_run_id", table_name="report_record")
    op.drop_table("report_record")
    op.drop_index("idx_judge_record_run_item_created_at", table_name="judge_record")
    op.drop_index("idx_judge_record_run_item_id", table_name="judge_record")
    op.drop_table("judge_record")
    op.drop_index("idx_run_log_run_created_at", table_name="run_log")
    op.drop_index("idx_run_log_run_item_id", table_name="run_log")
    op.drop_index("idx_run_log_run_id", table_name="run_log")
    op.drop_table("run_log")
    op.drop_index("idx_run_item_score_gin", table_name="run_item")
    op.drop_index("idx_run_item_status", table_name="run_item")
    op.drop_index("idx_run_item_case_id", table_name="run_item")
    op.drop_index("idx_run_item_run_id", table_name="run_item")
    op.drop_table("run_item")
    op.drop_index("ux_run_record_idempotency_key", table_name="run_record")
    op.drop_index("idx_run_type", table_name="run_record")
    op.drop_index("idx_run_status", table_name="run_record")
    op.drop_index("idx_run_suite_id", table_name="run_record")
    op.drop_index("idx_run_project_id", table_name="run_record")
    op.drop_table("run_record")
    op.drop_table("prompt_template")
    op.drop_index("idx_environment_project_id", table_name="environment")
    op.drop_table("environment")
    op.drop_index("idx_evaluator_config_gin", table_name="evaluator")
    op.drop_index("idx_evaluator_type", table_name="evaluator")
    op.drop_table("evaluator")
    op.drop_index("idx_dataset_item_input_gin", table_name="dataset_item")
    op.drop_index("idx_dataset_item_dataset_id", table_name="dataset_item")
    op.drop_table("dataset_item")
    op.drop_index("idx_dataset_schema_gin", table_name="dataset")
    op.drop_index("idx_dataset_project_id", table_name="dataset")
    op.drop_table("dataset")
    op.drop_table("rule_suite_rel")
    op.drop_table("rule_project_rel")
    op.drop_index("idx_rule_content_gin", table_name="rule_definition")
    op.drop_index("idx_rule_type", table_name="rule_definition")
    op.drop_table("rule_definition")
