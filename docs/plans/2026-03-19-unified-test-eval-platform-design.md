# 统一测试与评测平台架构设计（v1）

日期：2026-03-19  
状态：Draft  
作者：Codex（基于你提供的 17 张核心表草案）

## 1. 目标与范围

平台统一支持以下能力，并共用同一对象模型：

- 传统 API 自动化测试
- Agent / LLM 评测
- 数据集生成与管理
- 规则管理
- 执行编排
- 报告与追踪

本版设计重点覆盖：

- 领域模型与服务边界
- 运行态与资产态解耦
- 数据库主导、YAML 执行视图
- 异步执行链路
- 可插拔评分框架
- 全链路可追溯

## 2. 设计原则（冻结）

1. 统一对象模型：`Project / Suite / Case / Run / Report` 贯穿 API 测试与 Agent 评测。  
2. 执行与资产解耦：`Case/Rule/Dataset/Evaluator` 属于资产；`Run/RunItem/RunLog` 属于运行态。  
3. 数据库为主，YAML 为执行视图：YAML 仅为 runner 可消费的临时视图，不是真相源。  
4. 异步任务化：前端提交任务，后端排队，worker 执行并回传状态。  
5. 评分可插拔：`exact match / json diff / rule engine / llm judge / custom` 统一接入。  
6. 全链路可追溯：报告可回溯到用例版本、规则版本、模型版本、环境版本、提示词版本。

### 2.1 已确认约束（v1）

- 部署模型：**单租户**（暂不引入 `tenant_id` 体系）
- 数据隔离：以 `project_id` 作为一级隔离边界
- 模型接入：**强制统一模型网关**（业务服务与 worker 禁止直连模型厂商）
- 报告能力：v1 聚焦可追溯，**一键回放能力放到 v2**
- 资产写入：`case_item` **仅允许通过 JSON Schema 校验后入库**
- 升级路径：v2 再评估多租户（逻辑租户或物理库隔离）

## 3. 技术落地路径对比（3 选 1）

### 路径 A：单体模块化（Modular Monolith）

特点：

- 单进程内按域分模块（asset/run/eval/report）
- 低运维复杂度，上线快
- 强一致事务最容易实现

风险：

- 随业务增长，执行链路与资产管理耦合加深
- Agent 评测吞吐上来后扩展性受限

适用：

- 团队 < 8 人，目标 1-2 个月上线 MVP。

### 路径 B：全微服务（Fully Distributed）

特点：

- 资产、编排、评测、生成、报告全部独立服务
- 扩展与弹性最好，边界清晰

风险：

- 分布式事务、链路追踪、幂等治理成本高
- 前期开发与运维复杂度明显偏高

适用：

- 已有成熟平台团队与 DevOps 体系。

### 路径 C：分层解耦混合架构（推荐）

特点：

- 资产域（Asset）与运行域（Run+Eval）分离
- 通过队列与事件总线连接，执行面独立扩缩
- 评分器、Runner、Judge 走插件适配层

优势：

- 兼顾上线速度与中期可扩展
- 最符合你当前的对象模型与 17 张表结构

**推荐结论：采用路径 C。**

## 4. 总体架构设计（推荐态）

### 4.1 服务边界

- API Gateway：鉴权、路由、限流、审计入口。
- Asset Service：`project/suite/case/rule/dataset/evaluator/prompt/environment` 的 CRUD 与版本发布。
- Run Service：任务编排、状态机、分片下发、重试、聚合。
- Eval Service：断言引擎、评分引擎、judge 适配。
- Gen Service：case/dataset/rule 的生成与增强。
- Report Service：汇总、对比、趋势报告。
- Worker Runtime：runner 执行器（API、Agent、workflow）+ evaluator 执行器。

### 4.2 存储与基础设施

- PostgreSQL：主数据、运行记录、版本快照。
- Redis：队列、任务锁、短期状态缓存。
- 对象存储（S3/MinIO）：原始输入输出、长日志、附件、报告文件。
- 监控日志：指标（Prometheus）+ 日志（ELK/OpenSearch）+ trace（OpenTelemetry）。

