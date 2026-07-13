import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMetaSnapshot,
  getPokemonOptions,
  resetMetaCache,
} from '../src/services/meta-source';
import { handleCalculateStats } from '../src/tools/damage';
import { getSpeedTiers } from '../src/services/speed';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(axios.get).mockRejectedValue(new Error('network disabled in deterministic meta tests'));
  resetMetaCache();
});

type MockPikalyticsEntry = {
  name: string;
  ranking?: string | number;
  moves?: Array<{ move: string; percent?: string }>;
  items?: Array<{ item: string; percent?: string }>;
  abilities?: Array<{ ability: string; percent?: string }>;
  natures?: Array<{ nature: string; percent?: string }>;
  spreads?: Array<{ ev: string; percent?: string; nature?: string }>;
  team?: Array<{ pokemon: string; percent?: string; rank?: number }>;
  counters?: Array<{ pokemon: string; percent?: string; rank?: number }>;
};

const commonDetail = {
  moves: [{ move: 'Aqua Jet', percent: '77.7' }],
  items: [{ item: 'Life Orb', percent: '50' }],
  abilities: [{ ability: 'Adaptability', percent: '99.9' }],
  natures: [{ nature: 'Adamant', percent: '80' }],
  spreads: [{ ev: '0/32/0/0/2/32', percent: '25' }],
  team: [{ pokemon: 'Garchomp', percent: '12.5', rank: 1 }],
  counters: [{ pokemon: 'Sylveon', percent: '10', rank: 1 }],
};

function entry(name: string, ranking: number, overrides: Partial<MockPikalyticsEntry> = {}): MockPikalyticsEntry {
  return {
    name,
    ranking,
    ...commonDetail,
    ...overrides,
  };
}

