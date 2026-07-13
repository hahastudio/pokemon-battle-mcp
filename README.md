# Pokémon Battle Helper MCP Server

A TypeScript MCP server for **Pokémon Champions** battle assistance.

For the canonical design, data sources, battle model, tool schemas, solver behavior, and test strategy, see [`Architecture.md`](./Architecture.md).

## Tools

The server registers these MCP tools:

- `get_meta_snapshot`
- `get_pokemon_options`
- `calculate_stats`
- `check_damage_matchup`
- `optimize_offensive_spread`
- `optimize_survival_spread`
- `optimize_speed_spread`
- `get_speed_tiers`

All tools expose input/output schemas through MCP `tools/list`.

## Install / build / test

```bash
npm install
npm run build
npm test
```

`npm test` runs a pretest build and includes MCP stdio e2e tests that start `dist/index.js`, connect with the real `@modelcontextprotocol/sdk` client, call tools, and verify tool schemas.

## Run as an MCP server

```bash
npm run build
node dist/index.js
```

Example MCP client config:

```json
{
  "mcpServers": {
    "pokemon-battle": {
      "command": "node",
      "args": ["/absolute/path/to/pokemon-battle-mcp/dist/index.js"]
    }
  }
}
```

## Live meta defaults

The implementation uses Pikalytics English live data for the current Pokémon Champions ranked ladder. Default meta URL shape:

```text
https://www.pikalytics.com/api/p/2026-05/battledataregmbs3-1760
https://www.pikalytics.com/api/p/2026-05/battledataregmbs3-1760/garchomp
```

`get_meta_snapshot` and `get_pokemon_options` accept optional `format` request fields (`single`/`double`; default `double`). Pikalytics' `battledataregmbs3` key is the Champions doubles ladder, so `format` currently does not change the queried dataset. The season/regulation key (`battledataregmbs3`) and rating cutoff (`1760`) are internal constants; update them when the live regulation changes. The data month (`YYYY-MM`) is discovered automatically — a preferred month is tried first, then recent months are probed newest-first — because Pikalytics serves the literal JSON `false` for months without data.

## Pokémon name handling

All tools accept any common spelling of a Pokémon name and normalize it server-side (see `src/utils/pokemon-name.ts`):

- Showdown forme names and aliases: `Basculegion-F`, `lando-t`, `Urshifu-Rapid-Strike`.
- PokeAPI/Pikalytics-style slugs: `basculegion-female`, `urshifu-rapid-strike`.
- Space/punctuation variants: `Rotom Wash`, `Sirfetch'd`.

Material corrections (e.g. `basculegion-female` -> `Basculegion-F`) are reported in `inputCorrections`. For `get_pokemon_options`, a base-species request resolves to the only matching meta forme when unambiguous (`Floette` -> `Floette-Mega`, with a `formeResolved` correction); if several formes are ranked, the tool returns an error listing the candidates. When Pikalytics has no page for the requested forme and base-forme data is used instead, the response carries an explicit warning (`formeDataFallback`) instead of silently returning the wrong forme's data. Unknown names produce did-you-mean suggestions.

Calc-oriented tool handlers (`calculate_stats`, `check_damage_matchup`, and the SP optimizers)
also guard against the common LLM mistake of sending a bare base species for a current-format
forme request: if the submitted name is a canonical base species and the current meta has exactly
one matching forme, the handler rewrites it and reports `formeResolved` in `inputCorrections`
before doing the calculation. Ambiguous cases still require the client/model to specify the forme.

Recommended client/system instruction:

```text
For Pokémon Champions build, Mega, forme, damage, or speed questions, call get_pokemon_options
first for each named Pokémon and use the returned canonical Pokémon name/build in calculator
tools. Do not guess a base species when the user requested a Mega or forme. Item choices should
be passed exactly as provided by the user; this MCP does not validate item legality.
```

## Mega forme ability handling

When a request uses a Mega forme, the server canonicalizes stale or missing abilities to the fixed Mega ability before calculation and reports the change in `inputCorrections` plus `modifierBreakdown`. `get_pokemon_options` also returns the Mega ability for Mega forme requests, even when move/item/spread data has to come from a base-form meta page.

If the ability has already been changed in battle by Skill Swap, Worry Seed, Entrainment, etc., clients should send the current effective ability and mark it explicitly with `pokemon.abilitySource: "battle-changed"` or an active ability-change effect such as `{ "id": "abilitychanged" }`, `{ "id": "skillswap" }`, or `{ "id": "worryseed" }`. For ability suppression such as Gastro Acid, keep the actual ability and use `state.abilityEffect: "inactive"`.
