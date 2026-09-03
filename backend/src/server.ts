import { buildApp } from "./app.js";
import { createDatabase } from "./shared/db.js";

const app = buildApp(createDatabase());
const port = Number(process.env.PORT ?? 4000);

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
