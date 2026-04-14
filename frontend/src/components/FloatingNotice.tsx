import { useEffect, useRef, type ComponentType } from "react";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { cn } from "../lib/utils";

export type NoticeTone = "success" | "error" | "info";

type NoticeState = {
  tone: NoticeTone;
  text: string;
};

type FloatingNoticeProps = {
  notice: NoticeState | null;
  onClose: () => void;
  autoHideMs?: number;
};

const toneMeta: Record<
  NoticeTone,
  { title: string; wrapper: string; icon: ComponentType<{ className?: string }> }
> = {
  success: {
    title: "成功",
    wrapper: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  error: {
    title: "失败",
    wrapper: "border-red-200 bg-red-50 text-red-700",
    icon: AlertCircle,
  },
  info: {
    title: "提示",
    wrapper: "border-blue-200 bg-blue-50 text-blue-700",
    icon: Info,
  },
};

export function FloatingNotice({ notice, onClose, autoHideMs = 3200 }: FloatingNoticeProps) {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const duration = notice.tone === "error" ? Math.max(autoHideMs, 5200) : autoHideMs;
    const timer = window.setTimeout(() => {
      onCloseRef.current();
    }, duration);
    return () => window.clearTimeout(timer);
  }, [notice, autoHideMs]);

  if (!notice) {
    return null;
  }

  const tone = toneMeta[notice.tone];
  const ToneIcon = tone.icon;

  return (
    <div
      aria-live={notice.tone === "error" ? "assertive" : "polite"}
      className="fixed right-4 top-4 z-[3200] w-[min(460px,calc(100vw-28px))]"
      role="status"
    >
      <div className={cn("grid grid-cols-[auto_1fr_auto] items-start gap-2.5 rounded-lg border p-2.5 shadow-soft", tone.wrapper)}>
        <ToneIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.08em]">{tone.title}</div>
          <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed">{notice.text}</div>
        </div>
        <button
          aria-label="关闭提示"
          className="rounded-md p-1 opacity-70 transition hover:bg-black/5 hover:opacity-100"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
