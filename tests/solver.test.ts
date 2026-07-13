import { describe, expect, it } from 'vitest';
import { optimizeOffensiveSpread, optimizeSurvivalSpread } from '../src/services/solver';

describe('offensive SP solver', () => {
  it('finds a minimum offensive SP that satisfies a damage threshold', () => {
    const result = optimizeOffensiveSpread({
      attacker: {
        pokemon: { name: 'Flutter Mane', nature: 'Timid', ability: 'Protosynthesis', sp: { hp: 0, atk: 0, def: 0, spd: 2, spe: 32 } },
      },
      defender: {
        pokemon: { name: 'Urshifu-Rapid-Strike', nature: 'Jolly', ability: 'Unseen Fist', sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 } },
      },
      move: 'Moonblast',
      offensiveStat: 'spa',
      targetDamageRatio: { mode: 'min', value: 1.0 },
      allowedNatures: ['Timid', 'Modest'],
    });

    expect(result.isFeasibleUnderBudget).toBe(true);
    expect(result.requiredSP).toBeGreaterThanOrEqual(0);
    expect(result.requiredSP).toBeLessThanOrEqual(32);
    expect(result.resultingDamageRange[0]).toBeGreaterThanOrEqual(1);
  });

  it('infers the offensive stat from the move category when omitted', () => {
    const result = optimizeOffensiveSpread({
      attacker: { pokemon: { name: 'Landorus-Therian', nature: 'Adamant', item: 'Life Orb', sp: { spe: 32 } } },
      defender: { pokemon: { name: 'Incineroar', nature: 'Careful', sp: { hp: 32, spd: 2 } } },
      move: 'Earthquake', // physical -> atk
      targetDamageRatio: { mode: 'max', value: 0.5 },
      allowedNatures: ['Adamant'],
    });
    expect(result.modifierBreakdown.join('\n')).toContain('Optimized atk SP');
  });

  it('reports infeasibility when the damage target cannot be met', () => {
    const result = optimizeOffensiveSpread({
      attacker: { pokemon: { name: 'Incineroar', nature: 'Careful', sp: { hp: 32, spd: 2 } } },
      defender: { pokemon: { name: 'Incineroar', nature: 'Careful', item: 'Assault Vest', sp: { hp: 32, spd: 32, def: 2 } } },
      move: 'Fake Out',
      offensiveStat: 'atk',
      targetDamageRatio: { mode: 'min', value: 1.0 },
      allowedNatures: ['Adamant'],
    });
    expect(result.isFeasibleUnderBudget).toBe(false);
  });
});

describe('survival SP solver', () => {
  it('finds a survival spread under the 66 SP budget', () => {
    const result = optimizeSurvivalSpread({
      defender: {
        pokemon: { name: 'Incineroar', nature: 'Careful', ability: 'Intimidate', sp: { atk: 0, spa: 0, spd: 2, spe: 0 } },
      },
      attacker: {
        pokemon: { name: 'Landorus-Therian', nature: 'Adamant', ability: 'Intimidate', item: 'Life Orb', sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 } },
        state: { boosts: { atk: -1 } },
      },
      move: 'Earthquake',
      context: { format: 'doubles' },
      defensiveStat: 'def',
      survivalThreshold: { maxDamageRatioLessThan: 0.9 },
      allowedNatures: ['Impish', 'Careful'],
    });

    expect(result.isFeasibleUnderBudget).toBe(true);
    expect(result.survives).toBe(true);
    expect(result.totalSPUsed).toBeLessThanOrEqual(66);
    expect(result.resultingDamageRange[1]).toBeLessThan(0.9);
    expect(result.recommendedSP.hp).toBeGreaterThanOrEqual(0);
  });
});
