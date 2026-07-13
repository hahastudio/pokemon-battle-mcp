import { describe, expect, it } from 'vitest';
import {
  applyStatStage,
  calculateChampionStats,
  calculateStatsResponse,
  getCanonicalMegaAbility,
  completeSP,
  spToEVs,
} from '../src/utils/calc';

const flutterMane = {
  pokemon: {
    name: 'Flutter Mane',
    nature: 'Timid',
    ability: 'Protosynthesis',
    item: 'Booster Energy',
    sp: { hp: 0, atk: 0, def: 0, spa: 32, spd: 2, spe: 32 },
  },
};

describe('Pokémon Champions stat calculation', () => {
  it('uses level 50, IV 31, and 1 SP = 8 EV conversion', () => {
    expect(calculateChampionStats(flutterMane)).toEqual({
      hp: 130,
      atk: 67,
      def: 75,
      spa: 187,
      spd: 157,
      spe: 205,
    });
  });

  it('converts SP to EVs by multiplying by 8', () => {
    expect(spToEVs({ spa: 32, spe: 16 })).toEqual({
      hp: 0,
      atk: 0,
      def: 0,
      spa: 256,
      spd: 0,
      spe: 128,
    });
  });

  it('validates per-stat and total SP limits', () => {
    expect(() => completeSP({ hp: 33 })).toThrow(/0 to 32/);
    expect(() => completeSP({ hp: -1 })).toThrow(/0 to 32/);
    expect(() => completeSP({ hp: 3.5 })).toThrow(/0 to 32/);
    expect(() => completeSP({ hp: 32, atk: 32, def: 32 })).toThrow(/Total SP/);
  });

  it('applies stat stages with deterministic integer game math', () => {
    expect(applyStatStage(200, 1)).toBe(300); // *3/2
    expect(applyStatStage(200, 6)).toBe(800); // *4
    expect(applyStatStage(200, -1)).toBe(133); // floor(200*2/3)
    expect(applyStatStage(200, -6)).toBe(50); // *2/8
  });



  it('canonicalizes stale abilities on Mega formes and reports the correction', () => {
    expect(getCanonicalMegaAbility('Garchomp-Mega')).toEqual({
      species: 'Garchomp-Mega',
      ability: 'Sand Force',
    });

    const response = calculateStatsResponse({
      pokemon: {
        name: 'Garchomp-Mega',
        nature: 'Jolly',
        ability: 'Rough Skin',
        sp: { atk: 32, spd: 2, spe: 32 },
      },
    });

    expect(response.inputCorrections).toContainEqual(
      expect.objectContaining({
        code: 'megaAbilityOverride',
        path: 'pokemon.pokemon.ability',
        from: 'Rough Skin',
        to: 'Sand Force',
      }),
    );
    expect(response.modifierBreakdown.join('\n')).toContain('megaAbilityOverride');
  });

  it('uses held Mega Stones to resolve battle-only Mega formes before stat calculation', () => {
    const response = calculateStatsResponse({
      pokemon: {
        name: 'Floette-Eternal',
        nature: 'Modest',
        ability: 'Flower Veil',
        item: 'Floettite',
        sp: { spa: 32, spe: 32, spd: 2 },
      },
    });

    expect(response.rawStats.spa).toBe(227);
    expect(response.inputCorrections).toContainEqual(
      expect.objectContaining({
        code: 'megaStoneFormeResolved',
        path: 'pokemon.pokemon.name',
        from: 'Floette-Eternal',
        to: 'Floette-Mega',
      }),
    );
    expect(response.inputCorrections).toContainEqual(
      expect.objectContaining({
        code: 'megaAbilityOverride',
        path: 'pokemon.pokemon.ability',
        from: 'Flower Veil',
        to: 'Fairy Aura',
      }),
    );
  });

  it('respects explicit in-battle ability changes on Mega formes', () => {
    const response = calculateStatsResponse({
      pokemon: {
        name: 'Garchomp-Mega',
        nature: 'Jolly',
        ability: 'Insomnia',
        abilitySource: 'battle-changed',
        sp: { atk: 32, spd: 2, spe: 32 },
      },
      state: { activeEffects: [{ id: 'worryseed', source: 'move' }] },
    });

    expect(response.inputCorrections).toBeUndefined();
  });

  it('reports stage-modified stats and keeps raw stats intact', () => {
    const response = calculateStatsResponse({
      ...flutterMane,
      state: { boosts: { spa: 2 } },
    });
    expect(response.rawStats.spa).toBe(187);
    expect(response.modifiedStats?.spa).toBe(applyStatStage(187, 2));
    expect(response.modifierBreakdown.join('\n')).toContain('spa stage +2');
  });
});
