/**
 * Deterministic speed calculation engine (Architecture.md sections 3.7, 4.3).
 *
 * Speed is computed in layers:
 *   rawSpeed   -> Champions SP formula
 *   stagedSpeed -> apply Speed stage (-6..+6)
 *   finalSpeed  -> apply non-stage modifiers (Tailwind, Swift Swim, Choice Scarf, paralysis, ...)
 */

import type {
  BattleContext,
  BattlePokemon,
  GetSpeedTiersRequest,
  GetSpeedTiersResponse,
  InputCorrection,
  ModifierBreakdown,
  SpeedTierEntry,
} from '../types';
import { getFinalSpeed } from '@smogon/calc/dist/mechanics/util.js';
import { resolveSpeedModifiers } from './modifiers';
import {
  applyStatStage,
  calculateChampionStats,
  clampBoost,
  combineInputCorrections,
  inputCorrectionBreakdown,
  resolveBattlePokemonAbility,
  toCalcField,
  toCalcPokemon,
} from '../utils/calc';
import { getMetaSnapshot } from './meta-source';
import { resolveShowdownSpecies, squashedKey } from '../utils/pokemon-name';

export type FinalSpeedResult = {
  rawSpeed: number;
  stagedSpeed: number;
  finalSpeed: number;
  modifierBreakdown: ModifierBreakdown;
  inputCorrections?: InputCorrection[];
};

/**
 * Fallback spread used only when the meta provider has no popular spread for a Pokémon.
 * For Speed tiers the nature is not meaningful on its own: any Speed-boosting nature
 * (Timid/Jolly/Hasty/Naive) yields an identical Speed stat, so this just represents a
 * generic max-Speed investment so the Pokémon still appears in the tier list.
 */
const DEFAULT_MAX_SPEED_SPREAD = {
  nature: 'Jolly',
  sp: { hp: 0, atk: 0, def: 0, spa: 0, spd: 2, spe: 32 },
} as const;

/**
 * Extra contextual Speed-tier rows generated per entry. These are presentation defaults,
 * not mechanics: we surface the most common Speed-altering team condition(s) alongside the
 * baseline. Add entries here to expose more benchmarks (e.g. paralysis) without touching
 * the loop below.
 */
const SPEED_TIER_CONTEXT_VARIANTS: Array<{ label: string; context: BattleContext }> = [
  {
    label: 'under Tailwind',
    context: { attackerSide: { sideConditions: [{ id: 'tailwind', source: 'side' }] } },
  },
];

export function calculateFinalSpeed(
  battlePokemon: BattlePokemon,
  context?: BattleContext,
  side: 'attacker' | 'defender' = 'attacker',
  abilityPath = 'pokemon.pokemon.ability',
): FinalSpeedResult {
  const abilityResolution = resolveBattlePokemonAbility(battlePokemon, abilityPath);
  const resolvedPokemon = abilityResolution.pokemon;
  const inputCorrections = combineInputCorrections(abilityResolution.inputCorrections);
  const rawSpeed = calculateChampionStats(resolvedPokemon).spe;
  const speedStage = clampBoost(resolvedPokemon.state?.boosts?.spe ?? 0);
  const stagedSpeed = applyStatStage(rawSpeed, speedStage);
  const { breakdown } = resolveSpeedModifiers(resolvedPokemon, context, side);
  const field = toCalcField(context, side === 'attacker' ? resolvedPokemon : undefined);
  const calcPokemon = toCalcPokemon(
    resolvedPokemon,
    side,
    side === 'attacker' ? context?.attackerSide : context?.defenderSide,
  );
  const finalSpeed = getFinalSpeed(
    calcPokemon.gen,
    calcPokemon,
    field,
    side === 'attacker' ? field.attackerSide : field.defenderSide,
  );

  const modifierBreakdown: ModifierBreakdown = [
    `Raw Speed from Pokémon Champions SP formula: ${rawSpeed}.`,
    ...inputCorrectionBreakdown(inputCorrections),
  ];
  if (speedStage !== 0) {
    modifierBreakdown.push(
      `Speed stage ${speedStage >= 0 ? '+' : ''}${speedStage}: ${rawSpeed} -> ${stagedSpeed}.`,
    );
  }
  modifierBreakdown.push(...breakdown);
  modifierBreakdown.push(`Final Speed: ${finalSpeed}.`);

  return {
    rawSpeed,
    stagedSpeed,
    finalSpeed,
    modifierBreakdown,
    ...(inputCorrections ? { inputCorrections } : {}),
  };
}

