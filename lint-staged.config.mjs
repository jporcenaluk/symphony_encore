export default {
  "*.{css,js,json,jsonc,jsx,ts,tsx}": "biome check --write --no-errors-on-unmatched",
  "*.md": "markdownlint-cli2",
};
