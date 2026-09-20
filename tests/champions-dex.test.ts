import { describe, expect, it } from 'vitest';
import { gen } from '../src/data/champions-dex';
import { calculateDamageMatchup, getHeldMegaStoneForme } from '../src/utils/calc';

describe('pinned Pokémon Showdown Champions data', () => {
  it('contains the Regulation M-C Mega Golisopod data', () => {
    const species = gen.species.get('golisopodmega');

    expect(species).toMatchObject({
      name: 'Golisopod-Mega',
      types: ['Bug', 'Steel'],
      baseStats: { hp: 75, atk: 150, def: 175, spa: 70, spd: 120, spe: 40 },
      abilities: { 0: 'Tough Claws' },
      requiredItem: 'Golisopite',
      isNonstandard: null,
    });
  });

  it('maps Golisopite to Mega Golisopod with Tough Claws', () => {
    expect(
      getHeldMegaStoneForme({
        pokemon: {
          name: 'Golisopod',
          item: 'Golisopite',
          ability: 'Emergency Exit',
          nature: 'Adamant',
          sp: { atk: 32 },
        },
      }),
    ).toEqual({
      fromSpecies: 'Golisopod',
      species: 'Golisopod-Mega',
      ability: 'Tough Claws',
      item: 'Golisopite',
    });
  });

  it('applies Tough Claws to contact damage', () => {
    const defender = {
      pokemon: {
        name: 'Garchomp',
        nature: 'Impish',
        ability: 'Rough Skin',
        sp: { hp: 32, def: 32, spd: 2 },
      },
    };
    const mega = {
      pokemon: {
        name: 'Golisopod-Mega',
        nature: 'Adamant',
        ability: 'Tough Claws',
        sp: { hp: 32, atk: 32, spd: 2 },
      },
    };
    const changedAbility = {
      pokemon: {
        ...mega.pokemon,
        ability: 'Emergency Exit',
        abilitySource: 'battle-changed' as const,
      },
    };

    const toughClaws = calculateDamageMatchup({ attacker: mega, defender, move: 'Iron Head' });
    const withoutBoost = calculateDamageMatchup({
      attacker: changedAbility,
      defender,
      move: 'Iron Head',
    });

    expect(toughClaws.damageRange[1]).toBeGreaterThan(withoutBoost.damageRange[1]);
  });
});

