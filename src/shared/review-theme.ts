export const REVIEW_THEME_STORAGE_KEY = "agent-outbox-review-theme";

// Run in the head before the workspace paints, including on full reloads.
export const REVIEW_THEME_INIT_SCRIPT = `
try {
  const theme = localStorage.getItem(${JSON.stringify(REVIEW_THEME_STORAGE_KEY)});
  document.documentElement.dataset.reviewTheme = theme === "dark" ? "dark" : "light";
} catch (error) {
  console.error("Could not load the review theme preference", error);
}
`;
