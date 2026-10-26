// Apply the saved appearance before first paint. Kept external for the app's CSP.
try {
  if (localStorage.getItem("flowcanvas:theme") === "light") {
    document.documentElement.dataset.theme = "light";
    document.querySelector('meta[name="theme-color"]').content = "#f5f6f3";
  }
} catch {
  // Forest remains usable when browser storage is unavailable.
}