## 5. 统一对象模型与聚合边界

### 5.1 核心对象

- Project：业务隔离边界。
- Suite：用例/评测集合，支持多类型。
- CaseItem：最小可执行资产单元。
- Dataset / DatasetItem：批量评测输入集合。
- RuleDefinition：执行/断言/评分/生成规则。
- Evaluator：评分器定义与配置。
- RunRecord / RunItem：一次执行与其拆分项。
- ReportRecord：可展示结果资产。
- VersionSnapshot：关键资产版本历史。

### 5.2 聚合建议

- 资产聚合：`Suite <- CaseItem`，`Dataset <- DatasetItem`。
- 运行聚合：`RunRecord <- RunItem <- JudgeRecord`。
- 规则聚合：`RuleDefinition` 通过关系表绑定到 `Project/Suite`（后续建议支持绑定到 Case）。

## 6. 数据库设计审视与修订建议（基于你的 DDL）

你的 17 张表主体结构可直接作为 v1 基线，下面是建议补强项。

### 6.1 必补（P0）

1. 枚举约束化：将 `status/type` 字段补 `CHECK` 或字典表，避免脏值。  
2. 幂等键：`run_record` 增加 `idempotency_key`（唯一）用于重复提交保护。  
3. 一致性校验：保证 `run_record.project_id` 与 `suite/dataset/environment` 同属一个 project。  
4. 版本冻结：执行前将 case/rule/evaluator/prompt/environment 版本写入 `request_snapshot`。  
5. 大表索引：`run_item(run_id,status)`、`run_log(run_id,created_at)`、`judge_record(run_item_id,created_at)` 复合索引。  
6. 软删除策略：资产表建议加入 `deleted_at`，保留追溯可恢复能力。

### 6.2 强烈建议（P1）

1. 新增 `case_rule_rel`：支持 Case 级规则绑定，避免仅靠 Project/Suite 粒度。  
2. 新增 `suite_evaluator_rel` 或 `case_evaluator_rel`：显式声明评分流水线。  
3. 新增 `run_artifact`：存储日志文件、输入输出快照、截图、trace 文件 URL。  
4. 新增 `model_endpoint`（或模型配置表）：统一管理模型路由和版本策略。  
5. 运行数据分区：`run_log / judge_record` 按月分区以控制查询与归档成本。

### 6.3 字段级细节建议

- `run_record.source_id` 需配套 `source_type`，避免多态引用不清晰。  
- `run_item.error_info` 建议标准化结构：`code/message/retryable/stack`。  
- `judge_record.raw_response` 与 `token_usage` 建议分开冷热存储（热库 + 对象存储）。  
- `prompt_template` 建议加入 `template_engine`（jinja/mustache）与 `output_schema`。  
- `environment.secrets_ref` 保留引用，不存明文，并记录 `secret_version`。

### 6.4 `case_item` JSON 合同（v1）

你给的样例建议直接作为 v1 的标准协议，并增加 `schema_version` 以便兼容演进。

`case_item.input_payload`（API）：

```json
{
  "schema_version": "1.0",
  "method": "POST",
  "path": "/api/order/create",
  "headers": {
    "Content-Type": "application/json"
  },
  "query": {},
  "body": {
    "userId": 1001,
    "skuId": 2002,
    "count": 1
  },
  "context_vars": {
    "token": "${token}"
  }
}
```

`case_item.input_payload`（Agent）：

```json
{
  "schema_version": "1.0",
  "user_input": "帮我总结这段需求，输出三个要点",
  "conversation_history": [],
  "tools_context": [],
  "constraints": {
    "format": "bullet_list",
    "language": "zh"
  }
}
```

`case_item.expected_output`（with_reference）：

```json
{
  "schema_version": "1.0",
  "reference_answer": {
    "summary_points": [
      "要点1",
      "要点2",
      "要点3"
    ]
  },
  "must_include": ["要点1"],
  "format_requirements": {
    "type": "list",
    "count": 3
  }
}
```

`case_item.expected_output`（API）：

