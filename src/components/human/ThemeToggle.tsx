"use client";

import { Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";

import { REVIEW_THEME_STORAGE_KEY } from "../../shared/review-theme";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDark(document.documentElement.dataset.reviewTheme === "dark");
    function syncPreference(event: StorageEvent) {
      if (event.key !== REVIEW_THEME_STORAGE_KEY && event.key !== null) return;
      const nextDark = event.newValue === "dark";
      document.documentElement.dataset.reviewTheme = nextDark
        ? "dark"
        : "light";
      setDark(nextDark);
    }
    window.addEventListener("storage", syncPreference);
    return () => window.removeEventListener("storage", syncPreference);
  }, []);

  function toggle() {
    const nextDark = document.documentElement.dataset.reviewTheme !== "dark";
    const theme = nextDark ? "dark" : "light";
    document.documentElement.dataset.reviewTheme = theme;
    setDark(nextDark);
    try {
      localStorage.setItem(REVIEW_THEME_STORAGE_KEY, theme);
      setError(null);
    } catch (storageError) {
      console.error("Could not save the review theme preference", storageError);
      setError(
        "Theme changed. Browser storage is unavailable, so your choice won't survive a reload."
      );
    }
  }

  return (
    <div className="theme-control">
      <button
        type="button"
        className="theme-toggle"
        aria-label="Dark mode"
        aria-pressed={dark}
        title={dark ? "Switch to light mode" : "Switch to dark mode"}
        onClick={toggle}
      >
        <Sun className="theme-sun" aria-hidden="true" />
        <Moon className="theme-moon" aria-hidden="true" />
      </button>
      {error ? (
        <div className="theme-error">
          <p role="status">{error}</p>
          <button
            type="button"
            aria-label="Dismiss theme message"
            onClick={() => setError(null)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
