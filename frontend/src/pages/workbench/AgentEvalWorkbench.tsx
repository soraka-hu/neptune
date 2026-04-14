const dimensions = [
  { name: "Correctness", hint: "答案是否准确贴近标准" },
  { name: "Completeness", hint: "是否覆盖关键要求与上下文" },
  { name: "Format", hint: "输出是否符合格式与约束" }
];

const steps = [
  "配置 Agent 信息",
  "绑定待测 API",
  "选择 / 生成数据集",
  "选择评分模式",
  "选择评分规则 / 标准答案",
  "发起评测",
  "查看报告与维度分"
];

export function AgentEvalWorkbench() {
  return (
    <section>
      <header style={{ display: "grid", gap: 10, marginBottom: 24 }}>
        <span
          style={{
            width: "fit-content",
            padding: "6px 10px",
            borderRadius: 999,
            background: "rgba(34,110,104,0.12)",
            color: "#1f6a63",
            fontSize: 12,
            letterSpacing: "0.12em",
            textTransform: "uppercase"
          }}
        >
          Agent Flow
        </span>
        <h2
          style={{
            margin: 0,
                        fontSize: 42,
            lineHeight: 1
          }}
        >
          用数据集、规则和 Judge 把开放式输出拉回可比较区间
        </h2>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18
        }}
      >
        <div
          style={{
            borderRadius: 24,
            padding: 22,
            background: "rgba(255,255,255,0.7)",
            border: "1px solid rgba(31,37,39,0.08)"
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>评测流程</div>
          <div style={{ display: "grid", gap: 12 }}>
            {steps.map((step, index) => (
              <div
                key={step}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 14px",
                  borderRadius: 16,
                  background: index === 3 ? "rgba(34,110,104,0.14)" : "rgba(31,37,39,0.04)"
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 12,
                    display: "grid",
                    placeItems: "center",
                    background: "#1f2527",
                    color: "#fff8eb",
                    fontWeight: 700
                  }}
                >
                  {index + 1}
                </div>
                <div style={{ fontWeight: 600 }}>{step}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          <div
            style={{
              borderRadius: 24,
              padding: 22,
              background: "#102b31",
              color: "#eef8f6"
            }}
          >
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.68 }}>
              Scoreboard
            </div>
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              {dimensions.map((dimension) => (
                <div
                  key={dimension.name}
                  style={{
                    padding: "12px 14px",
                    borderRadius: 16,
                    background: "rgba(255,255,255,0.08)"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <strong>{dimension.name}</strong>
                    <span>0.86</span>
                  </div>
                  <div style={{ marginTop: 6, color: "rgba(238,248,246,0.72)", lineHeight: 1.6 }}>
                    {dimension.hint}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              borderRadius: 24,
              padding: 22,
              background: "linear-gradient(135deg, rgba(16,43,49,0.08), rgba(34,110,104,0.14))",
              border: "1px solid rgba(31,37,39,0.08)"
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700 }}>当前建议</div>
            <div style={{ marginTop: 10, lineHeight: 1.8, color: "#465153" }}>
              先用 `with_reference + llm_judge` 跑一轮稳定基线，再叠加 `rule_based` 做格式和必含项兜底。
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
