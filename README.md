<p align="center">
  <img src="docs/images/neptune-readme-header.png" alt="NEPTUNE" width="760" />
</p>
一个面向研发与测试团队的统一质量平台：
把 API 自动化测试和 Agent / LLM 评测放在同一套工作流里，形成从“准备资产”到“执行评估”再到“报告复盘”的闭环。

## 产品演示视频

<p align="center">
  <video src="docs/media/Demo.mp4" controls muted playsinline width="860"></video>
</p>

<p align="center">
  无法播放时可直接下载：<a href="docs/media/Demo.mp4">Demo.mp4</a>
</p>



## 快速开始（本地最小可用）

### 1) 环境准备

- Python `>=3.11`（推荐 3.12）
- Node.js + npm（建议使用当前 LTS；本仓库在 Node 25 环境验证）

### 2) 初始化项目

```bash
git clone <your-repo-url>
cd codex_project
bash scripts/bootstrap.sh
```

`bootstrap.sh` 会自动完成：

- 创建 `backend/.venv`
- 安装后端依赖（含 dev 依赖）
- 执行 Alembic 迁移（默认 SQLite）
- 安装前端依赖

### 3) 启动后端

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

### 4) 启动前端（新终端）

```bash
cd frontend
npm run dev
```

### 5) 访问入口

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`
- Health Check: `http://localhost:8000/api/health`
- OpenAPI Docs: `http://localhost:8000/docs`

## 可选：启动完整本地基础设施

如果你需要更接近生产的链路（PostgreSQL / Redis / MinIO / Prometheus）：

```bash
docker compose -f infra/docker-compose.yml up -d
```

默认端口：

- PostgreSQL: `5432`
- Redis: `6379`
- MinIO API: `9000`
- MinIO Console: `9001`
- Prometheus: `9090`

## 常用环境变量（后端）

### 基础配置

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 自动回退 SQLite | 未设置时使用 `backend/.runtime/unified_test_eval.sqlite3` |
| `RUN_DISPATCH_MODE` | `background` | `inline` / `background` / `async` |
| `RUN_SCHEDULER_ENABLED` | `true` | 是否启用定时调度线程 |
| `RUN_SCHEDULER_TIMEZONE` | `Asia/Shanghai` | 调度时区 |
| `RUN_SCHEDULER_POLL_SECONDS` | `15` | 调度轮询周期（秒） |
| `RUN_SCHEDULER_BATCH_SIZE` | `20` | 每轮调度批次大小 |

### 可选能力配置

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `CELERY_BROKER_URL` | `redis://localhost:6379/0` | Celery Broker |
| `CELERY_RESULT_BACKEND` | 同 `CELERY_BROKER_URL` | Celery 结果后端 |
| `CASE_GEN_BASE_URL` | `https://codingplan.alayanew.com/v1` | 用例生成模型网关地址 |
| `CASE_GEN_MODEL` | `kimi-k2.5` | 用例生成模型 |
| `CASE_GEN_API_KEY` | 空 | 用例生成 API Key |
| `LOCAL_REPORT_SCREENSHOT_ENABLED` | `true` | 报告导出时启用本地截图 |
| `LOCAL_REPORT_WEB_BASE_URL` | `http://localhost:5173` | 报告截图页面基准地址 |

## 测试与质量校验

后端：

```bash
cd backend
source .venv/bin/activate
pytest -q
```

前端：

```bash
cd frontend
npm test
```

## 常见开发任务

1. 初始化数据库迁移

```bash
cd backend
source .venv/bin/activate
alembic upgrade head
```

2. 构建前端产物

```bash
cd frontend
npm run build
```

## 常见问题（FAQ）

1. 后端起不来，提示数据库连接失败
- 先确认是否配置了 `DATABASE_URL`
- 如果只想本地快速验证，可以取消该变量并使用默认 SQLite

2. 定时任务没有触发
- 确认 `RUN_SCHEDULER_ENABLED` 不是 `false/0/off/no`
- 检查 `RUN_SCHEDULER_TIMEZONE` 是否符合预期

## 贡献建议
- Issue 建议包含：背景、复现步骤、预期行为、实际行为
- MR 建议包含：变更动机、方案说明、验证结果
- 合并前建议通过后端与前端测试

## License

本项目采用 MIT License，详见 [LICENSE](LICENSE)。
