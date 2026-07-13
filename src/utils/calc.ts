/**
 * Calculation engine wrapper.
 *
 * Architecture.md names `@pkmn/dmg` as the damage math dependency, but that package is not
 * published on npm. We use `@smogon/calc` (the same Pokémon Showdown damage math, maintained
 * and public) and preserve the Pokémon Champions rules described in section 1.1:
 *   - Level fixed at 50
 *   - IVs fixed at 31
 *   - SP range 0-32 per stat, max 66 total
 *   - 1 SP = 8 EVs (so the standard Showdown formulas hold)
 */

import {
  calculate,
  Field,
  Move,
  Pokemon,
  Side,
  Stats,
} from '@smogon/calc/dist/adaptable.js';
import {
  gen,
  id,
  requireShowdownSpecies,
  resolveShowdownSpecies,
  UserInputError,
} from './pokemon-name';
import type {
  BattleContext,
  BattleEffect,
  BattlePokemon,
  CalculateStatsResponse,
  CheckDamageMatchupResponse,
  InputCorrection,
  ModifierBreakdown,
  SideState,
  StatID,
  StatTable,
  Terrain,
  Weather,
} from '../types';

export { gen, GENERATION, id, UserInputError } from './pokemon-name';

export const LEVEL = 50;
export const IV = 31;
export const MAX_STAT_SP = 32;
export const MAX_TOTAL_SP = 66;
export const SP_TO_EV = 8;
export const STATS: StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export function emptyStats(value = 0): StatTable {
  return { hp: value, atk: value, def: value, spa: value, spd: value, spe: value };
}

const ABILITY_CHANGE_EFFECT_IDS = [
  'abilitychanged',
  'abilitychange',
  'skillswap',
  'worryseed',
  'entrainment',
  'simplebeam',
  'roleplay',
  'trace',
  'mummy',
  'wanderingspirit',
  'receiver',
  'powerofalchemy',
  'doodle',
] as const;

export type MegaAbilityInfo = {
  species: string;
  ability: string;
};

export type MegaStoneInfo = MegaAbilityInfo & {
  fromSpecies: string;
  item: string;
};

export type AbilityResolution = {
  pokemon: BattlePokemon;
  inputCorrections: InputCorrection[];
  megaAbility?: MegaAbilityInfo;
};

/** Return the fixed ability for a Mega forme, if `name` resolves to one. */
export function getCanonicalMegaAbility(name: string): MegaAbilityInfo | undefined {
  const species = resolveShowdownSpecies(name);
  if (!species || !/-Mega(?:-|$)/.test(species.name)) return undefined;
  const ability = species.abilities?.['0'];
  return ability ? { species: species.name, ability } : undefined;
}

/** Return the Mega forme triggered by the held Mega Stone, if the base forme is compatible. */
export function getHeldMegaStoneForme(battlePokemon: BattlePokemon): MegaStoneInfo | undefined {
  if (battlePokemon.state?.itemEffect === 'inactive') return undefined;
  const itemName = battlePokemon.pokemon.item;
  if (!itemName) return undefined;

  const species = resolveShowdownSpecies(battlePokemon.pokemon.name);
  if (!species) return undefined;
  const item = gen.items.get(id(itemName) as never);
  if (!item?.exists) return undefined;

  const megaStone = (item as unknown as { megaStone?: string | Record<string, string> }).megaStone;
  if (!megaStone) return undefined;

  const megaSpeciesName =
    typeof megaStone === 'string'
      ? megaStone
      : megaStone[species.name] ?? megaStone[species.baseSpecies] ?? undefined;
  if (!megaSpeciesName) return undefined;

  const megaSpecies = resolveShowdownSpecies(megaSpeciesName);
  const ability = megaSpecies?.abilities?.['0'];
  if (!megaSpecies || !ability) return undefined;

  return {
    fromSpecies: species.name,
    species: megaSpecies.name,
    ability,
    item: item.name,
  };
}

