import 'dotenv/config';
import { createApplication } from './bootstrap.js';
import { loadAppConfig } from './config/env.js';

async function main(): Promise<void> {
  const config = loadAppConfig(process.env);
  const app = createApplication(config);

  const handleSignal = (signalName: string): void => {
    const forceExitTimer = setTimeout(() => {
      process.exit(1);
    }, 12_000);
    forceExitTimer.unref();

    void app
      .shutdown(signalName)
      .then(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(forceExitTimer);
        app.logger.error('Error during shutdown', {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  process.on('unhandledRejection', (reason: unknown) => {
    app.logger.error('Unhandled Promise Rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (err: Error) => {
    app.logger.error('Uncaught Exception', {
      error: err.message,
      stack: err.stack,
    });
    void app.shutdown('uncaughtException').finally(() => {
      process.exit(1);
    });
  });

  await app.start();
}

main().catch((err: unknown) => {
  console.error(
    '[FATAL] Failed to start X NFT Account Monitor:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
