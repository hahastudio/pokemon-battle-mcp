/**
 * Inverse SP solver module (Architecture.md section 2.3).
 *
 * SP only ranges 0-32 per stat, so the search space per stat is 33 options. The solvers do an
 * exhaustive search over allowed natures and SP values and return the minimum SP allocation that
 * satisfies the requested constraint. If no allocation satisfies it under the budget, the best
 * effort is returned with `isFeasibleUnderBudget: false`.
 */

import type {
  BattlePokemon,
  DamageRatioMode,
  OptimizeOffensiveSpreadRequest,
  OptimizeOffensiveSpreadResponse,
  OptimizeSpeedSpreadRequest,
  OptimizeSpeedSpreadResponse,
  OptimizeSurvivalSpreadRequest,
  OptimizeSurvivalSpreadResponse,
  Relation,
  StatID,
} from '../types';
import {
  calculateDamageMatchup,
  combineInputCorrections,
  inputCorrectionBreakdown,
  MAX_STAT_SP,
  MAX_TOTAL_SP,
  moveCategory,
  roundRatio,
  STATS,
  totalSPExcluding,
  UserInputError,
} from '../utils/calc';
import { calculateFinalSpeed } from './speed';

export const ALL_NATURES = [
  'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle', 'Hardy', 'Hasty',
  'Impish', 'Jolly', 'Lax', 'Lonely', 'Mild', 'Modest', 'Naive', 'Naughty', 'Quiet', 'Quirky',
  'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid',
];

type Candidate<T> = { response: T; sort: number[] };

export function optimizeOffensiveSpread(
  request: OptimizeOffensiveSpreadRequest,
): OptimizeOffensiveSpreadResponse {
  const offensiveStat = request.offensiveStat ?? inferOffensiveStat(request.move);
  const maxStatSP = request.spBudget?.maxStatSP ?? MAX_STAT_SP;
  const maxTotalSP = request.spBudget?.maxTotalSP ?? MAX_TOTAL_SP;
  const reservedSP =
    request.spBudget?.reservedSP ?? totalSPExcluding(request.attacker.pokemon.sp, [offensiveStat]);
  const allowedNatures = request.allowedNatures?.length
    ? request.allowedNatures
    : sensibleNatures(offensiveStat, 'up-or-neutral');

  let bestFeasible: Candidate<OptimizeOffensiveSpreadResponse> | undefined;
  let bestFallback: Candidate<OptimizeOffensiveSpreadResponse> | undefined;

  for (const nature of allowedNatures) {
    for (let sp = 0; sp <= maxStatSP; sp += 1) {
      if (reservedSP + sp > maxTotalSP) continue;

      const attacker = withSPAndNature(request.attacker, offensiveStat, sp, nature);
      const damage = calculateDamageMatchup({
        attacker,
        defender: request.defender,
        move: request.move,
        context: request.context,
      });
      const score = scoreDamage(damage.damageRange, request.targetDamageRatio.mode);
      const feasible = score >= request.targetDamageRatio.value;
      const inputCorrections = combineInputCorrections(damage.inputCorrections);
      const response: OptimizeOffensiveSpreadResponse = {
        ...(inputCorrections ? { inputCorrections } : {}),
        recommendedNature: nature,
        requiredSP: sp,
        resultingDamageRange: damage.damageRange,
        koChance: damage.koChance,
        modifierBreakdown: [
          `Optimized ${offensiveStat} SP with reserved SP ${reservedSP}/${maxTotalSP}.`,
          ...damage.modifierBreakdown,
        ],
        isFeasibleUnderBudget: feasible,
      };
      // Feasible: minimize SP, then nature preference. Fallback: maximize damage.
      const candidate = { response, sort: [sp, naturePenalty(nature, offensiveStat)] };
      if (feasible) bestFeasible = pickLower(bestFeasible, candidate);
      bestFallback = pickLowerByMetric(bestFallback, candidate, -score);
    }
  }

  if (bestFeasible) return bestFeasible.response;
  if (bestFallback) return { ...bestFallback.response, isFeasibleUnderBudget: false };
  throw new UserInputError(`No offensive spread can be evaluated within maxTotalSP=${maxTotalSP}.`);
}

