/**
 * postcss-tv-compat — inline PostCSS plugin
 *
 * Makes Tailwind v4's output survive the browsers found on waiting-room
 * televisions, which lag years behind the phones and laptops everything else
 * is tested on.
 *
 * Three transforms, and the first one is subtler than it looks.
 */

/**
 * Splits a selector list on its top-level commas.
 *
 * Commas also appear inside `:not(…)`, `:where(…)` and attribute values, so
 * `String.split(',')` would cut selectors in half.
 */
function splitTopLevel(selector) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;

  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];

    // A backslash escapes whatever follows — Tailwind's class names are full of
    // them (`.space-y-1\.5`, `:not(#\#)`), and treating the escaped character as
    // syntax is how a selector rewriter corrupts a stylesheet.
    if (char === '\\') {
      i++;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[') {
      depth++;
    } else if (char === ')' || char === ']') {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(selector.slice(start));
  return parts;
}

/**
 * Rewrites `:where(…)` away, keeping the selector it matched.
 *
 * Tailwind v4 uses `:where()` for its zero-specificity tricks — every
 * `space-y-*` and `divide-*` rule in the stylesheet is
 * `:where(.space-y-4 > :not(:last-child))`, and `group-hover:*` is
 * `:where(.group):hover`. An engine that does not know the selector discards
 * the entire rule, so on such a browser the page loses all of its vertical
 * rhythm at once: sections, form fields, nav items and card contents collapse
 * against each other. That reads as "nothing is padded" rather than as a
 * missing feature, which is how it was reported.
 *
 * Done unconditionally rather than behind `@supports selector(:where(*))`,
 * because that guard is itself newer (Chrome 83) than several of the TV engines
 * this is aimed at — webOS shipped Chromium 79, Tizen 76 — so the fallback
 * would be skipped on exactly the devices that need it.
 *
 * The cost is specificity: `:where()` contributes nothing, its contents do. The
 * result is what Tailwind v3 emitted for these same utilities for years, and
 * the `:not(#\#)` weights added by the cascade-layers plugin above still
 * dominate, so layer ordering is unaffected.
 *
 * The argument may be a list, so one selector can expand into several.
 */
function expandWhere(selector) {
  const marker = ':where(';
  const idx = selector.indexOf(marker);
  if (idx === -1) return [selector];

  // Find the parenthesis that closes this `:where(`, honouring nesting.
  let depth = 0;
  let end = -1;
  for (let i = idx + marker.length - 1; i < selector.length; i++) {
    const char = selector[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  // Unbalanced — leave it alone rather than emit something invalid.
  if (end === -1) return [selector];

  const before = selector.slice(0, idx);
  const inner = selector.slice(idx + marker.length, end);
  const after = selector.slice(end + 1);

  return splitTopLevel(inner).flatMap((part) =>
    expandWhere(before + part.trim() + after),
  );
}

function tvCompat() {
  return {
    postcssPlugin: 'postcss-tv-compat',

    /**
     * Replaces `@property` with the initial values it was registering.
     *
     * Tailwind v4 does not set `--tw-border-style`, `--tw-shadow`,
     * `--tw-ring-*` and friends in a normal rule. It registers them with
     * `@property`, and their `initial-value` is what makes
     * `border-style: var(--tw-border-style)` resolve to `solid` and
     * `box-shadow: var(--tw-shadow), …` resolve to anything at all.
     *
     * Deleting those at-rules therefore does not merely drop an unsupported
     * feature — it leaves every one of those variables undefined, so the
     * declarations that consume them become invalid and the browser throws
     * away every border, shadow and ring in the stylesheet. The page stays
     * laid out and loses all of its depth, which is exactly how this
     * presented: flat, borderless, and unfinished.
     *
     * Tailwind does ship a fallback block carrying the same values, but it is
     * wrapped in an `@supports` that tests for old Safari or old Firefox —
     * Chromium is assumed to support `@property`, so a Chromium-based TV
     * browser matches neither branch and gets nothing.
     *
     * So the values are re-emitted unconditionally instead. `*` keeps the
     * specificity at zero, so any utility that sets one of these still wins,
     * and setting them on every element reproduces the `inherits: false`
     * behaviour `@property` provided.
     */
    OnceExit(root, { Rule }) {
      // Selectors first, while the tree is still exactly what the plugins above
      // produced. `@property` handling below adds a rule of its own, and there
      // is nothing in it for this pass to rewrite.
      root.walkRules((rule) => {
        if (!rule.selector.includes(':where(')) return;
        rule.selectors = rule.selectors.flatMap((selector) =>
          expandWhere(selector),
        );
      });

      const initials = new Map();

      root.walkAtRules('property', (atRule) => {
        const name = atRule.params.trim();
        let initialValue;
        atRule.walkDecls('initial-value', (decl) => {
          initialValue = decl.value;
        });

        if (name.startsWith('--')) {
          // A registration with no initial-value contributes nothing here;
          // `initial` keeps the variable defined rather than absent.
          initials.set(name, initialValue ?? 'initial');
        }

        atRule.remove();
      });

      if (initials.size === 0) return;

      const fallback = new Rule({
        selectors: ['*', '::before', '::after', '::backdrop'],
      });
      for (const [prop, value] of initials) {
        // A plain object rather than `new Declaration(...)`: PostCSS builds the
        // node itself, which avoids depending on which constructors this
        // version exposes to a plugin's helpers.
        fallback.append({ prop, value });
      }

      /**
       * Placed after any leading `@charset` / `@import`, which are the only
       * things CSS requires to come first, and before everything else so the
       * values are defined by the time anything reads them.
       */
      const first = root.nodes.find(
        (node) =>
          !(node.type === 'atrule' && /^(charset|import)$/i.test(node.name)),
      );
      if (first) root.insertBefore(first, fallback);
      else root.append(fallback);
    },

    /**
     * Rewrites dynamic viewport units to the static equivalent.
     *
     * `dvh` exists to cope with a mobile browser's collapsing address bar and
     * needs Chrome 108. A television has no such toolbar, so `vh` is both
     * older and more correct there.
     */
    Declaration(decl) {
      if (decl.value && /\d+(?:\.\d+)?[dsl]v[hw]/i.test(decl.value)) {
        decl.value = decl.value
          .replace(/(\d+(?:\.\d+)?)(dvh|svh|lvh)/gi, '$1vh')
          .replace(/(\d+(?:\.\d+)?)(dvw|svw|lvw)/gi, '$1vw');
      }
    },
  };
}
tvCompat.postcss = true;

const config = {
  plugins: [
    ['@tailwindcss/postcss', {}],

    /**
     * TV browsers (even on Android 14) may use their own rendering engine
     * instead of the system WebView. Tailwind v4 wraps all its output in
     * CSS cascade layers (`@layer`), which older engines silently discard
     * → completely unstyled page.
     *
     * This plugin rewrites `@layer` into specificity-based selectors that
     * achieve the same cascade ordering without needing native support.
     */
    ['@csstools/postcss-cascade-layers', {}],

    /**
     * Downlevels modern CSS (logical properties, modern colors, etc.)
     * for browsers that don't support them.
     */
    [
      'postcss-preset-env',
      {
        stage: 2,
        features: {
          // Already handled by @csstools/postcss-cascade-layers above
          'cascade-layers': false,
          // Preserve CSS custom properties — Tailwind v4 relies on them
          // and they are supported since Chrome 49
          'custom-properties': false,
        },
        browsers: 'chrome >= 60, safari >= 12, firefox >= 60',
      },
    ],

    // Must run last: it reads the @property rules the plugins above leave
    // behind, and rewrites units in their final form.
    tvCompat,
  ],
};

export default config;
