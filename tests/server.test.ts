import { describe, expect, it } from 'vitest';
import { createServer } from '../src/index';
import { handleCalculateStats, handleCheckDamageMatchup } from '../src/tools/damage';

describe('MCP server wiring', () => {
  it('creates a server with all eight tools registered', () => {
    const server = createServer();
    // Access the internal tool registry to assert registration.
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registered).sort()).toEqual(
      [
        'calculate_stats',
        'check_damage_matchup',
        'get_meta_snapshot',
        'get_pokemon_options',
        'optimize_offensive_spread',
        'optimize_speed_spread',
        'optimize_survival_spread',
        'get_speed_tiers',
      ].sort(),
    );
  });
});

describe('tool handlers', () => {
  it('calculate_stats returns raw stats', async () => {
    const response = await handleCalculateStats({
      pokemon: { pokemon: { name: 'Flutter Mane', nature: 'Timid', sp: { spa: 32, spe: 32 } } },
    });
    expect(response.rawStats.spe).toBe(205);
  });

  it('check_damage_matchup returns a damage range', async () => {
    const response = await handleCheckDamageMatchup({
      attacker: { pokemon: { name: 'Landorus-Therian', nature: 'Adamant', item: 'Life Orb', sp: { atk: 32, spe: 32 } } },
      defender: { pokemon: { name: 'Incineroar', nature: 'Careful', sp: { hp: 32, spd: 2 } } },
      move: 'Earthquake',
      context: { format: 'doubles' },
    });
    expect(response.damageRange[0]).toBeGreaterThan(0);
    expect(response.damageRolls).toHaveLength(16);
  });
});
