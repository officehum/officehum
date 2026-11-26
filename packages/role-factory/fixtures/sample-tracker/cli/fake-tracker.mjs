// A stand-in for a tracker's command-line tool, used only by @officehum/role-factory's tests of a
// generated role. It has no dependencies, reads nothing and writes nothing: it prints, as JSON, the
// arguments it was given and the names of the environment variables it can see.

process.stdout.write(
  JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() }),
);
