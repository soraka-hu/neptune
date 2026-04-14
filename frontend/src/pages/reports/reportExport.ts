import { toPng } from "html-to-image";

function sanitizeToken(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildExportFileName(prefix: string, tokens: Array<string | number | null | undefined>, extension: string): string {
  const normalizedTokens = tokens
    .map((token) => (token === null || token === undefined ? "" : sanitizeToken(String(token))))
    .filter((token) => token.length > 0);
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const head = sanitizeToken(prefix) || "report";
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  return [head, ...normalizedTokens, stamp].join("-") + ext;
}

function triggerDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

function waitForPaint(frames = 2): Promise<void> {
  return new Promise((resolve) => {
    let remaining = Math.max(1, frames);
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export async function exportElementAsPng(element: HTMLElement, fileName: string): Promise<void> {
  const pixelRatio = 2;
  const width = Math.max(element.clientWidth, element.scrollWidth, 1);
  const shadowWrap = document.createElement("div");
  shadowWrap.style.position = "fixed";
  shadowWrap.style.left = "-100000px";
  shadowWrap.style.top = "0";
  shadowWrap.style.zIndex = "-1";
  shadowWrap.style.pointerEvents = "none";
  shadowWrap.style.background = "#ffffff";
  shadowWrap.style.width = `${width}px`;
  shadowWrap.style.maxHeight = "none";
  shadowWrap.style.overflow = "visible";

  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.width = `${width}px`;
  clone.style.height = "auto";
  clone.style.maxHeight = "none";
  clone.style.overflow = "visible";
  clone.style.overflowY = "visible";
  clone.style.overflowX = "visible";
  clone.classList.add("export-capture-root");

  // 导出时不需要悬浮提示，避免遮挡内容
  clone.querySelectorAll(".project-hover-tooltip").forEach((node) => node.remove());

  const forceFinalStyle = document.createElement("style");
  forceFinalStyle.textContent = `
.export-capture-root * {
  animation: none !important;
  transition: none !important;
}
.export-capture-root .project-trend-area {
  opacity: 1 !important;
}
.export-capture-root .project-trend-line {
  stroke-dashoffset: 0 !important;
}
.export-capture-root .project-trend-dot {
  opacity: 1 !important;
  transform: scale(1) !important;
}
.export-capture-root .project-trend-focus {
  opacity: 0.2 !important;
}
`;

  try {
    shadowWrap.appendChild(forceFinalStyle);
    shadowWrap.appendChild(clone);
    document.body.appendChild(shadowWrap);
    await waitForPaint(2);

    const height = Math.max(clone.scrollHeight, clone.clientHeight, clone.offsetHeight, 1);
    const dataUrl = await toPng(clone, {
      cacheBust: true,
      pixelRatio,
      backgroundColor: "#ffffff",
      width,
      height,
      canvasWidth: Math.round(width * pixelRatio),
      canvasHeight: Math.round(height * pixelRatio),
      style: {
        width: `${width}px`,
        height: `${height}px`,
        maxHeight: "none",
        overflow: "visible",
        overflowY: "visible",
        overflowX: "visible",
      },
    });
    triggerDownload(dataUrl, fileName);
  } finally {
    shadowWrap.remove();
  }
}

export function downloadMarkdownFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  triggerDownload(objectUrl, fileName);
  URL.revokeObjectURL(objectUrl);
}