export function isAbilityBattleChanged(battlePokemon: BattlePokemon): boolean {
  const source = battlePokemon.pokemon.abilitySource;
  if (source === 'battle-changed' || source === 'manual') return true;
  const effects = [
    ...(battlePokemon.state?.activeEffects ?? []),
    ...(battlePokemon.state?.volatileConditions ?? []),
  ];
  return hasAnyActiveEffect(effects, [...ABILITY_CHANGE_EFFECT_IDS]);
}

/**
 * Normalize `pokemon.name` to the canonical Showdown species name, accepting any common
 * spelling (Showdown aliases, PokeAPI/provider slugs like `basculegion-female`, etc.).
 * Throws a UserInputError with did-you-mean suggestions for unresolvable names.
 */
export function normalizeBattlePokemonName(
  battlePokemon: BattlePokemon,
  namePath: string,
): { pokemon: BattlePokemon; inputCorrections: InputCorrection[] } {
  const inputName = battlePokemon.pokemon.name;
  const species = requireShowdownSpecies(inputName);
  // Same dex ID means only cosmetic differences (case/spacing); rename silently.
  if (id(inputName) === species.id) {
    if (inputName === species.name) return { pokemon: battlePokemon, inputCorrections: [] };
    return {
      pokemon: { ...battlePokemon, pokemon: { ...battlePokemon.pokemon, name: species.name } },
      inputCorrections: [],
    };
  }
  const resolved: BattlePokemon = {
    ...battlePokemon,
    pokemon: { ...battlePokemon.pokemon, name: species.name },
  };
  const correction: InputCorrection = {
    code: 'speciesNameNormalized',
    path: namePath,
    from: inputName,
    to: species.name,
    reason: `'${inputName}' was resolved to canonical species name '${species.name}'.`,
  };
  return { pokemon: resolved, inputCorrections: [correction] };
}

export function resolveBattlePokemonAbility(
  battlePokemon: BattlePokemon,
  abilityPath = 'pokemon.pokemon.ability',
): AbilityResolution {
  const namePath = abilityPath.replace(/\.ability$/, '.name');
  const nameResolution = normalizeBattlePokemonName(battlePokemon, namePath);
  let normalized = nameResolution.pokemon;
  const corrections = [...nameResolution.inputCorrections];

  const megaStoneForme = getHeldMegaStoneForme(normalized);
  if (megaStoneForme && normalized.pokemon.name !== megaStoneForme.species) {
    normalized = {
      ...normalized,
      pokemon: {
        ...normalized.pokemon,
        name: megaStoneForme.species,
      },
    };
    corrections.push({
      code: 'megaStoneFormeResolved',
      path: namePath,
      from: megaStoneForme.fromSpecies,
      to: megaStoneForme.species,
      reason: `${megaStoneForme.item} Mega Evolves ${megaStoneForme.fromSpecies} into ${megaStoneForme.species}; using the Mega forme for calculation.`,
    });
  }

  const megaAbility = getCanonicalMegaAbility(normalized.pokemon.name);
  if (!megaAbility) return { pokemon: normalized, inputCorrections: corrections };

  const currentAbility = normalized.pokemon.ability;
  if (id(currentAbility) === id(megaAbility.ability) || isAbilityBattleChanged(normalized)) {
    return { pokemon: normalized, inputCorrections: corrections, megaAbility };
  }

  const resolved: BattlePokemon = {
    ...normalized,
    pokemon: {
      ...normalized.pokemon,
      name: megaAbility.species,
      ability: megaAbility.ability,
      abilitySource: 'mega-default',
    },
  };
  const correction: InputCorrection = {
    code: 'megaAbilityOverride',
    path: abilityPath,
    from: currentAbility ?? null,
    to: megaAbility.ability,
    reason: `${megaAbility.species} has fixed Mega forme ability ${megaAbility.ability}. Mark abilitySource='battle-changed' or 'manual' to preserve an intentional in-battle ability change.`,
  };
  return { pokemon: resolved, inputCorrections: [...corrections, correction], megaAbility };
}

