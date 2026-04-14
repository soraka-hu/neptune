# Suite & Dashboard Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add full-page image export for Project Dashboard and Suite Analytics, and add detailed AI-generated markdown export for Suite Analytics.

**Architecture:** Implement a new backend report export endpoint for suite markdown using the existing model gateway with fallback text generation. Add frontend export actions that capture the whole report page DOM as PNG and download AI-generated markdown content as `.md`.

**Tech Stack:** FastAPI, Python service layer, React + TypeScript, `html-to-image`, existing report service APIs.

---

### Task 1: Backend API contract for Suite markdown export

**Files:**
- Modify: `backend/app/api/report_api.py`
- Modify: `backend/app/application/report_service.py`
- Test: `backend/tests/api/test_report_endpoints.py`

**Step 1: Write failing API test**

- Add test for `POST /api/reports/suite/{suite_id}/export-markdown` asserting:
  - `suiteId`, `suiteName`, `fileName`, `markdownContent`, `summaryMode`, `model`
  - markdown includes key heading text

**Step 2: Run failing test**

Run: `cd backend && pytest tests/api/test_report_endpoints.py::test_export_suite_markdown_report -v`

Expected: FAIL (endpoint missing).

**Step 3: Add endpoint + service method**

- Add API route in `report_api.py`.
- Add service method in `report_service.py`:
  - build suite report context
  - call `ModelGatewayClient.complete()` for detailed markdown
  - fallback to deterministic markdown when model fails

**Step 4: Re-run tests**

Run: `cd backend && pytest tests/api/test_report_endpoints.py -v`

Expected: PASS.

### Task 2: Frontend report service support for markdown export

**Files:**
- Modify: `frontend/src/services/reportService.ts`

**Step 1: Add typed response model**

- Add `SuiteMarkdownExport` type.

**Step 2: Add API function**

- Add `exportSuiteMarkdownReport(suiteId: number)` wrapper.

**Step 3: Build check**

Run: `cd frontend && npm run build`

Expected: type checks pass.

### Task 3: Shared frontend export utilities

**Files:**
- Create: `frontend/src/pages/reports/reportExport.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

**Step 1: Add dependency**

- Install `html-to-image`.

**Step 2: Implement utility helpers**

- `exportElementAsPng(element, filename)` for full-page capture.
- `downloadMarkdown(filename, content)` helper.
- filename token sanitizer.

**Step 3: Build check**

Run: `cd frontend && npm run build`

Expected: build succeeds.

### Task 4: Project Dashboard full-page image export

**Files:**
- Modify: `frontend/src/pages/reports/ProjectDashboardPage.tsx`
- Modify: `frontend/src/pages/reports/ProjectDashboardPage.css`

**Step 1: Add page ref and action handler**

- Capture the full report section DOM.
- Export using current filters in file name.

**Step 2: Add toolbar button**

- Add `导出整页图片` button next to refresh.

**Step 3: UX error handling**

- Surface export success/error via `FloatingNotice`.

### Task 5: Suite Analytics full-page image + markdown export

**Files:**
- Modify: `frontend/src/pages/reports/SuiteAnalyticsPage.tsx`
- Modify: `frontend/src/pages/reports/SuiteAnalyticsPage.css`

**Step 1: Add page ref and image export handler**

- Export full suite report page as PNG.

**Step 2: Add markdown export handler**

- Call backend markdown endpoint.
- Download `.md` locally.

**Step 3: Add action buttons and loading states**

- `导出整页图片`
- `导出MD测试报告`
- Keep existing refresh action.

### Task 6: Validation and regression checks

**Files:**
- N/A (commands)

**Step 1: Run focused backend tests**

Run: `cd backend && pytest tests/api/test_report_endpoints.py -v`

**Step 2: Run frontend build**

Run: `cd frontend && npm run build`

**Step 3: Sanity review**

- Confirm export buttons appear in both pages.
- Confirm full-page image export behavior.
- Confirm suite markdown uses model summary with fallback.
