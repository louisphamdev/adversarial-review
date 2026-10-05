// Idle seat fixture: writes one line, then stays silent until killed.
process.stdout.write('{"type":"step_start"}\n');
setInterval(() => {}, 10000);
