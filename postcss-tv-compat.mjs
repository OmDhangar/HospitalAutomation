/**
 * postcss-tv-compat
 *
 * Strips modern CSS features that break on old TV browsers (Android TV
 * built-in browsers, Puffin TV, TV Bro, etc.) which typically ship an
 * outdated Chromium WebView (v50-80):
 *
 *   1. @property declarations  → Removed entirely. Tailwind v4 emits
 *      @supports-based fallbacks for browsers that lack @property.
 *
 *   2. dvh / svh / lvh units   → Replaced with vh. Dynamic viewport
 *      units are Chrome 108+; vh is the safe fallback.
 *
 *   3. 100dvh in min-height    → Also adds a 100vh fallback before it,
 *      so older browsers that skip the dvh declaration still get
 *      full-height layouts.
 */

/** @type {import('postcss').PluginCreator} */
const plugin = () => {
  return {
    postcssPlugin: 'postcss-tv-compat',

    // Strip all @property at-rules
    AtRule: {
      property(atRule) {
        atRule.remove();
      },
    },

    // Replace dynamic viewport units with plain vh/vw
    Declaration(decl) {
      if (decl.value && /\d+[dsl]v[hwminax]/i.test(decl.value)) {
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvh|svh|lvh)/gi,
          '$1vh',
        );
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvw|svw|lvw)/gi,
          '$1vw',
        );
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvi|svi|lvi)/gi,
          '$1vi',
        );
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvb|svb|lvb)/gi,
          '$1vb',
        );
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvmin|svmin|lvmin)/gi,
          '$1vmin',
        );
        decl.value = decl.value.replace(
          /(\d+(?:\.\d+)?)(dvmax|svmax|lvmax)/gi,
          '$1vmax',
        );
      }
    },
  };
};

plugin.postcss = true;
export default plugin;
