import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
};

let client: Client | undefined;

async function connectMcpClient(): Promise<Client> {
  client = new Client({ name: 'pokemon-battle-mcp-e2e', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  if (client) {
    await client.close();
    client = undefined;
  }
});

describe('MCP stdio e2e', () => {
  it('allows a real MCP client to list and call tools', async () => {
    const mcpClient = await connectMcpClient();
    const tools = await mcpClient.listTools();

    expect(tools.tools.map(tool => tool.name).sort()).toEqual(
      [
        'calculate_stats',
        'check_damage_matchup',
        'get_meta_snapshot',
        'get_pokemon_options',
        'get_speed_tiers',
        'optimize_offensive_spread',
        'optimize_speed_spread',
        'optimize_survival_spread',
      ].sort(),
    );

    const result = (await mcpClient.callTool({
      name: 'calculate_stats',
      arguments: {
        pokemon: {
          pokemon: {
            name: 'Flutter Mane',
            nature: 'Timid',
            sp: { spa: 32, spe: 32 },
          },
        },
      },
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.rawStats).toEqual({
      hp: 130,
      atk: 67,
      def: 75,
      spa: 187,
      spd: 155,
      spe: 205,
    });
    expect(result.content).toEqual([]);
  }, 15_000);

  it('exposes useful JSON input schemas through tools/list (tool search)', async () => {
    const mcpClient = await connectMcpClient();
    const { tools } = await mcpClient.listTools();
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));

    const expectedTopLevelProperties: Record<string, string[]> = {
      get_meta_snapshot: ['limit', 'includeBuilds'],
      get_pokemon_options: ['pokemon', 'includeTeammates', 'includeCounters'],
      calculate_stats: ['pokemon', 'context'],
      check_damage_matchup: ['attacker', 'defender', 'move', 'context'],
      optimize_offensive_spread: [
        'attacker',
        'defender',
        'move',
        'context',
        'offensiveStat',
        'targetDamageRatio',
        'allowedNatures',
        'spBudget',
      ],
      optimize_survival_spread: [
        'defender',
        'attacker',
        'move',
        'context',
        'defensiveStat',
        'survivalThreshold',
        'allowedNatures',
        'spBudget',
      ],
      optimize_speed_spread: ['self', 'target', 'context', 'relation', 'allowedNatures', 'spBudget'],
      get_speed_tiers: ['limit', 'includeModifiers', 'filters'],
    };

    for (const [toolName, propertyNames] of Object.entries(expectedTopLevelProperties)) {
      const schema = byName[toolName]?.inputSchema as JsonSchemaObject | undefined;
      expect(schema, `${toolName} should be present`).toBeTruthy();
      expect(schema?.type, `${toolName} schema should be an object`).toBe('object');
      expect(Object.keys(schema?.properties ?? {}), `${toolName} top-level schema properties`).toEqual(
        expect.arrayContaining(propertyNames),
      );
      expect(byName[toolName]?.outputSchema?.type, `${toolName} should expose an output schema`).toBe(
        'object',
      );
    }

    expect((byName.get_pokemon_options.inputSchema as JsonSchemaObject).required).toContain('pokemon');
    expect((byName.check_damage_matchup.inputSchema as JsonSchemaObject).required).toEqual(
      expect.arrayContaining(['attacker', 'defender', 'move']),
    );
    expect((byName.optimize_speed_spread.inputSchema as JsonSchemaObject).required).toEqual(
      expect.arrayContaining(['self', 'target', 'relation']),
    );

    const calculateStatsSchema = byName.calculate_stats.inputSchema as JsonSchemaObject;
    const battlePokemonSchema = calculateStatsSchema.properties?.pokemon;
    const championPokemonSchema = battlePokemonSchema?.properties?.pokemon;
    const spSchema = championPokemonSchema?.properties?.sp;
    expect(championPokemonSchema?.required).toEqual(expect.arrayContaining(['name', 'sp', 'nature']));
    expect(spSchema?.properties?.hp.maximum).toBe(32);
    expect(spSchema?.properties?.hp.minimum).toBe(0);
    expect(spSchema?.properties?.spe).toBeTruthy();
    expect(championPokemonSchema?.properties?.abilitySource.enum).toEqual([
      'species-default',
      'mega-default',
      'battle-changed',
      'manual',
    ]);
    expect((byName.calculate_stats.outputSchema as JsonSchemaObject).properties?.inputCorrections).toBeTruthy();

    const speedSchema = byName.optimize_speed_spread.inputSchema as JsonSchemaObject;
    expect(speedSchema.properties?.relation.enum).toEqual(['outspeed', 'speedTie', 'underspeed']);
    expect(speedSchema.properties?.target.anyOf ?? speedSchema.properties?.target.oneOf).toBeTruthy();
  }, 15_000);

  it('returns handler-level errors as tool error results without breaking output-schema validation', async () => {
    const mcpClient = await connectMcpClient();

    // Unknown species triggers a UserInputError inside the handler. Because every tool declares an
    // output schema, the error result must NOT carry schema-violating structuredContent, otherwise
    // the SDK client rejects the whole call.
    const result = (await mcpClient.callTool({
      name: 'calculate_stats',
      arguments: { pokemon: { pokemon: { name: 'NotARealMon', nature: 'Timid', sp: {} } } },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(/Unknown Pokémon species/);
  }, 15_000);

  it('enforces input schemas through the transport (rejects out-of-range and missing fields)', async () => {
    const mcpClient = await connectMcpClient();

    const outOfRange = (await mcpClient.callTool({
      name: 'calculate_stats',
      arguments: { pokemon: { pokemon: { name: 'Flutter Mane', nature: 'Timid', sp: { spa: 99 } } } },
    })) as CallToolResult;
    expect(outOfRange.isError).toBe(true);
    expect((outOfRange.content[0] as { text: string }).text).toMatch(/Input validation error/);

    const missingMove = (await mcpClient.callTool({
      name: 'check_damage_matchup',
      arguments: {
        attacker: { pokemon: { name: 'Incineroar', nature: 'Careful', sp: {} } },
        defender: { pokemon: { name: 'Incineroar', nature: 'Careful', sp: {} } },
      },
    })) as CallToolResult;
    expect(missingMove.isError).toBe(true);
    expect((missingMove.content[0] as { text: string }).text).toMatch(/Input validation error/);
  }, 15_000);
});
