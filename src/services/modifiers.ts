/**
 * Explicit battle-state and modifier resolution (Architecture.md section 4).
 *
 * Speed abilities/items are NOT speed stages. Numeric final Speed is delegated to
 * @smogon/calc's getFinalSpeed so we inherit mechanics such as Quick Feet, Slow Start,
 * Quick Powder, and modifier rounding. This module mirrors the relevant conditions only
 * to produce user-facing modifier breakdown text.
 */

import type { BattleContext, BattlePokemon, ModifierBreakdown, SideState } from '../types';
import {
  hasActiveEffect,
  hasAnyActiveEffect,
  hasFieldCondition,
  hasSideCondition,
  id,
} from '../utils/calc';

export type SpeedModifier = {
  label: string;
  numerator: number;
  denominator: number;
};

export function resolveSpeedModifiers(
  battlePokemon: BattlePokemon,
  context: BattleContext | undefined,
  side: 'attacker' | 'defender' = 'attacker',
): { modifiers: SpeedModifier[]; breakdown: ModifierBreakdown } {
  const modifiers: SpeedModifier[] = [];
  const breakdown: ModifierBreakdown = [];
  const pokemon = battlePokemon.pokemon;
  const state = battlePokemon.state;
  const abilityId = id(pokemon.ability);
  const itemId = id(pokemon.item);
  const sideState: SideState | undefined =
    side === 'attacker' ? context?.attackerSide : context?.defenderSide;
  const weather = context?.field?.weather;
  const terrain = context?.field?.terrain;
  const abilityAllowed = state?.abilityEffect !== 'inactive';
  const itemAllowed = state?.itemEffect !== 'inactive';
  const abilityForced = state?.abilityEffect === 'active';
  const itemForced = state?.itemEffect === 'active';

  // --- Side conditions ---
  if (hasSideCondition(sideState, 'tailwind')) {
    modifiers.push({ label: 'Tailwind', numerator: 2, denominator: 1 });
  }
  if (hasSideCondition(sideState, 'swamp')) {
    modifiers.push({ label: 'Swamp side condition', numerator: 1, denominator: 4 });
  }

  // --- Items ---
  if (itemAllowed && itemId === 'choicescarf') {
    modifiers.push({ label: 'Choice Scarf', numerator: 3, denominator: 2 });
  }
  if (itemAllowed && itemId === 'ironball') {
    modifiers.push({ label: 'Iron Ball', numerator: 1, denominator: 2 });
  }

  // --- Weather / terrain speed abilities ---
  if (abilityAllowed && abilityId === 'swiftswim' && (weather === 'rain' || abilityForced)) {
    modifiers.push({ label: 'Swift Swim', numerator: 2, denominator: 1 });
  }
  if (abilityAllowed && abilityId === 'chlorophyll' && (weather === 'sun' || abilityForced)) {
    modifiers.push({ label: 'Chlorophyll', numerator: 2, denominator: 1 });
  }
  if (abilityAllowed && abilityId === 'sandrush' && (weather === 'sand' || abilityForced)) {
    modifiers.push({ label: 'Sand Rush', numerator: 2, denominator: 1 });
  }
  if (abilityAllowed && abilityId === 'slushrush' && (weather === 'snow' || abilityForced)) {
    modifiers.push({ label: 'Slush Rush', numerator: 2, denominator: 1 });
  }
  if (abilityAllowed && abilityId === 'surgesurfer' && (terrain === 'electric' || abilityForced)) {
    modifiers.push({ label: 'Surge Surfer', numerator: 2, denominator: 1 });
  }
  if (
    abilityAllowed &&
    abilityId === 'quickfeet' &&
    state?.status &&
    state.status !== 'none'
  ) {
    modifiers.push({ label: 'Quick Feet', numerator: 3, denominator: 2 });
  }

  // --- History-based speed abilities (require explicit state unless forced) ---
  if (
    abilityAllowed &&
    abilityId === 'unburden' &&
    (abilityForced || hasAnyActiveEffect(state?.activeEffects, ['itemconsumed', 'unburden']))
  ) {
    modifiers.push({ label: 'Unburden', numerator: 2, denominator: 1 });
  }

  // --- Paradox speed boost (Protosynthesis / Quark Drive on Speed) ---
  const paradoxSpeedActive =
    abilityAllowed &&
    ['protosynthesis', 'quarkdrive'].includes(abilityId) &&
    (abilityForced ||
      hasAnyActiveEffect(state?.activeEffects, ['boosterspeed', `${abilityId}speed`, `${abilityId}spe`]));
  if (paradoxSpeedActive) {
    modifiers.push({ label: pokemon.ability ?? 'Paradox speed boost', numerator: 3, denominator: 2 });
  } else if (
    itemAllowed &&
    itemId === 'boosterenergy' &&
    (itemForced || hasActiveEffect(state?.activeEffects, 'boosterspeed'))
  ) {
    // Booster Energy can trigger the Paradox boost even if we couldn't infer it from the ability state.
    modifiers.push({ label: 'Booster Energy speed boost', numerator: 3, denominator: 2 });
  }

  // --- Status ---
  if (state?.status === 'paralysis' && !(abilityAllowed && abilityId === 'quickfeet')) {
    modifiers.push({ label: 'Paralysis', numerator: 1, denominator: 2 });
  }

  for (const modifier of modifiers) {
    breakdown.push(`${modifier.label}: x${modifier.numerator}/${modifier.denominator}.`);
  }

  if (hasFieldCondition(context, 'trickroom')) {
    breakdown.push(
      'Trick Room active: final Speed is unchanged, but the lower-Speed Pokémon moves first.',
    );
  }

  return { modifiers, breakdown };
}

/** Apply rational modifiers as a single floored division to avoid float drift. */
export function applyRationalModifiers(value: number, modifiers: SpeedModifier[]): number {
  let numerator = value;
  let denominator = 1;
  for (const modifier of modifiers) {
    numerator *= modifier.numerator;
    denominator *= modifier.denominator;
  }
  return Math.floor(numerator / denominator);
}
