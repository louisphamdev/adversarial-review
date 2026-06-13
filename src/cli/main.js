const COMMANDS = new Set(["install", "check", "hook", "run", "doctor", "help"]);

export async function main(argv, io) {
  const [cmd = "help", ...rest] = argv;
  if (!COMMANDS.has(cmd)) {
    io.stderr.write(`Unknown command: ${cmd}\n`);
    io.stderr.write(helpText());
    process.exitCode = 2;
    return;
  }
  if (cmd === "help") {
    io.stdout.write(helpText());
    return;
  }
  if (cmd === "doctor") {
    const { doctorCommand } = await import("./doctor.js");
    return doctorCommand(rest, io);
  }
  if (cmd === "check") {
    const { checkCommand } = await import("./check.js");
    return checkCommand(rest, io);
  }
  if (cmd === "hook") {
    const { hookCommand } = await import("./hook.js");
    return hookCommand(rest, io);
  }
  if (cmd === "run") {
    const { runCommand } = await import("./run.js");
    return runCommand(rest, io);
  }
  const { installCommand } = await import("./install.js");
  return installCommand(rest, io);
}

export function helpText() {
  return [
    "Usage: adversarial-review <command> [options]",
    "",
    "Commands:",
    "  install   Install host integrations and project config",
    "  check     Run the review gate on the current workspace",
    "  hook      Run as a native host lifecycle hook",
    "  run       Wrap a host tool command and gate after it exits",
    "  doctor    Diagnose config, host integrations, and reviewers",
    "  help      Show this help",
    "",
  ].join("\n");
}
