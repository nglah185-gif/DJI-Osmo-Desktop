(() => {
  let enMessages;
  let zhMessages;
  if (typeof module !== "undefined" && module.exports) {
    enMessages = require("./en");
    zhMessages = require("./zh-CN");
  } else {
    enMessages = window.__I18N_EN__ || {};
    zhMessages = window.__I18N_ZH__ || {};
  }
  function interpolate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (vars[key] !== undefined ? String(vars[key]) : match));
  }
  function createTranslator(lang, en, zh) {
    return Object.freeze({
      lang,
      t(key, vars) {
        const selected = lang === "zh-CN" ? zh : en;
        const value = selected[key] !== undefined ? selected[key] : en[key];
        if (value === undefined) return key;
        return interpolate(value, vars);
      }
    });
  }
  let lang = "en";
  // Resolve against the current language on every call. A translator created
  // once here would permanently capture the startup language, making
  // setLanguage update the selector and <html lang> while leaving all copy in
  // the old language.
  const t = (key, vars) => createTranslator(lang, enMessages, zhMessages).t(key, vars);
  function applyElementTranslation(element, value) {
    // Update the option's text node as well as its label. Chromium uses the
    // text node for the native select popup; setting only `label` leaves the
    // visible option in the previous language.
    if (element && String(element.tagName || "").toUpperCase() === "OPTION") {
      element.textContent = value;
      element.label = value;
    } else if (element) element.textContent = value;
  }
  function apply() {
    if (typeof document === "undefined") return;
    document.querySelectorAll("[data-i18n]").forEach(element => { applyElementTranslation(element, t(element.dataset.i18n)); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(element => { element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel)); });
    document.querySelectorAll("[data-i18n-title]").forEach(element => { element.setAttribute("title", t(element.dataset.i18nTitle)); });
    document.documentElement.lang = lang;
  }
  const api = {
    t,
    getLanguage: () => lang,
    setLanguage(value) {
      if (value !== "en" && value !== "zh-CN") return;
      lang = value;
      apply();
    },
    apply
  };
  if (typeof window !== "undefined") { window.i18n = api; if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", apply); }
  if (typeof module !== "undefined" && module.exports) module.exports = { createTranslator, applyElementTranslation, enMessages, zhMessages, api };
})();
