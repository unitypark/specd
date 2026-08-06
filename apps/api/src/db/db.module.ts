import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db, type DbHandle } from '@specd/db';
import { Config } from '../config.js';

export const DB = Symbol('SPECD_DB');
export const DB_HANDLE = Symbol('SPECD_DB_HANDLE');

@Global()
@Module({
  providers: [
    Config,
    {
      provide: DB_HANDLE,
      inject: [Config],
      useFactory: (config: Config): DbHandle => createDb(config.databaseUrl),
    },
    {
      provide: DB,
      inject: [DB_HANDLE],
      useFactory: (handle: DbHandle): Db => handle.db,
    },
  ],
  exports: [DB, DB_HANDLE, Config],
})
export class DbModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // Pool teardown is handled by the handle provider's own lifetime; kept as
    // an explicit hook so shutdown ordering is visible rather than implicit.
  }
}
