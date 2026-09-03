import Fastify from "fastify";
import multipart from "@fastify/multipart";

import type { Database } from "./shared/db.js";
import { registerDaysRoutes } from "./modules/days/days.routes.js";
import { registerNotificationRoutes } from "./modules/notifications/notifications.routes.js";
import { registerStudyRoutes } from "./modules/study/study.routes.js";
import { registerSystemRoutes } from "./modules/system/system.routes.js";

export function buildApp(sql?: Database) {
  const app = Fastify({ logger: true });
  app.register(multipart, { limits: { files: 1, fileSize: 10 * 1024 * 1024 } });

  app.register((instance) => registerSystemRoutes(instance, sql), { prefix: "/api" });

  if (sql) {
    app.addHook("onClose", () => sql.end());
    app.register((instance) => registerDaysRoutes(instance, sql), { prefix: "/api/days" });
    app.register((instance) => registerNotificationRoutes(instance, sql), { prefix: "/api" });
    app.register((instance) => registerStudyRoutes(instance, sql), { prefix: "/api/study" });
  }

  return app;
}