export function combineInputCorrections(
  ...correctionGroups: Array<InputCorrection[] | undefined>
): InputCorrection[] | undefined {
  const corrections = correctionGroups.flatMap(group => group ?? []);
  return corrections.length ? corrections : undefined;
}

export function inputCorrectionBreakdown(corrections: InputCorrection[] | undefined): string[] {
  return (corrections ?? []).map(
    correction =>
      `Input correction (${correction.code}) at ${correction.path}: ${String(correction.from)} -> ${String(correction.to)}. ${correction.reason}`,
  );
}

/** Validate SP and return a complete 6-stat SP table. Enforces 0-32 per stat and <=66 total. */
export function completeSP(sp: Partial<StatTable> | undefined): StatTable {
  const result = emptyStats(0);
  for (const stat of STATS) {
    const value = sp?.[stat] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > MAX_STAT_SP) {
      throw new UserInputError(
        `SP for ${stat} must be an integer from 0 to ${MAX_STAT_SP}; received ${value}.`,
      );
    }
    result[stat] = value;
  }
  const total = totalSP(result);
  if (total > MAX_TOTAL_SP) {
    throw new UserInputError(`Total SP must be at most ${MAX_TOTAL_SP}; received ${total}.`);
  }
  return result;
}

/** Convert SP (0-32) to Showdown EVs (1 SP = 8 EV). */
export function spToEVs(sp: Partial<StatTable> | undefined): StatTable {
  const completed = completeSP(sp);
  return Object.fromEntries(STATS.map(stat => [stat, completed[stat] * SP_TO_EV])) as StatTable;
}

export function totalSP(sp: Partial<StatTable> | undefined): number {
  return STATS.reduce((sum, stat) => sum + (sp?.[stat] ?? 0), 0);
}

export function totalSPExcluding(sp: Partial<StatTable> | undefined, excluded: StatID[]): number {
  const excludedSet = new Set<StatID>(excluded);
  return STATS.reduce(
    (sum, stat) => sum + (excludedSet.has(stat) ? 0 : (sp?.[stat] ?? 0)),
    0,
  );
}

export function getSpeciesBaseStats(name: string): StatTable {
  const species = requireShowdownSpecies(name);
  return { ...(species.baseStats as StatTable) };
}

/** Resolve a move by name, throwing a clear error for unknown moves. */
export function getMove(name: string): Move {
  const resolved = gen.moves.get(id(name) as never);
  if (!resolved) {
    throw new UserInputError(`Unknown move: ${name}.`);
  }
  return new Move(gen, resolved.name);
}

export function moveCategory(moveName: string): 'Physical' | 'Special' | 'Status' {
  return getMove(moveName).category as 'Physical' | 'Special' | 'Status';
}

/**
 * Calculate raw Champions stats for a Pokémon.
 *
 * Stat = floor(Base + 20.5 + SP) * Nature   (non-HP)
 * HP   = floor(Base + 75.5 + SP)
 *
 * These are exactly what `calcStat` produces with level 50, IV 31, and EV = 8 * SP.
 */
export function calculateChampionStats(pokemon: BattlePokemon): StatTable {
  const baseStats = getSpeciesBaseStats(pokemon.pokemon.name);
  const sp = completeSP(pokemon.pokemon.sp);
  const stats = emptyStats();
  for (const stat of STATS) {
    stats[stat] = Stats.calcStat(
      gen,
      stat,
      baseStats[stat],
      IV,
      sp[stat] * SP_TO_EV,
      LEVEL,
      pokemon.pokemon.nature,
    );
  }
  return stats;
}