export function optimizeSurvivalSpread(
  request: OptimizeSurvivalSpreadRequest,
): OptimizeSurvivalSpreadResponse {
  const defensiveStat = request.defensiveStat ?? inferDefensiveStat(request.move);
  const maxHPSP = request.spBudget?.maxHPSP ?? MAX_STAT_SP;
  const maxDefenseSP = request.spBudget?.maxDefenseSP ?? MAX_STAT_SP;
  const maxTotalSP = request.spBudget?.maxTotalSP ?? MAX_TOTAL_SP;
  const threshold = request.survivalThreshold?.maxDamageRatioLessThan ?? 1.0;
  const reservedSP =
    request.spBudget?.reservedSP ??
    totalSPExcluding(request.defender.pokemon.sp, ['hp', defensiveStat]);
  const allowedNatures = request.allowedNatures?.length
    ? request.allowedNatures
    : sensibleNatures(defensiveStat, 'up-or-neutral');

  let bestFeasible: Candidate<OptimizeSurvivalSpreadResponse> | undefined;
  let bestFallback: Candidate<OptimizeSurvivalSpreadResponse> | undefined;

  for (const nature of allowedNatures) {
    for (let hpSP = 0; hpSP <= maxHPSP; hpSP += 1) {
      for (let defSP = 0; defSP <= maxDefenseSP; defSP += 1) {
        const totalSPUsed = reservedSP + hpSP + defSP;
        if (totalSPUsed > maxTotalSP) continue;

        let defender = withSPAndNature(request.defender, 'hp', hpSP, nature);
        defender = withSPAndNature(defender, defensiveStat, defSP, nature);
        const damage = calculateDamageMatchup({
          attacker: request.attacker,
          defender,
          move: request.move,
          context: request.context,
        });
        const survives = damage.damageRange[1] < threshold;
        const inputCorrections = combineInputCorrections(damage.inputCorrections);
        const response: OptimizeSurvivalSpreadResponse = {
          ...(inputCorrections ? { inputCorrections } : {}),
          recommendedNature: nature,
          recommendedSP: { hp: hpSP, [defensiveStat]: defSP },
          totalSPUsed,
          resultingDamageRange: damage.damageRange,
          survives,
          modifierBreakdown: [
            `Optimized HP + ${defensiveStat} SP with reserved SP ${reservedSP}/${maxTotalSP}.`,
            ...damage.modifierBreakdown,
          ],
          isFeasibleUnderBudget: survives,
        };
        const candidate = {
          response,
          sort: [hpSP + defSP, naturePenalty(nature, defensiveStat), damage.damageRange[1]],
        };
        if (survives) bestFeasible = pickLower(bestFeasible, candidate);
        bestFallback = pickLowerByMetric(bestFallback, candidate, damage.damageRange[1]);
      }
    }
  }

  if (bestFeasible) return bestFeasible.response;
  if (bestFallback) return { ...bestFallback.response, isFeasibleUnderBudget: false, survives: false };
  throw new UserInputError(`No survival spread can be evaluated within maxTotalSP=${maxTotalSP}.`);
}

export function optimizeSpeedSpread(
  request: OptimizeSpeedSpreadRequest,
): OptimizeSpeedSpreadResponse {
  const maxSpeedSP = request.spBudget?.maxSpeedSP ?? MAX_STAT_SP;
  const maxTotalSP = request.spBudget?.maxTotalSP ?? MAX_TOTAL_SP;
  const reservedSP = request.spBudget?.reservedSP ?? totalSPExcluding(request.self.pokemon.sp, ['spe']);
  const allowedNatures = request.allowedNatures?.length
    ? request.allowedNatures
    : sensibleNatures('spe', request.relation === 'underspeed' ? 'down-or-neutral' : 'up-or-neutral');
  const targetSpeedResult =
    'speed' in request.target && typeof request.target.speed === 'number'
      ? undefined
      : calculateFinalSpeed(
          request.target.battlePokemon,
          request.context,
          'defender',
          'target.battlePokemon.pokemon.ability',
        );
  const targetFinalSpeed =
    'speed' in request.target && typeof request.target.speed === 'number'
      ? request.target.speed
      : targetSpeedResult!.finalSpeed;

  let bestFeasible: Candidate<OptimizeSpeedSpreadResponse> | undefined;
  let bestFallback: Candidate<OptimizeSpeedSpreadResponse> | undefined;

  for (const nature of allowedNatures) {
    for (let speSP = 0; speSP <= maxSpeedSP; speSP += 1) {
      if (reservedSP + speSP > maxTotalSP) continue;
      const self = withSPAndNature(request.self, 'spe', speSP, nature);
      const speed = calculateFinalSpeed(self, request.context, 'attacker', 'self.pokemon.ability');
      const margin = speed.finalSpeed - targetFinalSpeed;
      const feasible = relationSatisfied(speed.finalSpeed, targetFinalSpeed, request.relation);
      const inputCorrections = combineInputCorrections(
        speed.inputCorrections,
        targetSpeedResult?.inputCorrections,
      );
      const response: OptimizeSpeedSpreadResponse = {
        ...(inputCorrections ? { inputCorrections } : {}),
        recommendedNature: nature,
        requiredSpeedSP: speSP,
        resultingRawSpeed: speed.rawSpeed,
        resultingFinalSpeed: speed.finalSpeed,
        targetFinalSpeed,
        margin,
        modifierBreakdown: [
          `Optimized Speed SP with reserved SP ${reservedSP}/${maxTotalSP}.`,
          request.target.benchmarkLabel
            ? `Benchmark: ${request.target.benchmarkLabel}.`
            : `Benchmark final Speed: ${targetFinalSpeed}.`,
          ...inputCorrectionBreakdown(targetSpeedResult?.inputCorrections),
          ...speed.modifierBreakdown,
        ],
        isFeasibleUnderBudget: feasible,
      };
      const candidate = { response, sort: [speSP, naturePenalty(nature, 'spe'), Math.abs(margin)] };
      if (feasible) bestFeasible = pickLower(bestFeasible, candidate);
      bestFallback = pickLowerByMetric(
        bestFallback,
        candidate,
        relationDistance(speed.finalSpeed, targetFinalSpeed, request.relation),
      );
    }
  }

  if (bestFeasible) return bestFeasible.response;
  if (bestFallback) return { ...bestFallback.response, isFeasibleUnderBudget: false };
  throw new UserInputError(`No speed spread can be evaluated within maxTotalSP=${maxTotalSP}.`);
}

