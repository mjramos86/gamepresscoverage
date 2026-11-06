// Allows `--db path/to.db` on any entry point (handy for demo/test databases).
const i = process.argv.indexOf("--db");
if (i > -1 && process.argv[i + 1]) {
  process.env.DB_PATH = process.argv[i + 1];
  process.argv.splice(i, 2);
}
