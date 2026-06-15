import * as React from "react";
import { cn } from "@/lib/utils";

function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "secondary" | "destructive" | "outline" | "success" | "warning";
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        {
          default: "border-transparent bg-primary text-primary-foreground",
          secondary: "border-transparent bg-secondary text-secondary-foreground",
          destructive: "border-transparent bg-destructive text-destructive-foreground",
          outline: "text-foreground",
          success: "border-transparent bg-success/15 text-success",
          warning: "border-transparent bg-warning/15 text-warning",
        }[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge };
