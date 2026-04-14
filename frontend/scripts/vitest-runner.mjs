import { spawn } from "node:child_process";

const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== "--runInBand");
const vitestArgs = ["run", ...passthroughArgs];

const child = spawn("npx", ["vitest", ...vitestArgs], { stdio: "inherit" });

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", () => {
  process.exit(1);
});
