import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const storageKey = "flowcanvas:theme";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#141b18" : "#f5f6f3");
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // Switching appearance still works without persistence.
    }
  }, [theme]);

  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) {
        setTheme(event.newValue === "light" ? "light" : "dark");
      }
    };
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  return {
    theme,
    toggleTheme: () => setTheme((old) => (old === "dark" ? "light" : "dark")),
  };
}
