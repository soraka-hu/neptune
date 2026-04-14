import { render, screen } from "@testing-library/react";

import App from "../../src/App";

it("renders new report navigation and hides workbench entries", () => {
  render(<App />);

  expect(screen.queryByText("API 测试工作台")).not.toBeInTheDocument();
  expect(screen.queryByText("Agent 评测工作台")).not.toBeInTheDocument();
  expect(screen.getByText("项目看板")).toBeInTheDocument();
  expect(screen.getByText("Suite分析")).toBeInTheDocument();
  expect(screen.getByText("对比分析")).toBeInTheDocument();
});