export function calculateStatsResponse(
  pokemon: BattlePokemon,
  context?: BattleContext,
): CalculateStatsResponse {
  const abilityResolution = resolveBattlePokemonAbility(pokemon, 'pokemon.pokemon.ability');
  const resolvedPokemon = abilityResolution.pokemon;
  const inputCorrections = combineInputCorrections(abilityResolution.inputCorrections);
  const rawStats = calculateChampionStats(resolvedPokemon);
  const modifiedStats = { ...rawStats };
  const breakdown: ModifierBreakdown = [
    `Level fixed at ${LEVEL}; IVs fixed at ${IV}; SP converted to EVs at 1 SP = ${SP_TO_EV} EVs.`,
    ...inputCorrectionBreakdown(inputCorrections),
  ];

  const boosts = resolvedPokemon.state?.boosts ?? {};
  for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
    const boost = clampBoost(boosts[stat] ?? 0);
    if (boost !== 0) {
      modifiedStats[stat] = applyStatStage(rawStats[stat], boost);
      breakdown.push(
        `${stat} stage ${boost >= 0 ? '+' : ''}${boost}: ${rawStats[stat]} -> ${modifiedStats[stat]}.`,
      );
    }
  }

  if (resolvedPokemon.state?.status === 'paralysis') {
    breakdown.push(
      'Paralysis is applied as a final-speed modifier, not as a raw Speed stat change.',
    );
  }

  if (hasFieldCondition(context, 'trickroom')) {
    breakdown.push(
      'Trick Room is active; it affects move order but does not change the displayed Speed stat.',
    );
  }

  return {
    ...(inputCorrections ? { inputCorrections } : {}),
    rawStats,
    modifiedStats,
    modifierBreakdown: breakdown,
  };
}

export function clampBoost(boost: number): number {
  if (!Number.isFinite(boost)) return 0;
  return Math.max(-6, Math.min(6, Math.trunc(boost)));
}

/** Apply a stat stage (-6..+6) using deterministic integer game math. */
export function applyStatStage(stat: number, boost: number): number {
  const stage = clampBoost(boost);
  if (stage >= 0) return Math.floor((stat * (2 + stage)) / 2);
  return Math.floor((stat * 2) / (2 - stage));
}

/* --- Battle-effect helpers --- */

export function hasActiveEffect(effects: BattleEffect[] | undefined, effectId: string): boolean {
  const wanted = id(effectId);
  return (effects ?? []).some(effect => (effect.active ?? true) && id(effect.id) === wanted);
}

export function hasAnyActiveEffect(
  effects: BattleEffect[] | undefined,
  effectIds: string[],
): boolean {
  return effectIds.some(effectId => hasActiveEffect(effects, effectId));
}

export function hasSideCondition(side: SideState | undefined, conditionId: string): boolean {
  return hasActiveEffect(side?.sideConditions, conditionId);
}

export function hasFieldCondition(context: BattleContext | undefined, conditionId: string): boolean {
  return hasActiveEffect(context?.field?.fieldConditions, conditionId);
}

/* --- Translation into @smogon/calc objects --- */