export async function getSpeedTiers(
  request: GetSpeedTiersRequest = {},
): Promise<GetSpeedTiersResponse> {
  const limit = request.limit ?? 50;
  const snapshot = await getMetaSnapshot({ limit: Math.max(limit, 20), includeBuilds: true });
  const entries: SpeedTierEntry[] = [];

  for (const summary of snapshot.pokemon) {
    const spreads = summary.popularSpreads?.length
      ? summary.popularSpreads
      : [DEFAULT_MAX_SPEED_SPREAD];
    for (const spread of spreads.slice(0, 2)) {
      const pokemon: BattlePokemon = {
        pokemon: {
          name: summary.pokemon,
          nature: spread.nature,
          sp: spread.sp,
          item: summary.popularItems?.[0]?.item,
          ability: summary.popularAbilities?.[0]?.ability,
        },
      };
      const result = calculateFinalSpeed(pokemon);
      entries.push({
        pokemon,
        rawSpeed: result.rawSpeed,
        finalSpeed: result.finalSpeed,
        description: `${summary.pokemon} ${spread.nature} ${spread.sp.spe ?? 0} Spe SP`,
        modifierBreakdown: result.modifierBreakdown,
        source: snapshot.source,
      });

      if (request.includeModifiers !== false) {
        for (const variant of SPEED_TIER_CONTEXT_VARIANTS) {
          const variantResult = calculateFinalSpeed(pokemon, variant.context);
          entries.push({
            pokemon,
            context: variant.context,
            rawSpeed: variantResult.rawSpeed,
            finalSpeed: variantResult.finalSpeed,
            description: `${summary.pokemon} ${spread.nature} ${spread.sp.spe ?? 0} Spe SP ${variant.label}`,
            modifierBreakdown: variantResult.modifierBreakdown,
            source: snapshot.source,
          });
        }
      }
    }
  }

  const filtered = applyFilters(entries, request);
  filtered.sort(
    (a, b) =>
      b.finalSpeed - a.finalSpeed ||
      b.rawSpeed - a.rawSpeed ||
      a.description.localeCompare(b.description),
  );

  return { generatedAt: new Date().toISOString(), tiers: filtered.slice(0, limit) };
}

function applyFilters(entries: SpeedTierEntry[], request: GetSpeedTiersRequest): SpeedTierEntry[] {
  let filtered = entries;
  for (const filter of request.filters ?? []) {
    const values = 'values' in filter ? filter.values.map(v => v.toLowerCase()) : [];
    if (filter.type === 'pokemon') {
      // Accept any common spelling: compare canonical Showdown names when both sides
      // resolve, otherwise fall back to squashed-key comparison.
      const wantedKeys = filter.values.map(
        value => squashedKey(resolveShowdownSpecies(value)?.name ?? value),
      );
      filtered = filtered.filter(entry => {
        const entryName = entry.pokemon.pokemon.name;
        const entryKey = squashedKey(resolveShowdownSpecies(entryName)?.name ?? entryName);
        return wantedKeys.includes(entryKey);
      });
    } else if (filter.type === 'item') {
      filtered = filtered.filter(
        entry =>
          entry.pokemon.pokemon.item && values.includes(entry.pokemon.pokemon.item.toLowerCase()),
      );
    } else if (filter.type === 'ability') {
      filtered = filtered.filter(
        entry =>
          entry.pokemon.pokemon.ability &&
          values.includes(entry.pokemon.pokemon.ability.toLowerCase()),
      );
    } else if (filter.type === 'effect') {
      const ids = filter.ids.map(v => v.toLowerCase());
      filtered = filtered.filter(entry =>
        entry.modifierBreakdown.some(line =>
          ids.some(effect => line.toLowerCase().includes(effect)),
        ),
      );
    } else if (filter.type === 'tag') {
      filtered = filtered.filter(entry =>
        values.some(value => entry.description.toLowerCase().includes(value)),
      );
    }
  }
  return filtered;
}
