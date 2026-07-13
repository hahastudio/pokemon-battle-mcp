import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CalculateStatsRequest,
  CheckDamageMatchupRequest,
  OptimizeOffensiveSpreadRequest,
  OptimizeSurvivalSpreadRequest,
} from '../types';
import { calculateDamageMatchup, calculateStatsResponse } from '../utils/calc';
import { optimizeOffensiveSpread, optimizeSurvivalSpread } from '../services/solver';
import {
  canonicalizeBattlePokemonForCalcTool,
  mergeInputCorrectionsIntoResponse,
} from './canonicalize';
import { wrapTool } from './common';
import {
  CalculateStatsRequestSchema,
  CalculateStatsResponseSchema,
  CheckDamageMatchupRequestSchema,
  CheckDamageMatchupResponseSchema,
  OptimizeOffensiveSpreadRequestSchema,
  OptimizeOffensiveSpreadResponseSchema,
  OptimizeSurvivalSpreadRequestSchema,
  OptimizeSurvivalSpreadResponseSchema,
} from './schemas';

export async function handleCalculateStats(request: CalculateStatsRequest) {
  const pokemon = await canonicalizeBattlePokemonForCalcTool(
    request.pokemon,
    'pokemon',
    request.context?.format,
  );
  const response = calculateStatsResponse(pokemon.pokemon, request.context);
  return mergeInputCorrectionsIntoResponse(response, [pokemon.inputCorrections]);
}

export async function handleCheckDamageMatchup(request: CheckDamageMatchupRequest) {
  const [attacker, defender] = await Promise.all([
    canonicalizeBattlePokemonForCalcTool(request.attacker, 'attacker', request.context?.format),
    canonicalizeBattlePokemonForCalcTool(request.defender, 'defender', request.context?.format),
  ]);
  const response = calculateDamageMatchup({
    ...request,
    attacker: attacker.pokemon,
    defender: defender.pokemon,
  });
  return mergeInputCorrectionsIntoResponse(response, [
    attacker.inputCorrections,
    defender.inputCorrections,
  ]);
}

export async function handleOptimizeOffensiveSpread(request: OptimizeOffensiveSpreadRequest) {
  const [attacker, defender] = await Promise.all([
    canonicalizeBattlePokemonForCalcTool(request.attacker, 'attacker', request.context?.format),
    canonicalizeBattlePokemonForCalcTool(request.defender, 'defender', request.context?.format),
  ]);
  const response = optimizeOffensiveSpread({
    ...request,
    attacker: attacker.pokemon,
    defender: defender.pokemon,
  });
  return mergeInputCorrectionsIntoResponse(response, [
    attacker.inputCorrections,
    defender.inputCorrections,
  ]);
}

export async function handleOptimizeSurvivalSpread(request: OptimizeSurvivalSpreadRequest) {
  const [defender, attacker] = await Promise.all([
    canonicalizeBattlePokemonForCalcTool(request.defender, 'defender', request.context?.format),
    canonicalizeBattlePokemonForCalcTool(request.attacker, 'attacker', request.context?.format),
  ]);
  const response = optimizeSurvivalSpread({
    ...request,
    defender: defender.pokemon,
    attacker: attacker.pokemon,
  });
  return mergeInputCorrectionsIntoResponse(response, [
    defender.inputCorrections,
    attacker.inputCorrections,
  ]);
}

export function registerDamageTools(server: McpServer): void {
  server.registerTool(
    'calculate_stats',
    {
      title: 'Calculate Pokémon Champions stats',
      description:
        'Calculate level-50 Pokémon Champions stats from species, nature, and SP; includes stage-modified stats when battle state is present. For user requests about current-format builds or Mega/formes, prefer get_pokemon_options first and pass its returned canonical Pokémon name/build; this tool also resolves unambiguous current-meta base-forme mistakes.',
      inputSchema: CalculateStatsRequestSchema,
      outputSchema: CalculateStatsResponseSchema,
    },
    async args => wrapTool(() => handleCalculateStats(args as CalculateStatsRequest)),
  );

  server.registerTool(
    'check_damage_matchup',
    {
      title: 'Check damage matchup',
      description:
        'Run a forward damage calculation with Pokémon Champions SP converted to standard EVs. For build questions, first call get_pokemon_options for each Pokémon and use the returned canonical forme/build when available; item choices are accepted as provided and are not legality-validated.',
      inputSchema: CheckDamageMatchupRequestSchema,
      outputSchema: CheckDamageMatchupResponseSchema,
    },
    async args => wrapTool(() => handleCheckDamageMatchup(args as CheckDamageMatchupRequest)),
  );

  server.registerTool(
    'optimize_offensive_spread',
    {
      title: 'Optimize offensive SP spread',
      description:
        'Find the minimum attacking SP and nature needed to reach a target damage ratio. Use canonical current-format formes from get_pokemon_options when the user asks about a Mega/forme.',
      inputSchema: OptimizeOffensiveSpreadRequestSchema,
      outputSchema: OptimizeOffensiveSpreadResponseSchema,
    },
    async args => wrapTool(() => handleOptimizeOffensiveSpread(args as OptimizeOffensiveSpreadRequest)),
  );

  server.registerTool(
    'optimize_survival_spread',
    {
      title: 'Optimize survival SP spread',
      description:
        'Find the minimum HP plus defense/special-defense SP allocation that survives a specified attack. Use canonical current-format formes from get_pokemon_options when the user asks about a Mega/forme.',
      inputSchema: OptimizeSurvivalSpreadRequestSchema,
      outputSchema: OptimizeSurvivalSpreadResponseSchema,
    },
    async args => wrapTool(() => handleOptimizeSurvivalSpread(args as OptimizeSurvivalSpreadRequest)),
  );
}
