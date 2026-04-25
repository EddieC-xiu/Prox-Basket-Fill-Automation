#!/usr/bin/env node
/**
 * CLI entry point
 *
 * Usage:
 *   npm run fill:basket -- --retailer=kroger --zip=90046 --input=sample-basket.json
 *   npm run fill:basket -- --retailer=kroger --zip=90046 --input=sample-basket.json --json
 */

import { Command } from "commander";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import Table from "cli-table3";
import { fillBasket } from "./basket";
import type { BasketInput, BasketMatch } from "./types";

const program = new Command();

program
  .name("fill-basket")
  .description("Fill a grocery basket from a shopping list using Kroger")
  .requiredOption("--input <file>", "Path to JSON shopping list file")
  .option("--retailer <name>", "Retailer name (overrides value in input file)")
  .option("--zip <code>", "ZIP code (overrides value in input file)")
  .option("--json", "Output raw JSON instead of a table")
  .parse(process.argv);

const opts = program.opts<{
  input: string;
  retailer?: string;
  zip?: string;
  json?: boolean;
}>();

async function main() {
  const inputPath = path.resolve(opts.input);
  if (!fs.existsSync(inputPath)) {
    console.error(chalk.red(`Input file not found: ${inputPath}`));
    process.exit(1);
  }

  const rawInput = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as Partial<BasketInput>;
  const input: BasketInput = {
    retailer: opts.retailer ?? rawInput.retailer ?? "kroger",
    zip:      opts.zip      ?? rawInput.zip      ?? "90046",
    items:    rawInput.items ?? [],
  };

  if (input.items.length === 0) {
    console.error(chalk.red('Input file must contain at least one item in "items" array.'));
    process.exit(1);
  }

  console.log(
    chalk.cyan(
      `\nFilling basket for ${chalk.bold(input.retailer)} near ZIP ${chalk.bold(input.zip)} …\n`
    )
  );

  const result = await fillBasket(input);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // ── Pretty table ──────────────────────────────────────────────────────────
  const table = new Table({
    head: [
      chalk.white("Requested"),
      chalk.white("Matched Product"),
      chalk.white("Price"),
      chalk.white("Size"),
      chalk.white("Confidence"),
      chalk.white("Notes"),
    ],
    colWidths: [18, 36, 8, 10, 12, 32],
    wordWrap: true,
  });

  for (const m of result.items) {
    table.push(itemRow(m));
  }

  console.log(table.toString());

  // ── Summary ───────────────────────────────────────────────────────────────
  const filledCount = result.items.filter((m) => !m.is_unmatched).length;
  const substitutes = result.items.filter((m) => m.is_substitute).length;
  const unmatched   = result.items.filter((m) => m.is_unmatched).length;

  console.log(
    `\n${chalk.green(`✓ Filled ${filledCount}/${result.items.length} items`)}` +
    (substitutes ? chalk.yellow(` (${substitutes} substitutes)`) : "") +
    (unmatched   ? chalk.red(   ` (${unmatched} unmatched)`)    : "") +
    `  fill rate: ${chalk.bold((result.fill_rate * 100).toFixed(0) + "%")}` +
    `  run ID: ${chalk.dim(String(result.run_id))}\n`
  );
}

function itemRow(m: BasketMatch): string[] {
  const label = m.is_unmatched
    ? chalk.red("✗ " + m.requested_query)
    : m.is_substitute
    ? chalk.yellow("~ " + m.requested_query)
    : chalk.green("✓ " + m.requested_query);

  const name = m.matched_product_name
    ? (m.is_substitute ? chalk.yellow(m.matched_product_name) : m.matched_product_name)
    : chalk.dim("—");

  const price = m.price != null ? `$${m.price.toFixed(2)}` : chalk.dim("—");
  const size  = m.size  ?? chalk.dim("—");
  const conf  = m.is_unmatched
    ? chalk.red("unmatched")
    : m.match_confidence >= 0.8
    ? chalk.green(`${(m.match_confidence * 100).toFixed(0)}%`)
    : chalk.yellow(`${(m.match_confidence * 100).toFixed(0)}%`);

  return [label, name, price, size, conf, m.match_notes];
}

main().catch((err) => {
  console.error(chalk.red("Error: " + (err as Error).message));
  process.exit(1);
});
