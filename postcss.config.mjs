const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    /**
     * TV browsers (typically Chromium ≤ 70) don't support CSS cascade layers
     * (`@layer`).  Tailwind v4 wraps all its output in layers, so browsers
     * that can't parse them discard every rule → completely unstyled page.
     *
     * This plugin runs *after* Tailwind and rewrites `@layer` into
     * specificity-based selectors that achieve the same cascade ordering
     * without needing native `@layer` support.
     */
    "@csstools/postcss-cascade-layers": {},
  },
};

export default config;
