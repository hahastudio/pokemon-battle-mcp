import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetMetaSnapshotRequest, GetPokemonOptionsRequest } from '../types';
import { getMetaSnapshot, getPokemonOptions } from '../services/meta-source';
import { wrapTool } from './common';
import {
  GetMetaSnapshotRequestSchema,
  GetMetaSnapshotResponseSchema,
  GetPokemonOptionsRequestSchema,
  GetPokemonOptionsResponseSchema,
} from './schemas';

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    'get_meta_snapshot',
    {
      title: 'Get Pokémon Champions meta snapshot',
      description:
        'Get popular Pokémon, moves, items, abilities, and common Pokémon Champions SP spreads for the current format.',
      inputSchema: GetMetaSnapshotRequestSchema,
      outputSchema: GetMetaSnapshotResponseSchema,
    },
    async args => wrapTool(() => getMetaSnapshot(args as GetMetaSnapshotRequest)),
  );

  server.registerTool(
    'get_pokemon_options',
    {
      title: 'Get Pokémon options',
      description:
        'Get common sets, moves, items, abilities, spreads, and optional teammates/counters for one Pokémon.',
      inputSchema: GetPokemonOptionsRequestSchema,
      outputSchema: GetPokemonOptionsResponseSchema,
    },
    async args => wrapTool(() => getPokemonOptions(args as GetPokemonOptionsRequest)),
  );
}
