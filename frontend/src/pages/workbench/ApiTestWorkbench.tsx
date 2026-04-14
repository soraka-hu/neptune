const flow = [
  "选择项目",
  "选择接口 / 导入 API 文档",
  "填写 PRD / 功能点",
  "生成候选用例",
  "审核入库",
  "选择环境",
  "发起测试",
  "查看报告"
];

export function ApiTestWorkbench() {
  return (
    <section>
      <header style={{ display: "grid", gap: 10, marginBottom: 24 }}>
        <span
          style={{
            width: "fit-content",
            padding: "6px 10px",
            borderRadius: 999,
            background: "rgba(191,93,54,0.12)",
            color: "#8c3f20",
            fontSize: 12,
            letterSpacing: "0.12em",
            textTransform: "uppercase"
          }}
        >
          API Flow
        </span>
        <h2
          style={{
            margin: 0,
                        fontSize: 42,
            lineHeight: 1
          }}
        >
          把接口测试从文档推演到报告闭环
        </h2>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.3fr 0.9fr",
          gap: 18
        }}
      >
        <div
          style={{
            borderRadius: 24,
            padding: 22,
            background: "rgba(255,255,255,0.68)",
            border: "1px solid rgba(31,37,39,0.08)"
          }}
        >
          <div style={{ display: "grid", gap: 14 }}>
            {flow.map((step, index) => (
              <div
                key={step}
                style={{
                  display: "grid",
                  gridTemplateColumns: "64px 1fr",
                  gap: 14,
                  alignItems: "center",
                  padding: "14px 16px",
                  borderRadius: 18,
                  background: index === 3 ? "rgba(191,93,54,0.14)" : "rgba(31,37,39,0.04)"
                }}
              >
                <div
                  style={{
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 16,
                    minHeight: 54,
                    background: index === 3 ? "#bf5d36" : "#1f2527",
                    color: "#fff8eb",
                    fontWeight: 800,
                    fontSize: 22
                  }}
                >
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{step}</div>
                  <div style={{ marginTop: 4, color: "#667072" }}>
                    {index === 3
                      ? "结合 API 描述与 PRD 自动扩展边界场景。"
                      : "这一阶段保留人工确认点，避免生成资产直接入库。"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          <div
            style={{
              borderRadius: 24,
              padding: 22,
              background: "#1f2527",
              color: "#fff8eb"
            }}
          >
            <div style={{ fontSize: 12, letterSpacing: "0.15em", textTransform: "uppercase", opacity: 0.7 }}>
              Suggested Run
            </div>
            <div style={{ marginTop: 10, fontSize: 28, fontWeight: 800 }}>Regression Smoke</div>
            <div style={{ marginTop: 12, lineHeight: 1.7, color: "rgba(255,248,235,0.76)" }}>
              面向订单创建接口的一组快速回归模板，默认挂载测试环境与结构化断言。
            </div>
          </div>

          <div
            style={{
              borderRadius: 24,
              padding: 22,
              background: "linear-gradient(135deg, rgba(34,110,104,0.14), rgba(191,93,54,0.14))",
              border: "1px solid rgba(31,37,39,0.08)"
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700 }}>本页重点</div>
            <ul style={{ paddingLeft: 18, margin: "12px 0 0", lineHeight: 1.8, color: "#465153" }}>
              <li>候选用例生成与审核分离</li>
              <li>环境切换与一次发起执行</li>
              <li>回归结果直接跳到报告中心</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
