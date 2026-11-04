// Sets the colour theme before the page draws, so it never flashes the other one: dark unless light was picked in
// Settings (kept in lmk.v1, see lib/store.mjs).
(function () {
  var theme = "dark";
  try {
    var s = JSON.parse(localStorage.getItem("lmk.v1") || "null");
    if (s && s.theme === "light") theme = "light";
  } catch (e) {
    // blocked storage: dark
  }
  document.documentElement.setAttribute("data-theme", theme);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", theme === "light" ? "#f5f5f7" : "#0b0c0f");
})();