/* --- helpers --- */

function withSPAndNature<T extends BattlePokemon>(
  battlePokemon: T,
  stat: StatID,
  sp: number,
  nature: string,
): T {
  return {
    ...battlePokemon,
    pokemon: {
      ...battlePokemon.pokemon,
      nature,
      sp: { ...battlePokemon.pokemon.sp, [stat]: sp },
    },
  };
}

function inferOffensiveStat(moveName: string): 'atk' | 'spa' {
  const category = moveCategory(moveName);
  if (category === 'Physical') return 'atk';
  if (category === 'Special') return 'spa';
  throw new UserInputError(
    `Cannot infer offensive stat for status move ${moveName}; provide offensiveStat or choose a damaging move.`,
  );
}

function inferDefensiveStat(moveName: string): 'def' | 'spd' {
  const category = moveCategory(moveName);
  if (category === 'Physical') return 'def';
  if (category === 'Special') return 'spd';
  throw new UserInputError(
    `Cannot infer defensive stat for status move ${moveName}; provide defensiveStat or choose a damaging move.`,
  );
}

function scoreDamage(range: [number, number], mode: DamageRatioMode): number {
  if (mode === 'min') return range[0];
  if (mode === 'max') return range[1];
  return roundRatio((range[0] + range[1]) / 2);
}

function relationSatisfied(self: number, target: number, relation: Relation): boolean {
  if (relation === 'outspeed') return self > target;
  if (relation === 'speedTie') return self === target;
  return self < target;
}

function relationDistance(self: number, target: number, relation: Relation): number {
  if (relationSatisfied(self, target, relation)) return 0;
  if (relation === 'outspeed') return target + 1 - self;
  if (relation === 'speedTie') return Math.abs(self - target);
  return self - (target - 1);
}

function pickLower<T>(current: Candidate<T> | undefined, candidate: Candidate<T>): Candidate<T> {
  if (!current) return candidate;
  return compareTuple(candidate.sort, current.sort) < 0 ? candidate : current;
}

function pickLowerByMetric<T>(
  current: Candidate<T> | undefined,
  candidate: Candidate<T>,
  metric: number,
): Candidate<T> {
  const enriched = { ...candidate, sort: [metric, ...candidate.sort] };
  if (!current) return enriched;
  return compareTuple(enriched.sort, current.sort) < 0 ? enriched : current;
}

function compareTuple(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function sensibleNatures(stat: StatID, mode: 'up-or-neutral' | 'down-or-neutral'): string[] {
  if (stat === 'hp') return ALL_NATURES;
  const plus: Partial<Record<StatID, string[]>> = {
    atk: ['Adamant', 'Lonely', 'Brave', 'Naughty'],
    def: ['Bold', 'Impish', 'Relaxed', 'Lax'],
    spa: ['Modest', 'Mild', 'Quiet', 'Rash'],
    spd: ['Calm', 'Gentle', 'Sassy', 'Careful'],
    spe: ['Timid', 'Hasty', 'Jolly', 'Naive'],
  };
  const minus: Partial<Record<StatID, string[]>> = {
    atk: ['Bold', 'Modest', 'Calm', 'Timid'],
    def: ['Lonely', 'Mild', 'Gentle', 'Hasty'],
    spa: ['Adamant', 'Impish', 'Careful', 'Jolly'],
    spd: ['Naughty', 'Lax', 'Rash', 'Naive'],
    spe: ['Brave', 'Relaxed', 'Quiet', 'Sassy'],
  };
  const neutral = ['Hardy', 'Docile', 'Serious', 'Bashful', 'Quirky'];
  return mode === 'up-or-neutral'
    ? [...(plus[stat] ?? []), ...neutral]
    : [...(minus[stat] ?? []), ...neutral];
}

function naturePenalty(nature: string, stat: StatID): number {
  if (stat === 'hp') return 0;
  const upPreferred = sensibleNatures(stat, 'up-or-neutral');
  const downPreferred = sensibleNatures(stat, 'down-or-neutral');
  if (upPreferred.slice(0, 4).includes(nature)) return 0;
  if (downPreferred.slice(0, 4).includes(nature)) return 2;
  return 1;
}