```json
{
  "schema_version": "1.0",
  "status_code": 200,
  "json_fields": {
    "code": 0,
    "message": "success"
  }
}
```

`case_item.eval_config`：

```json
{
  "schema_version": "1.0",
  "evaluation_mode": "with_reference",
  "evaluators": [
    {
      "type": "json_match",
      "weight": 0.4
    },
    {
      "type": "llm_judge",
      "weight": 0.6,
      "rubric_id": 12
    }
  ],
  "threshold": 0.8
}
```

### 6.5 `case_item` 合同建模方案对比（3 选 1）

方案 A：纯 JSONB 自由结构（最灵活）  
优点：迭代最快；缺点：字段漂移严重、治理成本高。

方案 B：按类型拆分子表（最强约束）  
优点：结构清晰、SQL 查询友好；缺点：演进成本高，跨类型统一困难。

方案 C：JSONB + Schema Registry（推荐）  
优点：保留灵活性，同时通过 JSON Schema 校验与版本控制约束结构；缺点：需要维护 schema 与校验器。

推荐结论：v1 采用 **方案 C**，在 Asset Service 写入/发布时做 JSON Schema 校验。

## 7. 核心链路设计

### 7.1 执行编排主流程

1. 前端提交执行请求（project + suite/dataset + environment + run_type）。  
2. Run Service 做参数校验与资源版本冻结，写 `run_record(pending)`。  
3. 生成 `run_item` 并投递队列（按并发策略分片）。  
4. Worker 拉取任务执行：调用 API 或 Agent；写入 `request/response/parsed_output`。  
5. Eval Service 执行断言与评分器链，必要时调用 Judge 模型并记录 `judge_record`。  
6. 回写 `run_item` 状态与分数；聚合更新 `run_record.progress/summary`。  
7. 生成 `report_record`，产出 summary/detailed/comparison/trend。

### 7.2 状态机

- `run_record.status` 建议值：`pending/queued/running/partially_success/success/failed/canceled/timeout`
- `run_item.status` 建议值：`pending/running/retrying/success/failed/skipped/canceled`

推荐主状态流转：

`pending -> queued -> running -> success|failed|canceled|timeout`

重试策略：

- 仅 `retryable=true` 的错误允许自动重试；
- 指数退避，最大重试次数由 `run_type + environment` 策略控制。

## 8. 可插拔评分架构

统一接口（逻辑层）：

- `prepare(context)`
- `evaluate(input, expected, actual, config)`
- `normalize(score_result)`

插件类型：

- `exact_match`
- `json_match/json_diff`
- `rule_based`
- `llm_judge`
- `custom_script`

组合策略：

- 串行流水线：先硬性断言后语义评分；
- 加权汇总：`final_score = Σ(weight_i * score_i)`；
- 失败短路：关键规则失败时直接判定不通过。

## 9. 可追溯设计（关键）

每个 `report_record` 必须能追溯到：

- `run_no`、执行时间窗、触发人/触发方式；
- case/suite/dataset/rule/evaluator/prompt/environment 的版本；
- 模型名、模型版本、温度、token、endpoint；
- runner 版本、镜像 hash、代码 commit SHA；
- 原始输入输出与 judge 原文（脱敏后可审计）。

追溯实现建议：

- 运行开始时生成 `trace_manifest`（写入 `run_record.request_snapshot` + 对象存储）；
- `version_snapshot` 对关键资产发布时强制落库；
- 报告渲染仅依赖快照，不直接读取最新资产。

## 10. YAML 执行视图策略

原则：YAML 仅为 Runner 消费的执行视图，不作为源数据。

机制：

- Run Service 在启动时把 DB 快照渲染为临时 YAML（含版本信息）；
- YAML 与 run_id 绑定并存档到对象存储；
- 回放和复现优先使用快照 YAML + request_snapshot。

## 11. 异常处理与稳定性

- API 幂等：提交执行接口要求 `idempotency_key`。  
- 消息幂等：worker 执行前加分布式锁（`run_item_id` 维度）。  
- 超时治理：run-item 级超时与 run 级总超时双层控制。  
- 失败隔离：judge 调用失败不影响原始响应落库；可标记为 `eval_partial_fail`。  
- 降级策略：模型网关不可用时可切换规则评分或重排重试。

