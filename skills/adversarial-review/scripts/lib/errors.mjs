// The CLI maps these to exit codes: ConfigError -> 2 (usage or config), RunError -> 3.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = 2;
  }
}

export class RunError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'RunError';
    this.exitCode = 3;
    this.reason = reason;
  }
}
