const target = process.argv[2] ?? "unknown";
process.stderr.write(`${target}: required gate is not implemented yet\n`);
process.exitCode = 1;