## 12. 安全与权限

- 细粒度 RBAC：project/suite/case/dataset/run/report 分级权限。  
- 审计日志：所有变更写审计事件（人、时间、前后值、来源）。  
- 密钥治理：统一接 Secret Manager，DB 只存引用。  
- 数据脱敏：PII 字段在 `run_log/judge_record/raw_response` 侧脱敏后持久化。

## 13. 测试策略

- 单元测试：规则解析、评分插件、状态机迁移。  
- 集成测试：Run -> Worker -> Eval -> Report 全链路。  
- 回归测试：固定数据集 + 固定模型版本验证分数稳定性。  
- 压测：并发 run、长日志写入、judge 高频调用场景。  
- 可追溯测试：随机抽样报告，校验快照完整性与可回放性。

## 14. 本版设计结论

1. 你的 17 张核心表可以作为 v1 数据底座，方向正确。  
2. v1 已确认按“单租户 + project 级隔离”落地。  
3. 优先补 P0（约束、幂等、版本冻结、一致性、索引、软删除）。  
4. 第二阶段补 P1（Case 级规则绑定、评分流水线关系、artifact、模型配置、分区）。  
5. `case_item` 建议采用“JSONB + Schema Registry”治理策略。  
6. v1 模型调用强制走统一模型网关，回放能力延后到 v2。  
7. 先实现“可追溯闭环”，再扩高级生成能力，能显著降低后续返工风险。

## 15. 接口分层方案（确认版）

### 15.1 API 接口层

- 面向前端与外部系统调用。
- 负责鉴权、参数校验、幂等校验、响应包装。
- 不承载复杂业务规则，只做请求分发。

### 15.2 应用服务层（App Service）

- 负责用例级业务编排与事务边界控制。
- 负责编排多个领域服务与基础设施适配器。
- 负责将同步请求转为异步任务（创建任务记录并投递队列）。

### 15.3 领域服务层（Domain Service）

- 负责核心规则与领域一致性校验。
- 典型能力：版本冻结、规则匹配、评分聚合、状态机迁移。

### 15.4 基础设施层（Infrastructure）

- PostgreSQL / Redis / MQ / 对象存储 / LLM 网关 / Pytest Runner。
- 通过 Adapter/Port 接口暴露能力，避免上层直接依赖具体实现。

## 16. REST 接口模块设计（v1）

你给的 A-J 模块划分合理，建议在 v1 采用并补充统一规范。

### 16.1 模块清单（保持你给的边界）

- 项目管理：`/api/projects`
- Suite 管理：`/api/suites`
- 用例管理：`/api/cases`
- 规则管理：`/api/rules`
- 用例生成：`/api/case-generation/*`
- 数据集管理：`/api/datasets`
- 评测配置：`/api/evaluators`、`/api/scoring-rules/*`
- 执行管理：`/api/runs/*`
- 报告管理：`/api/reports/*`
- 环境管理：`/api/environments`

### 16.2 v1 接口规范补充（强烈建议）

1. 异步任务统一返回：
   - 统一返回 `taskId/runId + status + createdAt`
   - 长任务接口（生成、执行、导出）采用“创建任务 + 轮询查询”模式
2. 幂等键：
   - `POST /api/runs/*`、`POST /api/case-generation/*`、`POST /api/reports/*/export`
   - 要求请求头 `Idempotency-Key`
3. 分页规范：
   - 列表接口统一 `pageNo/pageSize/sortBy/sortOrder`
4. 过滤规范：
   - 列表查询支持 `projectId/status/type/tag/createdAtFrom/createdAtTo`
5. 版本并发控制：
   - 更新接口要求 `version`（乐观锁）
6. 软删除默认：
   - `DELETE` 语义默认归档（软删），高风险硬删走管理员接口

### 16.3 统一响应结构（建议）

