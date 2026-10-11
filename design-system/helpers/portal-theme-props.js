(function (global) {
  function portalThemeProps() {
    const root = typeof document === "undefined" ? null : document.querySelector(".restory-ds[data-theme]");
    const theme = root && root.getAttribute("data-theme");
    const scale = root && root.getAttribute("data-text-scale");
    return { "data-theme": theme ?? undefined, "data-text-scale": scale ?? undefined };
  }
  global.DSHelpers = Object.assign(global.DSHelpers || {}, { portalThemeProps });
})(globalThis);
