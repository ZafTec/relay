import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceUrl = new URL("../src/styles/ledger-tokens.json", import.meta.url);
const outputUrl = new URL("../src/styles/tokens.css", import.meta.url);
const source = JSON.parse(await readFile(sourceUrl, "utf8"));

function cssDuration(value, tokenName) {
  const match = /^\s*((?:\d+(?:\.\d+)?|\.\d+)(?:ms|s))\b/.exec(value);
  if (!match) throw new Error(`${tokenName} must start with a CSS duration.`);
  return match[1];
}

const product = source.color.product;
const productLight = product.light;
const publicSurface = source.color.public;
const spaces = source.space.scale;

function productVariableLines(tokens) {
  return [
    ["--relay-product-bg", tokens.bg.value],
    ["--relay-product-rail", tokens["bg-rail"].value],
    ["--relay-product-surface", tokens.surface.value],
    ["--relay-product-surface-2", tokens["surface-2"].value],
    ["--relay-product-border", tokens.border.value],
    ["--relay-product-border-strong", tokens["border-strong"].value],
    ["--relay-product-ink", tokens.ink.value],
    ["--relay-product-ink-secondary", tokens["ink-secondary"].value],
    ["--relay-product-ink-muted", tokens["ink-muted"].value],
    ["--relay-product-accent", tokens.accent.value],
    ["--relay-product-accent-hover", tokens["accent-hover"].value],
  ];
}

const variableLines = [
  ["--relay-public-paper", publicSurface.paper.value],
  ["--relay-public-paper-2", publicSurface["paper-2"].value],
  ["--relay-public-border", publicSurface.border.value],
  ["--relay-public-border-strong", publicSurface["border-strong"].value],
  ["--relay-public-ink", publicSurface.ink.value],
  ["--relay-public-ink-secondary", publicSurface["ink-secondary"].value],
  ["--relay-public-ink-muted", publicSurface["ink-muted"].value],
  ["--relay-public-accent", publicSurface.accent.value],
  ["--relay-public-accent-hover", publicSurface["accent-hover"].value],
  ["--relay-public-invert", publicSurface.invert.value],
  ...productVariableLines(productLight),
  ["--relay-font-sans", source.typography.families.sans.stack],
  ["--relay-font-mono", source.typography.families.mono.stack],
  ["--relay-radius", source.radius.all],
  ["--relay-border", source.border.hairline],
  ["--relay-rail-width", source.space.railWidth],
  ["--relay-drawer-width", source.space.drawerWidth],
  ["--relay-container", source.space.container],
  ["--relay-gutter", source.space.gutter],
  ["--relay-section-y", source.space.sectionY],
  ["--relay-motion-press", source.motion.duration.press],
  ["--relay-motion-hover", source.motion.duration.hover],
  ["--relay-motion-stage", cssDuration(source.motion.duration.stage, "motion.duration.stage")],
  ["--relay-ease-out", source.motion.easing["out-strong"]],
  ...spaces.map((space, index) => [`--relay-space-${index + 1}`, `${space}px`]),
];

const darkProductLines = productVariableLines(product);
const generated = `/* Generated from the approved Relay v3 token copy. Do not edit by hand. */\n`
  + `:root {\n${variableLines.map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}\n\n`
  + `/* The product surface (dashboard, admin) follows the viewer's OS/browser color-scheme preference.\n`
  + `   The public marketing surface stays on its paper palette in both modes. */\n`
  + `@media (prefers-color-scheme: dark) {\n  :root {\n${darkProductLines
    .map(([name, value]) => `    ${name}: ${value};`)
    .join("\n")}\n  }\n}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputUrl, "utf8").catch(() => "");
  if (existing !== generated) {
    console.error("src/styles/tokens.css is out of date. Run npm run tokens:generate.");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputUrl, generated, "utf8");
}
