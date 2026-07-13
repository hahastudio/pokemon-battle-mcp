import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetSpeedTiersRequest, OptimizeSpeedSpreadRequest } from '../types';
import { optimizeSpeedSpread } from '../services/solver';
import { getSpeedTiers } from '../services/speed';
import {
  canonicalizeBattlePokemonForCalcTool,
  mergeInputCorrectionsIntoResponse,
} from './canonicalize';
import { wrapTool } from './common';
import {
  GetSpeedTiersRequestSchema,
  GetSpeedTiersResponseSchema,
  OptimizeSpeedSpreadRequestSchema,
  OptimizeSpeedSpreadResponseSchema,
} from './schemas';

export async function handleOptimizeSpeedSpread(request: OptimizeSpeedSpreadRequest) {
  const self = await canonicalizeBattlePokemonForCalcTool(request.self, 'self', request.context?.format);
  const target =
    'battlePokemon' in request.target && request.target.battlePokemon
      ? await canonicalizeBattlePokemonForCalcTool(
          request.target.battlePokemon,
          'target.battlePokemon',
          request.context?.format,
        )
      : undefined;
  const response = optimizeSpeedSpread({
    ...request,
    self: self.pokemon,
    target: target
      ? {
          battlePokemon: target.pokemon,
          benchmarkLabel: request.target.benchmarkLabel,
        }
      : request.target,
  });
  return mergeInputCorrectionsIntoResponse(response, [
    self.inputCorrections,
    target?.inputCorrections,
  ]);
}

export function registerSpeedTools(server: McpServer): void {
  server.registerTool(
    'optimize_speed_spread',
    {
      title: 'Optimize speed SP spread',
      description:
        'Find the minimum Speed SP and nature needed to outspeed, speed tie, or underspeed a target. Use get_pokemon_options first for current-format Mega/forme requests; this tool also resolves unambiguous current-meta base-forme mistakes.',
      inputSchema: OptimizeSpeedSpreadRequestSchema,
      outputSchema: OptimizeSpeedSpreadResponseSchema,
    },
    async args => wrapTool(() => handleOptimizeSpeedSpread(args as OptimizeSpeedSpreadRequest)),
  );

  server.registerTool(
    'get_speed_tiers',
    {
      title: 'Get speed tiers',
      description: 'Return sorted speed benchmarks from the current meta seed/source.',
      inputSchema: GetSpeedTiersRequestSchema,
      outputSchema: GetSpeedTiersResponseSchema,
    },
    async args => wrapTool(() => getSpeedTiers(args as GetSpeedTiersRequest)),
  );
}