export function toCalcPokemon(
  battlePokemon: BattlePokemon,
  role: 'attacker' | 'defender' = 'attacker',
  sideState?: SideState,
): Pokemon {
  const resolvedBattlePokemon = resolveBattlePokemonAbility(battlePokemon).pokemon;
  const state = resolvedBattlePokemon.state;
  const sp = completeSP(resolvedBattlePokemon.pokemon.sp);
  const abilityEffect = state?.abilityEffect ?? 'auto';
  const itemEffect = state?.itemEffect ?? 'auto';
  const activeEffects = state?.activeEffects ?? [];

  const gender =
    resolvedBattlePokemon.pokemon.gender === 'male'
      ? 'M'
      : resolvedBattlePokemon.pokemon.gender === 'female'
        ? 'F'
        : resolvedBattlePokemon.pokemon.gender === 'genderless'
          ? 'N'
          : undefined;

  const item = itemEffect === 'inactive' ? undefined : resolvedBattlePokemon.pokemon.item;
  const disabledItem = itemEffect === 'inactive' ? resolvedBattlePokemon.pokemon.item : undefined;
  const ability = abilityEffect === 'inactive' ? undefined : resolvedBattlePokemon.pokemon.ability;

  const calcPokemon = new Pokemon(gen, resolvedBattlePokemon.pokemon.name, {
    level: LEVEL,
    nature: resolvedBattlePokemon.pokemon.nature as any,
    ability: ability as any,
    abilityOn:
      abilityEffect === 'active' ||
      (abilityEffect !== 'inactive' &&
        id(resolvedBattlePokemon.pokemon.ability) === 'unburden' &&
        hasAnyActiveEffect(activeEffects, ['itemconsumed', 'unburden'])) ||
      hasAnyActiveEffect(activeEffects, [resolvedBattlePokemon.pokemon.ability ?? '']),
    item: item as any,
    gender,
    teraType: resolvedBattlePokemon.pokemon.teraType as never,
    alliesFainted: nonNegativeInteger(
      resolvedBattlePokemon.state?.alliesFainted ?? sideState?.alliesFainted,
    ),
    isDynamaxed:
      resolvedBattlePokemon.pokemon.dynamax === 'dynamax' ||
      resolvedBattlePokemon.pokemon.dynamax === 'gigantamax',
    evs: spToEVs(sp),
    ivs: emptyStats(IV),
    boosts: {
      atk: clampBoost(state?.boosts?.atk ?? 0),
      def: clampBoost(state?.boosts?.def ?? 0),
      spa: clampBoost(state?.boosts?.spa ?? 0),
      spd: clampBoost(state?.boosts?.spd ?? 0),
      spe: clampBoost(state?.boosts?.spe ?? 0),
    },
    status: mapStatus(state?.status),
  });

  if (disabledItem) {
    calcPokemon.disabledItem = disabledItem as never;
  }

  const boostedStat = inferBoostedStat(activeEffects);
  if (boostedStat) calcPokemon.boostedStat = boostedStat;

  // @smogon/calc resolves many static effects from names, but history-based switches
  // (e.g. Flash Fire already triggered) must be forced from explicit battle state.
  if (role === 'attacker' && hasAnyActiveEffect(activeEffects, ['flashfire'])) {
    calcPokemon.abilityOn = true;
  }

  return calcPokemon;
}

