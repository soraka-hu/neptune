from __future__ import annotations

import json
import os
from typing import Any

from app.application.project_service import NotFoundError
from app.infrastructure.llm.model_gateway_client import ModelGatewayClient
from app.infrastructure.repositories.project_repository import ProjectRepository
from app.infrastructure.repositories.rule_repository import RuleRepository
from app.infrastructure.repositories.suite_repository import SuiteRepository

RULE_GEN_DEFAULT_MODEL = os.getenv("CASE_GEN_MODEL", "kimi-k2.5").strip() or "kimi-k2.5"


class RuleService:
    def __init__(
        self,
        repository: RuleRepository | None = None,
        project_repository: ProjectRepository | None = None,
        suite_repository: SuiteRepository | None = None,
        model_gateway_client: ModelGatewayClient | None = None,
    ) -> None:
        self.repository = repository or RuleRepository()
        self.project_repository = project_repository or ProjectRepository()
        self.suite_repository = suite_repository or SuiteRepository()
        self.model_gateway_client = model_gateway_client or ModelGatewayClient()

    def create_rule(self, payload: dict) -> dict:
        return self.repository.create(payload)

    def list_rules(self, rule_type: str | None = None) -> list[dict]:
        return self.repository.list(rule_type=rule_type)

    def list_rule_overview(self, rule_types: list[str] | None = None) -> list[dict]:
        return self.repository.list_overview(rule_types=rule_types)

    def get_rule(self, rule_id: int) -> dict:
        record = self.repository.get(rule_id)
        if record is None:
            raise NotFoundError(f"rule {rule_id} not found")
        return record

    def get_rule_relations(self, rule_id: int) -> dict:
        self.get_rule(rule_id)
        return self.repository.get_relations(rule_id)

    def update_rule(self, rule_id: int, payload: dict) -> dict:
        record = self.repository.update(rule_id, payload)
        if record is None:
            raise NotFoundError(f"rule {rule_id} not found")
        return record

    def delete_rule(self, rule_id: int) -> dict:
        record = self.repository.delete(rule_id)
        if record is None:
            raise NotFoundError(f"rule {rule_id} not found")
        return record

    def bind_projects(self, rule_id: int, project_ids: list[int]) -> dict:
        self.get_rule(rule_id)
        bound_ids = self.repository.bind_projects(rule_id, project_ids)
        return {"rule_id": rule_id, "project_ids": bound_ids}

    def bind_suites(self, rule_id: int, suite_ids: list[int]) -> dict:
        self.get_rule(rule_id)
        bound_ids = self.repository.bind_suites(rule_id, suite_ids)
        return {"rule_id": rule_id, "suite_ids": bound_ids}

    def _resolve_generation_scope(self, payload: dict[str, Any]) -> tuple[int, int | None]:
        project_id = int(payload.get("project_id") or 0)
        if project_id <= 0:
            raise ValueError("project_id is required")
        suite_id = payload.get("suite_id")
        if suite_id is not None:
            suite_id = int(suite_id)
            if suite_id <= 0:
                raise ValueError("suite_id must be positive integer")

        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")

        if suite_id is not None:
            suite = self.suite_repository.get(suite_id)
            if suite is None:
                raise NotFoundError(f"suite {suite_id} not found")
            if int(suite.get("project_id") or 0) != project_id:
                raise ValueError("suite does not belong to project")
        return project_id, suite_id

    def generate_agent_scoring_rules(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id, suite_id = self._resolve_generation_scope(payload)

        agent_description = str(payload.get("agent_description") or "").strip()
        if not agent_description:
            raise ValueError("agent_description is required")

        user_requirement = str(payload.get("user_requirement") or "").strip()
        rule_note = str(payload.get("rule_note") or "").strip()
        model_name = str(payload.get("model") or "").strip() or None
        count = max(3, min(5, int(payload.get("count") or 3)))
        with_reference = bool(payload.get("with_reference", True))
        bind_project = bool(payload.get("bind_project", True))
        bind_suite = bool(payload.get("bind_suite", True))
        dimension_hints = self._normalize_dimension_hints(payload.get("dimensions"))

        templates, generation_meta = self._generate_agent_scoring_rule_templates(
            project_id=project_id,
            agent_description=agent_description,
            user_requirement=user_requirement,
            rule_note=rule_note,
            dimensions=dimension_hints,
            with_reference=with_reference,
            count=count,
            model_name=model_name,
        )

        created_rules: list[dict[str, Any]] = []
        for index, template in enumerate(templates[:count], start=1):
            normalized = self._normalize_scoring_rule_record(
                template=template,
                index=index,
                with_reference=with_reference,
                user_requirement=user_requirement,
                rule_note=rule_note,
                dimension_hints=dimension_hints,
            )
            created = self.repository.create(
                {
                    "name": normalized["name"],
                    "rule_type": "scoring",
                    "description": normalized["description"],
                    "content": normalized["content"],
                    "status": "active",
                    "version": 1,
                }
            )
            created_rules.append(created)
            if bind_project:
                self.repository.bind_projects(int(created["id"]), [project_id])
            if bind_suite and suite_id is not None:
                self.repository.bind_suites(int(created["id"]), [suite_id])

        return {
            "project_id": project_id,
            "suite_id": suite_id,
            "generated_count": len(created_rules),
            "generated_rule_ids": [int(item["id"]) for item in created_rules],
            "rules": created_rules,
            "generation_meta": generation_meta,
        }

    def generate_agent_scoring_dimensions(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id, suite_id = self._resolve_generation_scope(payload)

        agent_description = str(payload.get("agent_description") or "").strip()
        if not agent_description:
            raise ValueError("agent_description is required")

        user_requirement = str(payload.get("user_requirement") or "").strip()
        rule_note = str(payload.get("rule_note") or "").strip()
        model_name = str(payload.get("model") or "").strip() or None
        with_reference = bool(payload.get("with_reference", True))
        dimension_hints = self._normalize_dimension_hints(payload.get("dimensions"))
        keyword_hints = self._extract_agent_keyword_hints(agent_description, user_requirement, rule_note)
        count_seed = int(payload.get("count") or 0)
        target_count = max(6, min(8, count_seed if count_seed > 0 else max(6, len(dimension_hints))))
        llm_seed_count = max(3, min(5, target_count))

        templates, generation_meta = self._generate_agent_scoring_rule_templates(
            project_id=project_id,
            agent_description=agent_description,
            user_requirement=user_requirement,
            rule_note=rule_note,
            dimensions=dimension_hints,
            with_reference=with_reference,
            count=llm_seed_count,
            model_name=model_name,
        )

        collected: list[dict[str, Any]] = []
        seen_names: set[str] = set()
        for template in templates:
            normalized_dimensions = self._normalize_dimensions(template.get("dimensions"), dimension_hints)
            for item in normalized_dimensions:
                name = str(item.get("name") or "").strip()
                if not name or name in seen_names:
                    continue
                seen_names.add(name)
                collected.append(
                    {
                        "name": name,
                        "weight": float(item.get("weight") or 0.0),
                        "description": str(item.get("description") or f"{name} 维度评分").strip(),
                    }
                )

        if not collected and dimension_hints:
            collected = [
                {
                    "name": dim,
                    "weight": 0.0,
                    "description": f"{dim} 维度评分",
                }
                for dim in dimension_hints
            ]

        if not collected:
            collected = [
                {"name": dim, "weight": 0.0, "description": f"{dim} 维度评分"}
                for dim in (keyword_hints or ["意图理解准确性", "情绪支持有效性", "陪伴连贯性"])
            ]

        normalized = self._normalize_dimensions(collected, [])
        if len(normalized) > target_count:
            normalized = self._normalize_dimensions(normalized[:target_count], [])
        elif len(normalized) < target_count:
            existing_names = {str(item.get("name") or "").strip() for item in normalized}
            seed_names = [
                *dimension_hints,
                *keyword_hints,
                "意图理解准确性",
                "情绪支持有效性",
                "陪伴连贯性",
                "多轮对话自然度",
                "回复温度与同理性",
            ]
            for seed in seed_names:
                name = str(seed or "").strip()
                if not name or name in existing_names:
                    continue
                normalized.append({"name": name, "weight": 0.0, "description": f"{name} 维度评分"})
                existing_names.add(name)
                if len(normalized) >= target_count:
                    break
            normalized = self._normalize_dimensions(normalized, [])
        normalized = self._enforce_agent_dimension_relevance(normalized, keyword_hints, target_count)
        normalized = self._normalize_dimensions_positive(normalized)
        return {
            "project_id": project_id,
            "suite_id": suite_id,
            "count": len(normalized),
            "dimensions": normalized,
            "generation_meta": generation_meta,
        }

    def _generate_agent_scoring_rule_templates(
        self,
        *,
        project_id: int,
        agent_description: str,
        user_requirement: str,
        rule_note: str,
        dimensions: list[str],
        with_reference: bool,
        count: int,
        model_name: str | None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        keyword_hints = self._extract_agent_keyword_hints(agent_description, user_requirement, rule_note)
        prompt = (
            "你是智能体评价规则生成器。请根据智能体描述与用户要求生成评分规则，并仅输出 JSON。\n"
            "输出格式（严格 JSON，不要 markdown，不要解释）:\n"
            "{\n"
            '  "rules":[\n'
            "    {\n"
            '      "name":"规则名",\n'
            '      "description":"规则描述",\n'
            '      "match_type":"llm_judge",\n'
            '      "threshold":0.8,\n'
            '      "judge_prompt":"评估提示词",\n'
            '      "dimensions":[{"name":"correctness","weight":0.5,"description":"准确性"}]\n'
            "    }\n"
            "  ]\n"
            "}\n"
            "要求：\n"
            "1) rules 数量必须是 3 到 5 条，并且与 count 一致；\n"
            "2) 每条规则都要给出可执行的 dimensions（至少 1 个维度）；\n"
            "3) 每条规则内 dimensions.weight 总和必须严格等于 1；\n"
            "4) 维度权重需保留 2~4 位小数；\n"
            "5) match_type 仅允许 exact_match/json_match/llm_judge/rule_based；\n"
            "6) 规则与维度必须直接映射智能体职责，维度名要体现能力关键词；\n"
            "7) 禁止只输出 correctness/completeness/format_compliance 等通用维度，除非描述中明确要求；\n"
            "8) 每个维度权重必须 > 0，禁止出现 0。"
        )
        user_input = {
            "agent_description": agent_description,
            "user_requirement": user_requirement,
            "rule_note": rule_note,
            "with_reference": with_reference,
            "dimensions_hint": dimensions,
            "ability_keyword_hints": keyword_hints,
            "count": count,
            "count_range": "3-5",
        }

        llm_config: dict[str, Any] = {
            "temperature": 0.2,
        }
        if model_name:
            llm_config["model"] = model_name

        try:
            llm_result = self.model_gateway_client.complete(
                project_id=project_id,
                prompt=prompt,
                user_input=user_input,
                context={"task": "agent_scoring_rule_generation"},
                config=llm_config,
            )
            templates = self._coerce_scoring_rule_templates(llm_result.get("parsed_output"), llm_result.get("raw_output"))
            if templates:
                normalized_templates = templates[:count]
                if len(normalized_templates) < count:
                    fallback_templates = self._build_scoring_rule_fallbacks(
                        count=count,
                        with_reference=with_reference,
                        dimensions=dimensions,
                        user_requirement=user_requirement,
                        rule_note=rule_note,
                    )
                    normalized_templates.extend(fallback_templates[len(normalized_templates) : count])
                return normalized_templates, {
                    "mode": "llm",
                    "model": llm_result.get("model_name") or model_name or RULE_GEN_DEFAULT_MODEL,
                }
            return self._build_scoring_rule_fallbacks(
                count=count,
                with_reference=with_reference,
                dimensions=dimensions,
                user_requirement=user_requirement,
                rule_note=rule_note,
            ), {
                "mode": "fallback",
                "model": llm_result.get("model_name") or model_name or RULE_GEN_DEFAULT_MODEL,
                "llm_error": "llm output is not a valid scoring-rule json",
            }
        except Exception as exc:  # noqa: BLE001
            return self._build_scoring_rule_fallbacks(
                count=count,
                with_reference=with_reference,
                dimensions=dimensions,
                user_requirement=user_requirement,
                rule_note=rule_note,
            ), {
                "mode": "fallback",
                "model": model_name or RULE_GEN_DEFAULT_MODEL,
                "llm_error": str(exc),
            }

    @staticmethod
    def _coerce_scoring_rule_templates(parsed_output: Any, raw_output: Any) -> list[dict[str, Any]]:
        if isinstance(parsed_output, list):
            return [item for item in parsed_output if isinstance(item, dict)]
        if isinstance(parsed_output, dict):
            rules = parsed_output.get("rules")
            if not isinstance(rules, list):
                rules = parsed_output.get("items")
            if isinstance(rules, list):
                return [item for item in rules if isinstance(item, dict)]
            return []
        if isinstance(raw_output, str):
            parsed = RuleService._extract_json_object(raw_output)
            if parsed is None:
                return []
            return RuleService._coerce_scoring_rule_templates(parsed, parsed)
        return []

    @staticmethod
    def _extract_json_object(raw_text: str) -> dict[str, Any] | None:
        text = raw_text.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                snippet = text[start : end + 1]
                try:
                    parsed = json.loads(snippet)
                    return parsed if isinstance(parsed, dict) else None
                except json.JSONDecodeError:
                    return None
        return None

    def _build_scoring_rule_fallbacks(
        self,
        *,
        count: int,
        with_reference: bool,
        dimensions: list[str],
        user_requirement: str,
        rule_note: str,
    ) -> list[dict[str, Any]]:
        fallback_dimensions = dimensions or ["correctness", "completeness", "format_compliance"]
        requirement_text = user_requirement or rule_note or "根据智能体描述进行质量评分"
        rows: list[dict[str, Any]] = []
        for index in range(count):
            rows.append(
                {
                    "name": f"智能体评价规则{index + 1}",
                    "description": requirement_text,
                    "match_type": "json_match" if with_reference and index == 0 else "llm_judge",
                    "threshold": 0.8,
                    "judge_prompt": "请按照维度打分并返回 JSON 结构结果。",
                    "dimensions": [
                        {
                            "name": dim,
                            "weight": round(1 / max(1, len(fallback_dimensions)), 4),
                            "description": f"{dim} 维度评分",
                        }
                        for dim in fallback_dimensions
                    ],
                }
            )
        return rows

    def _normalize_scoring_rule_record(
        self,
        *,
        template: dict[str, Any],
        index: int,
        with_reference: bool,
        user_requirement: str,
        rule_note: str,
        dimension_hints: list[str],
    ) -> dict[str, Any]:
        raw_name = template.get("name")
        if not isinstance(raw_name, str) or not raw_name.strip():
            name = f"智能体评价规则{index}"
        else:
            name = raw_name.strip()[:255]

        description = str(template.get("description") or user_requirement or rule_note or "自动生成的智能体评价规则").strip()

        match_type = self._normalize_match_type(template.get("match_type"), with_reference=with_reference, index=index)
        threshold = self._normalize_threshold(template.get("threshold"))
        judge_prompt = str(template.get("judge_prompt") or "").strip()
        dimensions = self._normalize_dimensions_positive(self._normalize_dimensions(template.get("dimensions"), dimension_hints))
        if not dimensions:
            dimensions = self._normalize_dimensions_positive(
                self._normalize_dimensions(None, dimension_hints or ["correctness", "completeness", "format_compliance"])
            )

        content: dict[str, Any] = {
            "evaluation_mode": "with_reference" if with_reference else "without_reference",
            "use_reference": with_reference,
            "match_type": match_type,
            "threshold": threshold,
            "dimensions": dimensions,
        }
        if judge_prompt:
            content["judge_prompt"] = judge_prompt
        if match_type == "rule_based" and isinstance(template.get("rules"), list):
            content["rules"] = template.get("rules")
        if template.get("rubric") is not None:
            content["rubric"] = template.get("rubric")

        return {
            "name": name,
            "description": description,
            "content": content,
        }

    @staticmethod
    def _normalize_match_type(value: Any, *, with_reference: bool, index: int) -> str:
        if isinstance(value, str):
            normalized = value.strip()
            if normalized in {"exact_match", "json_match", "llm_judge", "rule_based"}:
                return normalized
        return "json_match" if with_reference and index == 1 else "llm_judge"

    @staticmethod
    def _normalize_threshold(value: Any) -> float:
        try:
            threshold = float(value)
        except (TypeError, ValueError):
            threshold = 0.8
        return round(max(0.0, min(1.0, threshold)), 4)

    def _normalize_dimensions(self, raw_dimensions: Any, dimension_hints: list[str]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        if isinstance(raw_dimensions, list):
            for item in raw_dimensions:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                if not isinstance(name, str) or not name.strip():
                    continue
                description = item.get("description")
                rows.append(
                    {
                        "name": name.strip(),
                        "weight": self._normalize_threshold(item.get("weight")) or 0.0,
                        "description": description.strip() if isinstance(description, str) else f"{name.strip()} 维度评分",
                    }
                )

        if not rows and dimension_hints:
            rows = [{"name": dim, "weight": 0.0, "description": f"{dim} 维度评分"} for dim in dimension_hints]

        if not rows:
            return []

        positive_weights = [float(row["weight"]) for row in rows if float(row["weight"]) > 0]
        if not positive_weights:
            equal_weight = round(1 / len(rows), 4)
            for row in rows:
                row["weight"] = equal_weight
        else:
            total = sum(float(row["weight"]) for row in rows if float(row["weight"]) > 0)
            if total <= 0:
                equal_weight = round(1 / len(rows), 4)
                for row in rows:
                    row["weight"] = equal_weight
            else:
                for row in rows:
                    weight = float(row["weight"])
                    row["weight"] = round((weight / total) if weight > 0 else 0.0, 4)
                drift = round(1.0 - sum(float(row["weight"]) for row in rows), 4)
                if rows:
                    rows[0]["weight"] = round(float(rows[0]["weight"]) + drift, 4)
        return rows

    def _normalize_dimensions_positive(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not rows:
            return []
        cleaned: list[dict[str, Any]] = []
        for row in rows:
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            cleaned.append(
                {
                    "name": name,
                    "weight": float(row.get("weight") or 0.0),
                    "description": str(row.get("description") or f"{name} 维度评分").strip(),
                }
            )
        if not cleaned:
            return []

        any_non_positive = any(float(item["weight"]) <= 0 for item in cleaned)
        if any_non_positive:
            even_weight = round(1 / len(cleaned), 4)
            for item in cleaned:
                item["weight"] = even_weight
            drift = round(1.0 - sum(float(item["weight"]) for item in cleaned), 4)
            cleaned[0]["weight"] = round(float(cleaned[0]["weight"]) + drift, 4)
            return cleaned

        total = sum(float(item["weight"]) for item in cleaned)
        if total <= 0:
            even_weight = round(1 / len(cleaned), 4)
            for item in cleaned:
                item["weight"] = even_weight
            drift = round(1.0 - sum(float(item["weight"]) for item in cleaned), 4)
            cleaned[0]["weight"] = round(float(cleaned[0]["weight"]) + drift, 4)
            return cleaned

        for item in cleaned:
            item["weight"] = round(float(item["weight"]) / total, 4)
        drift = round(1.0 - sum(float(item["weight"]) for item in cleaned), 4)
        cleaned[0]["weight"] = round(float(cleaned[0]["weight"]) + drift, 4)
        min_positive = 0.01
        if any(float(item["weight"]) <= 0 for item in cleaned):
            for item in cleaned:
                item["weight"] = max(min_positive, float(item["weight"]))
            total = sum(float(item["weight"]) for item in cleaned)
            for item in cleaned:
                item["weight"] = round(float(item["weight"]) / total, 4)
            drift = round(1.0 - sum(float(item["weight"]) for item in cleaned), 4)
            cleaned[0]["weight"] = round(float(cleaned[0]["weight"]) + drift, 4)
        if cleaned[0]["weight"] <= 0:
            even_weight = round(1 / len(cleaned), 4)
            for item in cleaned:
                item["weight"] = even_weight
            drift = round(1.0 - sum(float(item["weight"]) for item in cleaned), 4)
            cleaned[0]["weight"] = round(float(cleaned[0]["weight"]) + drift, 4)
        return cleaned

    def _enforce_agent_dimension_relevance(
        self,
        rows: list[dict[str, Any]],
        keyword_hints: list[str],
        target_count: int,
    ) -> list[dict[str, Any]]:
        if not rows:
            return rows
        if not keyword_hints:
            return rows

        required_relevant = max(1, min(2, len(rows)))
        current_relevant = sum(0 if self._is_generic_dimension_name(str(row.get("name") or "")) else 1 for row in rows)
        if current_relevant >= required_relevant:
            return rows

        replacement_pool = [hint for hint in keyword_hints if hint and hint.strip()]
        if not replacement_pool:
            return rows

        existing_names = {str(row.get("name") or "").strip() for row in rows}
        new_rows: list[dict[str, Any]] = []
        need_replace = required_relevant - current_relevant

        for row in rows:
            name = str(row.get("name") or "").strip()
            if need_replace > 0 and self._is_generic_dimension_name(name):
                replacement_name = ""
                while replacement_pool:
                    candidate = replacement_pool.pop(0).strip()
                    if candidate and candidate not in existing_names:
                        replacement_name = candidate
                        break
                if replacement_name:
                    updated = {
                        "name": replacement_name,
                        "weight": float(row.get("weight") or 0.0),
                        "description": f"{replacement_name} 维度评分",
                    }
                    new_rows.append(updated)
                    existing_names.add(replacement_name)
                    need_replace -= 1
                    continue
            new_rows.append(row)

        if need_replace > 0:
            for hint in keyword_hints:
                candidate = hint.strip()
                if not candidate or candidate in existing_names:
                    continue
                new_rows.append({"name": candidate, "weight": 0.0, "description": f"{candidate} 维度评分"})
                existing_names.add(candidate)
                need_replace -= 1
                if need_replace <= 0 or len(new_rows) >= max(6, min(8, target_count)):
                    break

        if len(new_rows) > max(6, min(8, target_count)):
            new_rows = new_rows[: max(6, min(8, target_count))]
        return new_rows

    @staticmethod
    def _is_generic_dimension_name(name: str) -> bool:
        value = (name or "").strip().lower()
        if not value:
            return True
        generic_tokens = {
            "correctness",
            "completeness",
            "format_compliance",
            "format",
            "clarity",
            "helpfulness",
            "accuracy",
            "quality",
            "可读性",
            "准确性",
            "完整性",
            "格式符合性",
            "格式合规性",
            "格式",
            "清晰度",
            "帮助性",
        }
        return value in generic_tokens

    @staticmethod
    def _normalize_dimension_hints(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        result: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            normalized = item.strip()
            if not normalized:
                continue
            if normalized not in result:
                result.append(normalized)
        return result

    @staticmethod
    def _extract_agent_keyword_hints(agent_description: str, user_requirement: str, rule_note: str) -> list[str]:
        text = f"{agent_description}\n{user_requirement}\n{rule_note}"
        keyword_map = [
            ("倾听", "主动倾听能力"),
            ("聆听", "主动倾听能力"),
            ("情绪", "情绪支持有效性"),
            ("安抚", "情绪安抚能力"),
            ("陪伴", "持续陪伴连贯性"),
            ("对话", "多轮对话连贯性"),
            ("沟通", "沟通自然度"),
            ("共情", "共情表达能力"),
            ("理解", "意图理解准确性"),
            ("回复", "回复有效性"),
            ("温暖", "语言温度与关怀"),
            ("安全", "安全边界遵守"),
            ("准确", "信息准确性"),
            ("完整", "信息覆盖完整性"),
            ("格式", "输出格式符合性"),
        ]
        hints: list[str] = []
        for trigger, label in keyword_map:
            if trigger in text and label not in hints:
                hints.append(label)
        for name in ["意图理解准确性", "情绪支持有效性", "持续陪伴连贯性"]:
            if name not in hints:
                hints.append(name)
            if len(hints) >= 6:
                break
        return hints[:6]
