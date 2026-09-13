(() => {
  // One icon set for the whole interface.
  //
  // Before this, the UI mixed an OS colour emoji (🌐), raw text glyphs (◌ ▶ ×
  // ↻ ⋯) and three hand-rolled SVGs with different weights and sizes. The
  // emoji rendered in colour at a different optical weight from everything
  // around it, and the text glyphs changed shape with whichever font resolved
  // them.
  //
  // Two families, because they do different jobs:
  //
  //   transport  solid geometry. Transport controls are read at a glance while
  //              looking at the picture, not at the UI, so they get maximum
  //              contrast and no interior detail.
  //   interface  a 1.75px stroked grid on a 24x24 box with round caps, so a
  //              gear and a globe share a stroke rhythm.
  //
  // Every icon paints with currentColor so it follows the text, muted and accent
  // states it sits in. None carry width/height: size is a layout decision, so it
  // belongs in CSS with the rest of the layout.

  const BOX = 'viewBox="0 0 24 24" class="icon" aria-hidden="true" focusable="false"';
  const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';

  const icons = {
    // ---- Interface ----
    settings: '<svg ' + BOX + ' ' + STROKE + '><circle cx="12" cy="12" r="3"/><path d="M19.1 14.6a1.7 1.7 0 0 0 .35 1.87l.04.05a2 2 0 1 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.35 1.7 1.7 0 0 0-1.04 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.35l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05a1.7 1.7 0 0 0 .35-1.87 1.7 1.7 0 0 0-1.55-1.04H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.35-1.88l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.35h.08a1.7 1.7 0 0 0 1.04-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.55 1.7 1.7 0 0 0 1.87-.35l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.35 1.87v.08a1.7 1.7 0 0 0 1.55 1.04H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1.04z"/></svg>',
    globe: '<svg ' + BOX + ' ' + STROKE + '><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z"/></svg>',
    refresh: '<svg ' + BOX + ' ' + STROKE + '><path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9L4 16"/><path d="M4 20v-4h4"/><path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9L20 8"/><path d="M20 4v4h-4"/></svg>',
    more: '<svg ' + BOX + ' ' + STROKE + '><circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/></svg>',
    close: '<svg ' + BOX + ' ' + STROKE + '><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    check: '<svg ' + BOX + ' ' + STROKE + '><path d="M20 6.5L9.2 17.3 4 12.1"/></svg>',
    // A 270-degree arc with a round cap; the gap is what reads as motion when
    // it spins, which a full ring cannot show.
    spinner: '<svg ' + BOX + ' ' + STROKE + '><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/></svg>',

    // ---- View modes ----
    // Rows of equal weight for the dense list; a 2x2 field for the poster grid.
    // The two are drawn on the same grid so switching between them reads as a
    // change of emphasis rather than a change of icon family.
    list: '<svg ' + BOX + ' ' + STROKE + '><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.5"/></svg>',
    grid: '<svg ' + BOX + ' ' + STROKE + '><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',

    // ---- Transport ----
    play: '<svg ' + BOX + ' fill="currentColor"><path d="M8.4 5.2v13.6c0 .85.93 1.37 1.65.93l10.7-6.8a1.1 1.1 0 0 0 0-1.86L10.05 4.27c-.72-.44-1.65.08-1.65.93z"/></svg>',
    pause: '<svg ' + BOX + ' fill="currentColor"><rect x="7.5" y="5" width="3.6" height="14" rx="1.1"/><rect x="12.9" y="5" width="3.6" height="14" rx="1.1"/></svg>',
    prev: '<svg ' + BOX + ' fill="currentColor"><rect x="4.5" y="5" width="2.6" height="14" rx="1"/><path d="M20 6.4v11.2c0 .86-.94 1.38-1.66.93l-8.3-5.6a1.1 1.1 0 0 1 0-1.86l8.3-5.6c.72-.45 1.66.07 1.66.93z"/></svg>',
    next: '<svg ' + BOX + ' fill="currentColor"><rect x="16.9" y="5" width="2.6" height="14" rx="1"/><path d="M4 6.4v11.2c0 .86.94 1.38 1.66.93l8.3-5.6a1.1 1.1 0 0 0 0-1.86l-8.3-5.6C4.94 5.02 4 5.54 4 6.4z"/></svg>'
  };

  // Hydrate static markup: elements declare data-icon and get their glyph on
  // startup, the same way data-i18n elements get their copy. Keeping the markup
  // free of path data means the set lives in exactly one place.
  function hydrateIcons(root) {
    const scope = root || document;
    for (const element of scope.querySelectorAll("[data-icon]")) {
      const svg = icons[element.dataset.icon];
      if (svg) element.innerHTML = svg;
    }
  }

  const api = { icons, hydrateIcons, get: name => icons[name] || "" };
  if (typeof window !== "undefined") window.__icons = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
