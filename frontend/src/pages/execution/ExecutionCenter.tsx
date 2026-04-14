export function ExecutionCenter() {
  return (
    <section>
      <h2 style={{ marginTop: 0, fontSize: 36 }}>
        执行中心
      </h2>
      <div
        style={{
          marginTop: 22,
          display: "grid",
          gridTemplateColumns: "1.2fr 0.8fr",
          gap: 16
        }}
      >
        <div
          style={{
            padding: 22,
            borderRadius: 24,
            background: "#1d2325",
            color: "#f8f3ea"
          }}
        >
          <div style={{ fontSize: 12, letterSpacing: "0.15em", textTransform: "uppercase", opacity: 0.7 }}>Queue State</div>
          <div style={{ marginTop: 10, fontSize: 28, fontWeight: 800 }}>
            {"pending -> queued -> running"}
          </div>
          <div style={{ marginTop: 12, color: "rgba(248,243,234,0.72)", lineHeight: 1.8 }}>
            Worker 分发、重试和失败隔离都在这里可视化，便于定位单个 run 与 run_item 的执行状态。
          </div>
        </div>
        <div
          style={{
            padding: 22,
            borderRadius: 24,
            background: "rgba(255,255,255,0.68)",
            border: "1px solid rgba(31,37,39,0.08)"
          }}
        >
          <div style={{ fontWeight: 700 }}>运行视图</div>
          <ul style={{ paddingLeft: 18, marginTop: 12, lineHeight: 1.8, color: "#617072" }}>
            <li>运行任务</li>
            <li>运行明细</li>
            <li>队列状态</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
