(function (global) {
  const storageKey = "restory.design-system.appearance";
  const defaults = { theme: "dark", textScale: "normal" };
  const isTheme = value => value === "dark" || value === "light";
  const isTextScale = value => value === "normal" || value === "large";
  function readAppearance(storage) {
    let raw; try { raw = storage.getItem(storageKey); } catch { return Object.assign({}, defaults); }
    if (raw === null) return Object.assign({}, defaults);
    let value; try { value = JSON.parse(raw); } catch { return Object.assign({}, defaults); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.assign({}, defaults);
    if (!isTheme(value.theme) || !isTextScale(value.textScale)) return Object.assign({}, defaults);
    return { theme: value.theme, textScale: value.textScale };
  }
  function writeAppearance(storage, appearance) {
    if (!isTheme(appearance.theme)) throw new Error(`invalid theme: ${String(appearance.theme)}`);
    if (!isTextScale(appearance.textScale)) throw new Error(`invalid textScale: ${String(appearance.textScale)}`);
    storage.setItem(storageKey, JSON.stringify({ theme: appearance.theme, textScale: appearance.textScale }));
  }
  global.DSHelpers = Object.assign(global.DSHelpers || {}, {
    storageKey,
    defaults: Object.assign({}, defaults),
    isTheme,
    isTextScale,
    readAppearance,
    writeAppearance,
    designSystemAppearanceStorageKey: storageKey,
    defaultDesignSystemAppearance: Object.assign({}, defaults),
    isDesignSystemTheme: isTheme,
    isDesignSystemTextScale: isTextScale,
    readDesignSystemAppearance: readAppearance,
    writeDesignSystemAppearance: writeAppearance
  });
})(globalThis);
