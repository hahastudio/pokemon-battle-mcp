import { describe, expect, it } from 'vitest';
import { calculateDamageMatchup, getMove } from '../src/utils/calc';

const landorus = {
  pokemon: {
    name: 'Landorus-Therian',
    nature: 'Adamant',
    ability: 'Intimidate',
    item: 'Life Orb',
    sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 },
  },
};

const incineroar = {
  pokemon: {
    name: 'Incineroar',
    nature: 'Careful',
    ability: 'Intimidate',
    item: 'Sitrus Berry',
    sp: { hp: 32, atk: 0, def: 16, spa: 0, spd: 18, spe: 0 },
  },
};

describe('forward damage calculation', () => {
  it('converts SP to EVs and returns 16 rolls plus HP ratios', () => {
    const result = calculateDamageMatchup({
      attacker: landorus,
      defender: incineroar,
      move: 'Earthquake',
      context: { format: 'doubles' },
    });

    expect(result.damageRolls).toHaveLength(16);
    expect(result.damageRollRatios).toHaveLength(16);
    expect(result.damageRange[0]).toBeGreaterThan(0);
    expect(result.damageRange[0]).toBeLessThanOrEqual(result.damageRange[1]);
    expect(result.description).toContain('Landorus-Therian Earthquake');
  });

  it('requires explicit battle state for history-based effects like Intimidate', () => {
    const neutral = calculateDamageMatchup({
      attacker: landorus,
      defender: incineroar,
      move: 'Earthquake',
      context: { format: 'doubles' },
    });
    const intimidated = calculateDamageMatchup({
      attacker: { ...landorus, state: { boosts: { atk: -1 } } },
      defender: incineroar,
      move: 'Earthquake',
      context: { format: 'doubles' },
    });

    expect(intimidated.damageRange[1]).toBeLessThan(neutral.damageRange[1]);
  });

  it('maps side state such as Reflect through BattleContext', () => {
    const withoutReflect = calculateDamageMatchup({
      attacker: landorus,
      defender: incineroar,
      move: 'Earthquake',
      context: { format: 'doubles' },
    });
    const withReflect = calculateDamageMatchup({
      attacker: landorus,
      defender: incineroar,
      move: 'Earthquake',
      context: { format: 'doubles', defenderSide: { sideConditions: [{ id: 'reflect' }] } },
    });

    expect(withReflect.damageRange[1]).toBeLessThan(withoutReflect.damageRange[1]);
    expect(withReflect.modifierBreakdown.join('\n')).toContain('defender side: reflect');
  });

  it('uses cumulative allied faint events for Last Respects base power', () => {
    const basculegion = {
      pokemon: {
        name: 'Basculegion',
        nature: 'Adamant',
        ability: 'Adaptability',
        sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 },
      },
    };
    const defender = {
      pokemon: { name: 'Garchomp', nature: 'Jolly', ability: 'Rough Skin', sp: { hp: 32, def: 0, spd: 32 } },
    };

    const noFaints = calculateDamageMatchup({
      attacker: basculegion,
      defender,
      move: 'Last Respects',
      context: { format: 'doubles', attackerSide: { alliesFainted: 0 } },
    });
    const fiveFaints = calculateDamageMatchup({
      attacker: basculegion,
      defender,
      move: 'Last Respects',
      context: { format: 'doubles', attackerSide: { alliesFainted: 5 } },
    });

    expect(fiveFaints.damageRange[1]).toBeGreaterThan(noFaints.damageRange[1] * 4);
    expect(fiveFaints.modifierBreakdown.join('\n')).toContain(
      'Last Respects effective base power: 300 (5 allied faint events).',
    );
    expect(fiveFaints.modifierBreakdown.join('\n')).toContain('Attacker side allied faint events: 5.');
  });

  it('passes allied faint events through to @smogon/calc for Supreme Overlord', () => {
    const kingambit = {
      pokemon: {
        name: 'Kingambit',
        nature: 'Adamant',
        ability: 'Supreme Overlord',
        sp: { hp: 32, atk: 32, spd: 2 },
      },
    };
    const defender = {
      pokemon: { name: 'Blissey', nature: 'Bold', ability: 'Natural Cure', sp: { hp: 32, def: 32, spd: 2 } },
    };

    const noFaints = calculateDamageMatchup({
      attacker: kingambit,
      defender,
      move: 'Iron Head',
      context: { format: 'doubles', attackerSide: { alliesFainted: 0 } },
    });
    const fiveFaints = calculateDamageMatchup({
      attacker: kingambit,
      defender,
      move: 'Iron Head',
      context: { format: 'doubles', attackerSide: { alliesFainted: 5 } },
    });

    expect(fiveFaints.damageRange[1]).toBeGreaterThan(noFaints.damageRange[1]);
    expect(fiveFaints.description).toContain('Supreme Overlord 5 allies fainted');
  });

  it('uses direct-damage hits taken for Rage Fist base power', () => {
    const annihilape = {
      pokemon: {
        name: 'Annihilape',
        nature: 'Adamant',
        ability: 'Defiant',
        sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 },
      },
    };
    const hitThreeTimes = {
      ...annihilape,
      state: { timesHitByDirectDamage: 3 },
    };
    const defender = {
      pokemon: { name: 'Garchomp', nature: 'Jolly', ability: 'Rough Skin', sp: { hp: 32, def: 0, spd: 32 } },
    };

    const base = calculateDamageMatchup({ attacker: annihilape, defender, move: 'Rage Fist' });
    const boosted = calculateDamageMatchup({ attacker: hitThreeTimes, defender, move: 'Rage Fist' });

    expect(boosted.damageRange[1]).toBeGreaterThan(base.damageRange[1] * 2);
    expect(boosted.modifierBreakdown.join('\n')).toContain(
      'Rage Fist effective base power: 200 (3 direct-damage hits taken).',
    );
  });



  it('uses Mega forme ability corrections for damage unless ability was changed in battle', () => {
    const defender = {
      pokemon: { name: 'Blissey', nature: 'Bold', ability: 'Natural Cure', sp: { hp: 32, def: 32, spd: 2 } },
    };
    const staleMega = {
      pokemon: {
        name: 'Mawile-Mega',
        nature: 'Adamant',
        ability: 'Intimidate',
        sp: { hp: 32, atk: 32, spd: 2 },
      },
    };
    const changedMega = {
      pokemon: {
        name: 'Mawile-Mega',
        nature: 'Adamant',
        ability: 'Insomnia',
        abilitySource: 'battle-changed' as const,
        sp: { hp: 32, atk: 32, spd: 2 },
      },
      state: { activeEffects: [{ id: 'worryseed', source: 'move' as const }] },
    };

    const corrected = calculateDamageMatchup({ attacker: staleMega, defender, move: 'Play Rough' });
    const battleChanged = calculateDamageMatchup({ attacker: changedMega, defender, move: 'Play Rough' });

    expect(corrected.inputCorrections).toContainEqual(
      expect.objectContaining({ code: 'megaAbilityOverride', to: 'Huge Power' }),
    );
    expect(battleChanged.inputCorrections).toBeUndefined();
    expect(corrected.damageRange[1]).toBeGreaterThan(battleChanged.damageRange[1]);
  });

  it('uses held Mega Stones to resolve battle-only Mega formes before damage calculation', () => {
    const defender = {
      pokemon: { name: 'Garchomp', nature: 'Jolly', ability: 'Rough Skin', sp: { hp: 32, spd: 32, spe: 2 } },
    };
    const base = {
      pokemon: {
        name: 'Floette-Eternal',
        nature: 'Modest',
        ability: 'Flower Veil',
        sp: { spa: 32, spe: 32, spd: 2 },
      },
    };
    const holdingFloettite = {
      pokemon: {
        ...base.pokemon,
        item: 'Floettite',
      },
    };

    const baseDamage = calculateDamageMatchup({ attacker: base, defender, move: 'Moonblast' });
    const megaDamage = calculateDamageMatchup({ attacker: holdingFloettite, defender, move: 'Moonblast' });

    expect(megaDamage.inputCorrections).toContainEqual(
      expect.objectContaining({ code: 'megaStoneFormeResolved', to: 'Floette-Mega' }),
    );
    expect(megaDamage.inputCorrections).toContainEqual(
      expect.objectContaining({ code: 'megaAbilityOverride', to: 'Fairy Aura' }),
    );
    expect(megaDamage.damageRange[1]).toBeGreaterThan(baseDamage.damageRange[1]);
    expect(megaDamage.description).toContain('Floette-Mega');
  });

  it('applies field weather to damage (rain boosts Water moves)', () => {
    const milotic = {
      pokemon: { name: 'Milotic', nature: 'Modest', ability: 'Competitive', item: 'Life Orb', sp: { spa: 32, spd: 2, spe: 32 } },
    };
    const noRain = calculateDamageMatchup({ attacker: milotic, defender: incineroar, move: 'Muddy Water', context: { format: 'doubles' } });
    const rain = calculateDamageMatchup({
      attacker: milotic,
      defender: incineroar,
      move: 'Muddy Water',
      context: { format: 'doubles', field: { weather: 'rain' } },
    });
    expect(rain.damageRange[1]).toBeGreaterThan(noRain.damageRange[1]);
  });

  it('throws a clear error for unknown moves', () => {
    expect(() => getMove('Definitely Not A Move')).toThrow(/Unknown move/);
  });
});