function mockPikalytics(entries: MockPikalyticsEntry[]): string[] {
  const requestedUrls: string[] = [];
  vi.mocked(axios.get).mockImplementation(async url => {
    const text = String(url);
    requestedUrls.push(text);
    if (text.endsWith('/api/p/2026-05/battledataregmbs3-1760')) return { data: entries };
    const slug = text.match(/\/api\/p\/2026-05\/battledataregmbs3-1760\/([^/?#]+)/)?.[1];
    if (slug) {
      const match = entries.find(candidate => candidate.name.toLowerCase().replace(/\s+/g, '-') === decodeURIComponent(slug).toLowerCase());
      if (match) return { data: match };
    }
    throw new Error(`unexpected URL: ${text}`);
  });
  return requestedUrls;
}

describe('meta source fallback', () => {
  it('returns a Pokémon Champions snapshot with valid SP spreads', async () => {
    const snapshot = await getMetaSnapshot({ limit: 3 });
    expect(snapshot.format).toBe('pokemon-champions');
    expect(snapshot.pokemon).toHaveLength(3);
    expect(snapshot.source).toContain('bundled fallback meta seed');
    for (const entry of snapshot.pokemon) {
      for (const spread of entry.popularSpreads ?? []) {
        const total = Object.values(spread.sp).reduce((a, b) => a + b, 0);
        expect(total).toBeLessThanOrEqual(66);
        expect(Math.max(...Object.values(spread.sp))).toBeLessThanOrEqual(32);
      }
    }
  });

  it('omits builds when includeBuilds is false', async () => {
    const snapshot = await getMetaSnapshot({ limit: 2, includeBuilds: false });
    expect(snapshot.pokemon[0].popularSpreads).toBeUndefined();
  });

  it('returns options for a known Pokémon, with teammates', async () => {
    const options = await getPokemonOptions({ pokemon: 'Incineroar', includeTeammates: true });
    expect(options.moves.map(move => move.name)).toContain('Fake Out');
    expect(options.spreads.length).toBeGreaterThan(0);
    expect(options.builds?.length).toBeGreaterThan(0);
    expect(options.teammates?.length).toBeGreaterThan(0);
  });

  it('returns canonical fixed ability for requested Mega formes even when meta details are unavailable', async () => {
    const options = await getPokemonOptions({ pokemon: 'Lucario-Mega' });
    expect(options.pokemon).toBe('Lucario-Mega');
    expect(options.abilities).toEqual([{ name: 'Adaptability', usage: 1 }]);
    expect(options.metaNotes?.join('\n')).toContain("fixed ability 'Adaptability'");
  });

  it('returns an empty option shell for an unknown Pokémon', async () => {
    const options = await getPokemonOptions({ pokemon: 'Totally Fake Mon' });
    expect(options.moves).toHaveLength(0);
    expect(options.metaNotes?.join('\n')).toContain('No meta entry found');
  });

  it('adds did-you-mean suggestions for misspelled Pokémon', async () => {
    const options = await getPokemonOptions({ pokemon: 'Fluter Mane' });
    expect(options.metaNotes?.join('\n')).toContain('Did you mean');
    expect(options.metaNotes?.join('\n')).toContain('Flutter Mane');
  });
});

describe('Pikalytics live-source parsing', () => {
  it('uses English Pikalytics labels and normalizes variant names omitted by query slugs', async () => {
    mockPikalytics([
      entry('Basculegion', 1),
      entry('Rotom-Wash', 2),
    ]);

    const options = await getPokemonOptions({ pokemon: 'Basculegion-Male', includeTeammates: true });

    expect(options.pokemon).toBe('Basculegion');
    expect(options.moves).toContainEqual({ name: 'Aqua Jet', usage: 0.777 });
    expect(options.items).toContainEqual({ name: 'Life Orb', usage: 0.5 });
    expect(options.abilities).toContainEqual({ name: 'Adaptability', usage: 0.999 });
    expect(options.teammates).toContainEqual({ name: 'Garchomp', usage: 0.125 });
    expect(options.metaNotes?.join('\n')).toContain("Resolved requested name 'Basculegion-Male' to Pikalytics slug 'basculegion'");
  });

  it('matches form names such as Rotom Wash against ranked Pikalytics entries', async () => {
    mockPikalytics([
      entry('Basculegion', 1),
      entry('Rotom-Wash', 2),
    ]);

    const options = await getPokemonOptions({ pokemon: 'Rotom Wash' });

    expect(options.pokemon).toBe('Rotom-Wash');
    expect(options.moves[0]?.name).toBe('Aqua Jet');
  });

  it("resolves Showdown-style 'Basculegion-F' to the Pikalytics ranked forme", async () => {
    const requestedUrls = mockPikalytics([
      entry('Basculegion', 1),
      entry('Basculegion-F', 2),
    ]);

    const options = await getPokemonOptions({ pokemon: 'Basculegion-F' });

    expect(options.pokemon).toBe('Basculegion-F');
    expect(options.moves[0]?.name).toBe('Aqua Jet');
    expect(requestedUrls).toHaveLength(1);
  });

  it('warns instead of silently returning base-forme data when the forme page is missing', async () => {
    mockPikalytics([
      entry('Basculegion', 1),
    ]);

    const options = await getPokemonOptions({ pokemon: 'Basculegion-F' });

    expect(options.moves[0]?.name).toBe('Aqua Jet');
    expect(options.metaNotes?.join('\n')).toContain("Warning: Pikalytics has no data page for 'basculegion-female'");
    expect(options.inputCorrections).toContainEqual(
      expect.objectContaining({ code: 'formeDataFallback', to: 'basculegion' }),
    );
  });

  it('upgrades a base-species request to the only meta forme with an input correction', async () => {
    mockPikalytics([
      entry('Floette-Mega', 1),
      entry('Rotom-Wash', 2),
    ]);

    const options = await getPokemonOptions({ pokemon: 'Floette' });

    expect(options.pokemon).toBe('Floette-Mega');
    expect(options.inputCorrections).toContainEqual(
      expect.objectContaining({ code: 'formeResolved', from: 'Floette', to: 'Floette-Mega' }),
    );
    expect(options.metaNotes?.join('\n')).toContain("Resolved 'Floette' to 'Floette-Mega'");
  });

  it('applies the same unambiguous forme guardrail before calc tool handling', async () => {
    mockPikalytics([
      entry('Floette-Mega', 1),
      entry('Rotom-Wash', 2),
    ]);

    const response = await handleCalculateStats({
      pokemon: {
        pokemon: {
          name: 'Floette',
          nature: 'Modest',
          ability: 'Flower Veil',
          sp: { spa: 32, spe: 32 },
        },
      },
      context: { format: 'doubles' },
    });

    expect(response.rawStats.spa).toBeGreaterThan(200);
    expect(response.inputCorrections).toContainEqual(
      expect.objectContaining({
        code: 'formeResolved',
        path: 'pokemon.pokemon.name',
        from: 'Floette',
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
    expect(response.modifierBreakdown.join('\n')).toContain('formeResolved');
  });

  it('rejects ambiguous base-species requests, listing the candidate formes', async () => {
    mockPikalytics([
      entry('Tauros-Paldea-Aqua', 1),
      entry('Tauros-Paldea-Blaze', 2),
    ]);

    await expect(getPokemonOptions({ pokemon: 'Tauros' })).rejects.toThrowError(
      /ambiguous.*Tauros-Paldea-Aqua, Tauros-Paldea-Blaze/s,
    );
  });
});

describe('speed tiers', () => {
  it('returns speed tiers sorted by final speed descending', async () => {
    const result = await getSpeedTiers({ limit: 10 });
    expect(result.tiers.length).toBeGreaterThan(0);
    expect(result.tiers.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < result.tiers.length; i += 1) {
      expect(result.tiers[i - 1].finalSpeed).toBeGreaterThanOrEqual(result.tiers[i].finalSpeed);
    }
  });

  it('filters speed tiers by Pokémon', async () => {
    const result = await getSpeedTiers({ limit: 20, filters: [{ type: 'pokemon', values: ['Flutter Mane'] }] });
    expect(result.tiers.length).toBeGreaterThan(0);
    for (const tier of result.tiers) {
      expect(tier.pokemon.pokemon.name).toBe('Flutter Mane');
    }
  });

  it('filters speed tiers using any common spelling, including Showdown aliases', async () => {
    const result = await getSpeedTiers({ limit: 20, filters: [{ type: 'pokemon', values: ['lando-t'] }] });
    expect(result.tiers.length).toBeGreaterThan(0);
    for (const tier of result.tiers) {
      expect(tier.pokemon.pokemon.name).toBe('Landorus-Therian');
    }
  });
});
