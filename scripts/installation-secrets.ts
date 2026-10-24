import { randomBytes } from "node:crypto";
import { mkdir, open, chmod, chown } from "node:fs/promises";
// Separate volumes keep the database administrator credential out of runtime containers.
for (const [directory, names] of [
  ["/secrets/admin", ["database-password"]],
  ["/secrets/app", ["database-password", "setup-token"]],
] as const) {
  await mkdir(directory, { recursive: true });
  await chown(directory, 1000, 1000);
  await chmod(directory, 0o700);
  for (const name of names) {
    const path = `${directory}/${name}`;
    try {
      const file = await open(path, "wx", 0o400);
      try {
        await file.writeFile(randomBytes(32).toString("hex"));
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await chown(path, 1000, 1000);
    await chmod(path, 0o400);
  }
}
console.log("Installation credential files ready");
