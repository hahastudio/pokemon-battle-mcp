import { describe, expect, it } from 'vitest';
import { calculateFinalSpeed } from '../src/services/speed';
import { optimizeSpeedSpread } from '../src/services/solver';

describe('speed engine', () => {
  it('layers Speed stage, then non-stage modifiers (Tailwind, Swift Swim, Choice Scarf, paralysis)', () => {
    const result = calculateFinalSpeed(
      {
        pokemon: {
          name: 'Floatzel',
          nature: 'Jolly',
          ability: 'Swift Swim',
          item: 'Choice Scarf',
          sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 },
        },
        state: { boosts: { spe: 1 }, status: 'paralysis' },
      },
      {
        field: { weather: 'rain' },
        attackerSide: { sideConditions: [{ id: 'tailwind' }] },
      },
    );

    // Raw Jolly Floatzel at 32 Spe SP = 183. Stage +1 => floor(183*3/2)=274.
    // Tailwind x2, Swift Swim x2, Choice Scarf x3/2, paralysis x1/2 => floor(274*6/2)=822.
    expect(result.rawSpeed).toBe(183);
    expect(result.stagedSpeed).toBe(274);
    expect(result.finalSpeed).toBe(822);
    expect(result.modifierBreakdown.join('\n')).toContain('Swift Swim');
  });

  it('does not apply Swift Swim when there is no rain', () => {
    const result = calculateFinalSpeed({
      pokemon: { name: 'Floatzel', nature: 'Jolly', ability: 'Swift Swim', sp: { spe: 32 } },
    });
    expect(result.finalSpeed).toBe(result.stagedSpeed);
  });

  it('treats Unburden as a x2 modifier only after item consumption', () => {
    const base = {
      pokemon: { name: 'Sneasler', nature: 'Jolly', ability: 'Unburden', item: 'Psychic Seed', sp: { atk: 32, spe: 32 } },
    };
    const inactive = calculateFinalSpeed(base);
    const active = calculateFinalSpeed({
      ...base,
      state: { activeEffects: [{ id: 'itemconsumed' }] },
    });
    expect(active.finalSpeed).toBe(inactive.finalSpeed * 2);
  });

  it('uses package final-speed logic for Quick Feet and skips the paralysis speed drop', () => {
    const base = calculateFinalSpeed({
      pokemon: { name: 'Jolteon', nature: 'Timid', ability: 'Volt Absorb', sp: { spe: 32 } },
      state: { status: 'paralysis' },
    });
    const quickFeet = calculateFinalSpeed({
      pokemon: { name: 'Jolteon', nature: 'Timid', ability: 'Quick Feet', sp: { spe: 32 } },
      state: { status: 'paralysis' },
    });

    expect(quickFeet.finalSpeed).toBeGreaterThan(base.finalSpeed);
    expect(quickFeet.modifierBreakdown.join('\n')).toContain('Quick Feet');
    expect(quickFeet.modifierBreakdown.join('\n')).not.toContain('Paralysis: x1/2');
  });
});

describe('speed solver', () => {
  it('finds the minimum SP needed to outspeed a numeric benchmark', () => {
    const result = optimizeSpeedSpread({
      self: {
        pokemon: {
          name: 'Flutter Mane',
          nature: 'Timid',
          ability: 'Protosynthesis',
          sp: { hp: 0, atk: 0, def: 0, spa: 32, spd: 2 },
        },
      },
      target: { speed: 200, benchmarkLabel: 'base 200 benchmark' },
      relation: 'outspeed',
      allowedNatures: ['Timid'],
    });

    expect(result.requiredSpeedSP).toBe(28);
    expect(result.resultingFinalSpeed).toBe(201);
    expect(result.margin).toBe(1);
    expect(result.isFeasibleUnderBudget).toBe(true);
  });

  it('resolves a BattlePokemon target final speed and outspeeds it', () => {
    const result = optimizeSpeedSpread({
      self: {
        pokemon: { name: 'Sneasler', nature: 'Adamant', ability: 'Unburden', item: 'Psychic Seed', sp: { atk: 32, spd: 2 } },
        state: { abilityEffect: 'active', activeEffects: [{ id: 'itemconsumed' }] },
      },
      target: {
        battlePokemon: {
          pokemon: { name: 'Flutter Mane', nature: 'Timid', ability: 'Protosynthesis', item: 'Booster Energy', sp: { spa: 32, spd: 2, spe: 32 } },
          state: { abilityEffect: 'active', activeEffects: [{ id: 'boosterspeed' }] },
        },
      },
      context: { format: 'doubles', field: { terrain: 'psychic' } },
      relation: 'outspeed',
      allowedNatures: ['Adamant', 'Jolly'],
    });

    expect(result.isFeasibleUnderBudget).toBe(true);
    expect(result.resultingFinalSpeed).toBeGreaterThan(result.targetFinalSpeed);
  });

  it('reports infeasibility when the speed target cannot be reached under budget', () => {
    const result = optimizeSpeedSpread({
      self: { pokemon: { name: 'Incineroar', nature: 'Careful', sp: { hp: 32, spd: 2 } } },
      target: { speed: 1000 },
      relation: 'outspeed',
      allowedNatures: ['Jolly'],
    });
    expect(result.isFeasibleUnderBudget).toBe(false);
  });
});