function inferBoostedStat(
  effects: BattleEffect[],
): 'atk' | 'def' | 'spa' | 'spd' | 'spe' | undefined {
  const mapping: Record<string, 'atk' | 'def' | 'spa' | 'spd' | 'spe'> = {
    boosteratk: 'atk', boosterattack: 'atk', protosynthesisatk: 'atk', quarkdriveatk: 'atk',
    boosterdef: 'def', boosterdefense: 'def', protosynthesisdef: 'def', quarkdrivedef: 'def',
    boosterspa: 'spa', boosterspecialattack: 'spa', protosynthesisspa: 'spa', quarkdrivespa: 'spa',
    boosterspd: 'spd', boosterspecialdefense: 'spd', protosynthesisspd: 'spd', quarkdrivespd: 'spd',
    boosterspe: 'spe', boosterspeed: 'spe', protosynthesisspe: 'spe', quarkdrivespe: 'spe',
  };
  for (const effect of effects) {
    if (effect.active ?? true) {
      const stat = mapping[id(effect.id)];
      if (stat) return stat;
    }
  }
  return undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function cappedBattleCount(value: number | undefined, max: number): number {
  return Math.min(max, nonNegativeInteger(value) ?? 0);
}

function mapStatus(
  status: string | undefined,
): '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox' {
  switch (status) {
    case 'burn':
      return 'brn';
    case 'paralysis':
      return 'par';
    case 'sleep':
      return 'slp';
    case 'freeze':
      return 'frz';
    case 'poison':
      return 'psn';
    case 'toxic':
      return 'tox';
    default:
      return '';
  }
}

export function toCalcField(context?: BattleContext, attacker?: BattlePokemon): Field {
  const attackerSide = toCalcSide(context?.attackerSide);
  const defenderSide = toCalcSide(context?.defenderSide);

  if (attacker && hasAnyActiveEffect(attacker.state?.activeEffects, ['helpinghand'])) {
    attackerSide.isHelpingHand = true;
  }

  return new Field({
    gameType: context?.format === 'singles' ? 'Singles' : 'Doubles',
    weather: mapWeather(context?.field?.weather),
    terrain: mapTerrain(context?.field?.terrain),
    isGravity: hasFieldCondition(context, 'gravity'),
    isMagicRoom: hasFieldCondition(context, 'magicroom'),
    isWonderRoom: hasFieldCondition(context, 'wonderroom'),
    attackerSide,
    defenderSide,
  });
}

function toCalcSide(sideState?: SideState): Side {
  return new Side({
    isTailwind: hasSideCondition(sideState, 'tailwind'),
    isReflect: hasSideCondition(sideState, 'reflect'),
    isLightScreen:
      hasSideCondition(sideState, 'lightscreen') || hasSideCondition(sideState, 'light-screen'),
    isAuroraVeil:
      hasSideCondition(sideState, 'auroraveil') || hasSideCondition(sideState, 'aurora-veil'),
    isProtected:
      hasSideCondition(sideState, 'protect') || hasSideCondition(sideState, 'protected'),
    isFriendGuard: hasSideCondition(sideState, 'friendguard'),
    isHelpingHand: hasSideCondition(sideState, 'helpinghand'),
    isBattery: hasSideCondition(sideState, 'battery'),
    isPowerSpot: hasSideCondition(sideState, 'powerspot'),
    isSteelySpirit: hasSideCondition(sideState, 'steelyspirit'),
  });
}

function mapWeather(weather: Weather | undefined): 'Sun' | 'Rain' | 'Sand' | 'Snow' | undefined {
  switch (weather) {
    case 'sun':
      return 'Sun';
    case 'rain':
      return 'Rain';
    case 'sand':
      return 'Sand';
    case 'snow':
      return 'Snow';
    default:
      return undefined;
  }
}

function mapTerrain(
  terrain: Terrain | undefined,
): 'Electric' | 'Grassy' | 'Misty' | 'Psychic' | undefined {
  switch (terrain) {
    case 'electric':
      return 'Electric';
    case 'grassy':
      return 'Grassy';
    case 'misty':
      return 'Misty';
    case 'psychic':
      return 'Psychic';
    default:
      return undefined;
  }
}

/* --- Forward damage calculation --- */

export function calculateDamageMatchup(request: {
  attacker: BattlePokemon;
  defender: BattlePokemon;
  move: string;
  context?: BattleContext;
}): CheckDamageMatchupResponse {
  const attackerAbility = resolveBattlePokemonAbility(request.attacker, 'attacker.pokemon.ability');
  const defenderAbility = resolveBattlePokemonAbility(request.defender, 'defender.pokemon.ability');
  const inputCorrections = combineInputCorrections(
    attackerAbility.inputCorrections,
    defenderAbility.inputCorrections,
  );
  const resolvedRequest = {
    ...request,
    attacker: attackerAbility.pokemon,
    defender: defenderAbility.pokemon,
  };
  const attacker = toCalcPokemon(resolvedRequest.attacker, 'attacker', request.context?.attackerSide);
  const defender = toCalcPokemon(resolvedRequest.defender, 'defender', request.context?.defenderSide);
  const move = getMove(request.move);
  const moveHistoryNotes = applyBattleHistoryMoveBasePower(move, resolvedRequest);

  if (hasAnyActiveEffect(resolvedRequest.attacker.state?.activeEffects, ['crit', 'criticalhit'])) {
    move.isCrit = true;
  }

  const field = toCalcField(request.context, resolvedRequest.attacker);
  const result = calculate(gen, attacker, defender, move, field);
  const rolls = flattenDamage(result.damage);
  const range = result.range();
  const maxHP = defender.maxHP();
  const damageRollRatios = rolls.map(roll => roundRatio(roll / maxHP));
  const koChance =
    rolls.length === 0 ? 0 : rolls.filter(roll => roll >= maxHP).length / rolls.length;

  return {
    ...(inputCorrections ? { inputCorrections } : {}),
    damageRange: [roundRatio(range[0] / maxHP), roundRatio(range[1] / maxHP)],
    damageRolls: rolls,
    damageRollRatios,
    koChance: roundRatio(koChance),
    modifierBreakdown: buildDamageBreakdown(
      resolvedRequest,
      attacker,
      defender,
      move.name,
      inputCorrections,
      moveHistoryNotes,
    ),
    description: result.fullDesc('%', false),
  };
}

function applyBattleHistoryMoveBasePower(
  move: Move,
  request: { attacker: BattlePokemon; context?: BattleContext },
): string[] {
  const notes: string[] = [];
  if (move.name === 'Last Respects') {
    const alliesFainted = cappedBattleCount(
      request.attacker.state?.alliesFainted ?? request.context?.attackerSide?.alliesFainted,
      100,
    );
    const basePower = 50 + 50 * alliesFainted;
    setMoveBasePower(move, basePower);
    notes.push(
      `Last Respects effective base power: ${basePower} (${alliesFainted} allied faint event${alliesFainted === 1 ? '' : 's'}).`,
    );
  }
  if (move.name === 'Rage Fist') {
    const timesHit = cappedBattleCount(request.attacker.state?.timesHitByDirectDamage, 6);
    const basePower = 50 + 50 * timesHit;
    setMoveBasePower(move, basePower);
    notes.push(
      `Rage Fist effective base power: ${basePower} (${timesHit} direct-damage hit${timesHit === 1 ? '' : 's'} taken).`,
    );
  }
  return notes;
}

function setMoveBasePower(move: Move, basePower: number): void {
  move.bp = basePower;
  move.overrides = {
    ...(move.overrides ?? {}),
    basePower,
  } as never;
}

function buildDamageBreakdown(
  request: { attacker: BattlePokemon; defender: BattlePokemon; context?: BattleContext },
  attacker: Pokemon,
  defender: Pokemon,
  moveName: string,
  inputCorrections?: InputCorrection[],
  moveHistoryNotes: string[] = [],
): ModifierBreakdown {
  const breakdown: ModifierBreakdown = [
    `${attacker.name} and ${defender.name} calculated at level ${LEVEL} with ${IV} IVs and SP converted to EVs.`,
    `Move resolved by @smogon/calc as ${moveName}.`,
    ...moveHistoryNotes,
    ...inputCorrectionBreakdown(inputCorrections),
  ];
  const context = request.context;
  if (context?.format) breakdown.push(`Battle format: ${context.format}.`);
  const attackerAlliesFainted =
    request.attacker.state?.alliesFainted ?? context?.attackerSide?.alliesFainted;
  if (attackerAlliesFainted !== undefined) {
    breakdown.push(`Attacker side allied faint events: ${nonNegativeInteger(attackerAlliesFainted) ?? 0}.`);
  }
  if (context?.field?.weather && context.field.weather !== 'none') {
    breakdown.push(`Weather: ${context.field.weather}.`);
  }
  if (context?.field?.terrain && context.field.terrain !== 'none') {
    breakdown.push(`Terrain: ${context.field.terrain}.`);
  }
  for (const [label, side] of [
    ['attacker side', context?.attackerSide],
    ['defender side', context?.defenderSide],
  ] as const) {
    const conditions =
      side?.sideConditions?.filter(effect => effect.active ?? true).map(effect => effect.id) ?? [];
    if (conditions.length) breakdown.push(`${label}: ${conditions.join(', ')}.`);
  }
  const attackerEffects =
    request.attacker.state?.activeEffects
      ?.filter(effect => effect.active ?? true)
      .map(effect => effect.id) ?? [];
  const defenderEffects =
    request.defender.state?.activeEffects
      ?.filter(effect => effect.active ?? true)
      .map(effect => effect.id) ?? [];
  if (attackerEffects.length) breakdown.push(`Attacker active effects: ${attackerEffects.join(', ')}.`);
  if (defenderEffects.length) breakdown.push(`Defender active effects: ${defenderEffects.join(', ')}.`);
  return breakdown;
}

function flattenDamage(damage: number | number[] | number[][]): number[] {
  if (typeof damage === 'number') return [damage];
  const out: number[] = [];
  for (const entry of damage) {
    if (Array.isArray(entry)) out.push(...flattenDamage(entry));
    else out.push(entry);
  }
  return out;
}

export function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
