import esbuild from "esbuild";
import builtins from "builtin-modules";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const prod = process.argv[2] === "production";

// styles.css is the concatenation of styles/*.css in name order
const buildCss = () => {
  const parts = readdirSync("styles").filter((f) => f.endsWith(".css")).sort();
  writeFileSync("styles.css", parts.map((f) => `/* ${f} */\n` + readFileSync(`styles/${f}`, "utf8")).join("\n"));
};
buildCss();

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