```json
{
  "code": 0,
  "message": "success",
  "requestId": "req_xxx",
  "data": {}
}
```

错误响应：

```json
{
  "code": 4001001,
  "message": "invalid parameter: suiteId",
  "requestId": "req_xxx",
  "details": {}
}
```

## 17. 应用服务层映射（确认版）

你定义的 7 个应用服务和平台边界匹配，v1 建议按以下职责落地：

1. `ProjectAppService`
   - 项目 CRUD、归档、成员权限。
2. `AssetAppService`
   - Suite/Case/Dataset 资产管理与发布。
3. `RuleAppService`
   - 规则定义、绑定、版本管理与查询。
4. `GenerationAppService`
   - 用例生成任务、候选确认入库、评分规则自动生成。
5. `RunAppService`
   - Run 创建、RunItem 拆分、排队、取消、重试、进度聚合。
6. `EvaluationAppService`
   - assertion 执行、evaluator 链路执行、分数归一与汇总。
7. `ReportAppService`
   - summary/detail/compare/trend 报告生成与导出。

## 18. 执行链路（标准流水线）

通用执行主干固定为：

1. 接收执行请求并校验权限、参数、幂等键。
2. 创建 `run_record`（`pending`）并冻结资产版本快照。
3. 按 suite/dataset 拆分 `run_item`。
4. 将任务投递到队列，状态切换 `queued`。
5. Worker 拉取任务并装配上下文（环境变量、密钥引用、规则/evaluator）。
6. 执行器运行（pytest runner / agent executor）。
7. 落库原始输入输出与解析结果。
8. 调用 assertion + evaluator（必要时通过统一模型网关调用 judge LLM）。
9. 保存 `run_item` 评分与错误信息。
10. 聚合 `run_record.summary/progress`。
11. 生成 `report_record` 与报告产物。
12. 推送状态更新（WebSocket）或前端轮询读取。
13. 收尾归档（artifact、trace_manifest、审计日志）。

### 18.1 API 测试执行链路

`Case -> 渲染请求参数 -> 发起 HTTP 请求 -> 获取响应 -> 执行断言 -> 保存 assertion_result -> 汇总通过/失败`

落库关注点：

- `run_item.request_data`：渲染后的最终请求（脱敏）
- `run_item.response_data`：HTTP 响应体与状态码
- `run_item.assertion_result`：断言明细（通过/失败/原因）

### 18.2 Agent 评测执行链路

`DatasetItem/Case -> 组装用户输入 -> 调用 Agent API -> 获取输出 -> 标准答案比对或 Rule/Judge 评分 -> 保存 score_result -> 汇总总分/维度分`

落库关注点：

- `run_item.parsed_output`：结构化解析后的模型输出
- `run_item.score_result`：总分、阈值、维度分、通过态
- `judge_record`：仅在使用 LLMJudge 时记录提示词、模型、token、延迟

## 19. pytest 与 YAML 落法（确认版）

### 19.1 pytest 角色

- 执行引擎（运行 API/Agent 执行任务）
- HTTP 请求与断言执行
- fixture 与环境初始化
- 结果结构化回传（JSON）

### 19.2 YAML 角色

- 交换格式（导入/导出）
- 调试可读视图（排障、复现）
- runner 输入视图（临时渲染，不是主数据源）

### 19.3 反模式（明确不建议）

- 前端以 YAML 作为唯一编辑对象
- 平台主逻辑写死在 pytest 脚本中
- DB 与 YAML 双写且无同步机制

### 19.4 推荐做法（v1）

1. DB 存主数据（唯一真相源）。
2. Run 创建时渲染临时 YAML 或 pytest 参数文件。
3. pytest 只消费执行视图并回传 JSON 结果。
4. Run Service 持久化到 `run_item/assertion_result/score_result`。

## 20. 评分引擎设计（确认版）

### 20.1 统一接口

```text
evaluate(case_or_item, output, expected, evaluator_config) -> score_result
```

### 20.2 评分器类型

1. `ExactMatchEvaluator`
   - 适合分类、枚举值、简单文本全等。
