import { ChevronDown, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ConfigDisclosureSummary({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return <summary><Icon size={18} aria-hidden="true"/><span>{children}</span><ChevronDown className="config-disclosure__chevron" size={18} aria-hidden="true"/></summary>;
}
