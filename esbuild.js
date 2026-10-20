import esbuild from "esbuild";
import fs from "fs";
import path from "path";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const devVariant = process.argv.includes("--dev-variant");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location)
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`,
          );
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.cjs",
    metafile: true,
    external: ["vscode"],
    // jsonc-parser's UMD "main" loads its modules with a dynamic require that
    // esbuild cannot follow; prefer the ESM entry so they are bundled.
    mainFields: ["module", "main"],
    define: {
      __GATEWAY_DEV__: devVariant ? "true" : "false",
      __GATEWAY_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    logLevel: "info",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild().then((result) => {
      if (result.metafile) {
        fs.writeFileSync(
          path.join("dist", "meta.json"),
          JSON.stringify(result.metafile, null, 2),
        );
      }
      console.log("[build] build completed");
    });
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
