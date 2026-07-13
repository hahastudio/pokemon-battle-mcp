import { describe, expect, it } from 'vitest';
import {
  candidateSlugsForPokemon,
  nameKey,
  requireShowdownSpecies,
  resolveShowdownSpecies,
  suggestPokemonNames,
  toPokeChamDbSlug,
  UserInputError,
} from '../src/utils/pokemon-name';
import { calculateStatsResponse, calculateDamageMatchup } from '../src/utils/calc';

describe('resolveShowdownSpecies', () => {
  it.each([
    ['Basculegion-F', 'Basculegion-F'],
    ['basculegion-female', 'Basculegion-F'],
    ['Basculegion Female', 'Basculegion-F'],
    ['Basculegion-Male', 'Basculegion'],
    ['basculegion-male', 'Basculegion'],
    ['Indeedee-Female', 'Indeedee-F'],
    ['floette-mega', 'Floette-Mega'],
    ['Floette-Mega', 'Floette-Mega'],
    ['urshifu-rapid-strike', 'Urshifu-Rapid-Strike'],
    ['Landorus-Therian', 'Landorus-Therian'],
    ['lando-t', 'Landorus-Therian'],
    ['Flutter Mane', 'Flutter Mane'],
    ['Rotom Wash', 'Rotom-Wash'],
  ])('resolves %s to %s', (input, expected) => {
    expect(resolveShowdownSpecies(input)?.name).toBe(expected);
  });

  it('returns undefined for unknown names', () => {
    expect(resolveShowdownSpecies('Totally Fake Mon')).toBeUndefined();
  });
});

describe('requireShowdownSpecies', () => {
  it('throws a UserInputError with did-you-mean suggestions', () => {
    expect(() => requireShowdownSpecies('Fluter Mane')).toThrowError(UserInputError);
    expect(() => requireShowdownSpecies('Fluter Mane')).toThrowError(/Flutter Mane/);
  });
});

describe('PokeChamDB slug conversion', () => {
  it.each([
    ['Basculegion-F', 'basculegion-female'],
    ['basculegion-female', 'basculegion-female'],
    ['Basculegion-Male', 'basculegion'],
    ['Basculegion', 'basculegion'],
    ['Urshifu-Rapid-Strike', 'urshifu-rapid-strike'],
    ['Floette-Mega', 'floette-mega'],
    ["Sirfetch'd", 'sirfetchd'],
    ['Mr. Mime', 'mr-mime'],
  ])('toPokeChamDbSlug(%s) -> %s', (input, expected) => {
    expect(toPokeChamDbSlug(input)).toBe(expected);
  });

  it('orders candidate slugs most specific first', () => {
    expect(candidateSlugsForPokemon('Basculegion-F')).toEqual(['basculegion-female', 'basculegion']);
    expect(candidateSlugsForPokemon('Rotom-Wash')[0]).toBe('rotom-wash');
    expect(candidateSlugsForPokemon('Charizard-Mega-X')).toContain('charizard');
  });
});

describe('nameKey', () => {
  it('expands trailing gender abbreviations and strips punctuation', () => {
    expect(nameKey('Basculegion-F')).toBe('basculegion-female');
    expect(nameKey('Indeedee-M')).toBe('indeedee-male');
    expect(nameKey("Sirfetch'd")).toBe('sirfetchd');
    expect(nameKey('Porygon-Z')).toBe('porygon-z');
  });
});

describe('suggestPokemonNames', () => {
  it('includes extra names such as meta snapshot entries', () => {
    expect(suggestPokemonNames('Floete-Mega', ['Floette-Mega'])).toContain('Floette-Mega');
  });
});

describe('calc tools accept any common spelling', () => {
  it('calculates identical stats for basculegion-female and Basculegion-F', () => {
    const viaSlug = calculateStatsResponse({
      pokemon: { name: 'basculegion-female', nature: 'Modest', sp: { spa: 32 } },
    });
    const viaShowdown = calculateStatsResponse({
      pokemon: { name: 'Basculegion-F', nature: 'Modest', sp: { spa: 32 } },
    });
    expect(viaSlug.rawStats).toEqual(viaShowdown.rawStats);
    expect(viaSlug.inputCorrections).toContainEqual(
      expect.objectContaining({
        code: 'speciesNameNormalized',
        from: 'basculegion-female',
        to: 'Basculegion-F',
      }),
    );
    expect(viaShowdown.inputCorrections).toBeUndefined();
  });

  it('runs damage calcs with slug-style names', () => {
    const result = calculateDamageMatchup({
      attacker: { pokemon: { name: 'urshifu-rapid-strike', nature: 'Jolly', sp: { atk: 32 } } },
      defender: { pokemon: { name: 'basculegion-female', nature: 'Modest', sp: {} } },
      move: 'Surging Strikes',
    });
    expect(result.damageRange[1]).toBeGreaterThan(0);
    expect(result.inputCorrections?.map(c => c.code)).toContain('speciesNameNormalized');
  });

  it('throws with suggestions for unknown species', () => {
    expect(() =>
      calculateStatsResponse({ pokemon: { name: 'Fluter Mane', nature: 'Timid', sp: {} } }),
    ).toThrowError(/Did you mean: .*Flutter Mane/);
  });
});