2. `JsonMatchEvaluator`
   - 适合结构化 JSON 字段对比，可配置忽略字段顺序。
3. `RuleBasedEvaluator`
   - 适合长度限制、必含词、格式校验、工具调用结果校验。
4. `LLMJudgeEvaluator`
   - 适合开放式回答、多维度评分、无标准答案场景。
5. `CompositeEvaluator`
   - 适合多个 evaluator 加权合并。

### 20.3 `score_result` 标准结构（v1）

```json
{
  "total_score": 0.86,
  "passed": true,
  "threshold": 0.8,
  "dimensions": [
    {
      "name": "correctness",
      "score": 0.9,
      "weight": 0.5,
      "reason": "关键信息准确"
    },
    {
      "name": "completeness",
      "score": 0.8,
      "weight": 0.3,
      "reason": "覆盖大部分要求"
    },
    {
      "name": "format_compliance",
      "score": 0.85,
      "weight": 0.2,
      "reason": "输出结构符合要求"
    }
  ]
}
```

## 21. 前端页面结构建议（确认版）

### 21.1 一级菜单信息架构

1. 工作台：`API 测试工作台`、`Agent 评测工作台`
2. 资产中心：`项目/用例集/用例/数据集/环境/Prompt 模板`
3. 规则中心：`执行规则/断言规则/评分规则/生成规则`
4. 执行中心：`运行任务/运行明细/队列状态`
5. 报告中心：`测试报告/评测报告/对比分析/趋势分析`

### 21.2 两个关键工作流页面

API 测试工作台流程：

`选择项目 -> 选择接口或导入 API 文档 -> 填写 PRD/功能点 -> 生成候选用例 -> 审核入库 -> 选择环境 -> 发起测试 -> 查看报告`

Agent 评测工作台流程：

`配置 Agent 信息 -> 绑定待测 API -> 选择或生成数据集 -> 选择评分模式 -> 选择评分规则/标准答案 -> 发起评测 -> 查看报告与维度分`

## 22. 报告结构建议（三层）

### 22.1 Summary Report

展示内容：

- 总用例数
- 成功数与失败数
- 平均分
- 平均耗时
- 失败 Top 原因
- 模型/环境/规则版本

### 22.2 Detail Report

展示内容：

- 每个 `run_item` 的输入、输出、断言、score
- judge reason
- 日志
- 重试记录

### 22.3 Comparison Report

展示内容：

- 与上次 run 对比
- 分数变化
- 新失败用例
- 已修复用例
- 波动较大的 case

## 23. 技术选型建议（v1）

后端建议：

- `FastAPI + SQLAlchemy + Pydantic`（优先）
- 备选：`Django + DRF`

配套基础设施：

- 数据库：`PostgreSQL`
- 缓存与队列：`Redis`
- 任务调度：`Celery`（或轻量替代 `Dramatiq`）
- 执行引擎：`pytest`
- 对象存储：`MinIO / S3`
- 前端：`React + Ant Design`（企业中后台优先）
- 监控：`Prometheus + Grafana + Sentry + ELK/Loki`

## 24. 目录结构建议（FastAPI）

```text
app/
  api/
    project_api.py
    suite_api.py
    case_api.py
    rule_api.py
    dataset_api.py
    run_api.py
    report_api.py

  application/
    project_service.py
    asset_service.py
    rule_service.py
    generation_service.py
    run_service.py
    evaluation_service.py
    report_service.py

  domain/
    models/
    services/
    evaluators/
    runners/
    rules/

  infrastructure/
    db/
    repositories/
    mq/
    llm/
    storage/
    pytest_runner/
    logging/

  workers/
    generation_worker.py
    execution_worker.py
    judge_worker.py
    report_worker.py
```

## 25. 冻结决策清单（v1）

1. 单租户架构（`project_id` 为一级隔离边界）。
2. 模型调用强制走统一模型网关（禁止业务服务和 worker 直连模型厂商）。
3. 报告能力以“可追溯”为主，一键回放延后到 v2。
4. `case_item` 写入前必须通过 JSON Schema 校验（不通过则拒绝入库）。
