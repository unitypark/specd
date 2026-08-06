import { Module } from '@nestjs/common';
import { Vault } from '../common/vault.js';
import { ConnectionsService } from '../projects/connections.service.js';
import { LocalGitAdapter } from './local-git.adapter.js';
import { VcsService } from './vcs.service.js';

@Module({
  providers: [LocalGitAdapter, VcsService, ConnectionsService, Vault],
  exports: [VcsService, LocalGitAdapter, ConnectionsService, Vault],
})
export class VcsModule {}
