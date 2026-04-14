import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", {
  variants: {
    variant: {
      default: "border-transparent bg-primary/12 text-primary",
      outline: "border-border bg-white text-foreground",
      success: "border-emerald-200 bg-emerald-50 text-emerald-700",
      error: "border-red-200 bg-red-50 text-red-700",
      running: "border-blue-200 bg-blue-50 text-blue-700",
      queued: "border-zinc-200 bg-zinc-100 text-zinc-600",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
