// Builds a side-by-side dev VSIX (id ness001.agent-gateway-dev, port 24445).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const original = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(original);
pkg.name = "agent-gateway-dev";
pkg.displayName = `${pkg.displayName} (Dev)`;

const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
try {
  run("pnpm run build:dev-variant");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  run(
    `pnpm exec vsce package --no-dependencies -o agent-gateway-dev-${pkg.version}.vsix`,
  );
} finally {
  fs.writeFileSync(pkgPath, original);
}
