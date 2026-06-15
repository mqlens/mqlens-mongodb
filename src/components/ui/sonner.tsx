import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useThemeOptional } from "@/hooks/use-theme";

const Toaster = ({ ...props }: ToasterProps) => {
  const themeCtx = useThemeOptional();
  const resolvedMode =
    themeCtx?.resolvedMode ??
    (typeof document !== "undefined" &&
    document.documentElement.classList.contains("light")
      ? "light"
      : "dark");

  return (
    <Sonner
      theme={resolvedMode === "light" ? "light" : "dark"}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
