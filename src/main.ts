import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { initTracing } from "./shared/tracing";

async function bootstrap(): Promise<void> {
  initTracing();
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(JSON.stringify({ level: "info", event: "started", port }));
}

bootstrap();
