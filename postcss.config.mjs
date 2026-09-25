/**
 * postcss-tv-compat — inline PostCSS plugin
 *
 * Strips @property declarations and replaces dvh/svh/lvh with vh
 * for old TV browsers that don't support them.
 */
function tvCompat() {
  return {
    postcssPlugin: 'postcss-tv-compat',
    AtRule: {
      property(atRule) {
        atRule.remove();
      },
    },
    Declaration(decl) {
      if (decl.value && /\d+[dsl]v[hw]/i.test(decl.value)) {
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvh|svh|lvh)/gi,
          '$1vh',
        );
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvw|svw|lvw)/gi,
          '$1vw',
        );
      }
    },
  };
}
tvCompat.postcss = true;

const config = {
  plugins: [
    ["@tailwindcss/postcss", {}],

    /**
     * TV browsers (even on Android 14) may use their own rendering engine
     * instead of the system WebView.  Tailwind v4 wraps all its output in
     * CSS cascade layers (`@layer`), which older engines silently discard
     * → completely unstyled page.
     *
     * This plugin rewrites `@layer` into specificity-based selectors that
     * achieve the same cascade ordering without needing native support.
     */
    ["@csstools/postcss-cascade-layers", {}],

    /**
     * Downlevels modern CSS (logical properties, modern colors, etc.)
     * for browsers that don't support them.
     */
    ["postcss-preset-env", {
      stage: 2,
      features: {
        // Already handled by @csstools/postcss-cascade-layers above
        "cascade-layers": false,
        // Preserve CSS custom properties — Tailwind v4 relies on them
        // and they are supported since Chrome 49
        "custom-properties": false,
      },
      browsers: "chrome >= 60, safari >= 12, firefox >= 60",
    }],

    /**
     * Strips @property declarations and replaces dvh/svh/lvh → vh.
     * Must run last.
     */
    tvCompat,
  ],
};

export default config;
