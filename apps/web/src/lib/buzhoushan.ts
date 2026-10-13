import { useSyncExternalStore } from "react";
import { useTheme } from "./theme";

const query = "(min-width: 901px)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia?.(query);
  media?.addEventListener?.("change", notify);
  return () => media?.removeEventListener?.("change", notify);
};
export function useBuzhoushanDesktop() {
  const theme = useTheme();
  const desktop = useSyncExternalStore(subscribe, () => window.matchMedia?.(query).matches ?? false, () => false);
  return theme === "buzhoushan" && desktop;
}
