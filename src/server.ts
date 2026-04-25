/**
 * Express API + static UI server
 *
 * Routes:
 *   POST /api/basket          – fill a basket (JSON body = BasketInput)
 *   GET  /api/runs            – list recent basket runs
 *   GET  /api/runs/:id        – detail for a single run
 *   GET  /                    – single-page web UI
 */

import express, { Request, Response, NextFunction } from "express";
import path from "path";
import dotenv from "dotenv";
import { fillBasket } from "./basket";
import { listRuns, getRunDetail } from "./db";
import type { BasketInput } from "./types";

dotenv.config();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = express();
app.use(express.json());

// Serve static assets from /public
app.use(express.static(path.resolve(__dirname, "../public")));

// ── API ────────────────────────────────────────────────────────────────────

app.post("/api/basket", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = req.body as BasketInput;
    if (!input?.items?.length) {
      res.status(400).json({ error: "items array is required and must not be empty" });
      return;
    }
    const result = await fillBasket(input);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/api/runs", (_req: Request, res: Response) => {
  res.json(listRuns(30));
});

app.get("/api/runs/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    res.json(getRunDetail(id));
  } catch (err) {
    next(err);
  }
});

// Catch-all: serve index.html for any non-API route (SPA support)
app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "internal server error";
  console.error("[server]", message);
  res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Basket Filler API running at http://localhost:${PORT}`);
});

export default app;
