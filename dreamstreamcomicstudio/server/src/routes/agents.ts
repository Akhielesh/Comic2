// Custom-agent library (Phase 9). CRUD over a user's saved swarm specialists, plus a
// read-only view of the 8 built-ins so a client library UI can show "what ships" next to
// "what I made". Mounted under requireAuth (`/api/agents`). Built-ins are never writable.

import { Router } from 'express';
import { AGENTS } from '../ai/agents/registry.js';
import { listCustomAgents, saveCustomAgent, deleteCustomAgent } from '../services/customAgents.js';

export const agentsRouter = Router();

// The read-only built-in specialists (prompts omitted — they're internal).
const builtinSummary = Object.values(AGENTS).map((a) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  toolNames: a.toolNames,
  builtin: true as const
}));

// GET /api/agents — built-ins + the user's saved custom agents.
agentsRouter.get('/', async (req, res, next) => {
  try {
    const custom = await listCustomAgents(req.user!.id).catch(() => []);
    res.json({ builtins: builtinSummary, custom });
  } catch (err) {
    next(err);
  }
});

// POST /api/agents — create or update a custom agent (sanitized server-side).
agentsRouter.post('/', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const saved = await saveCustomAgent(req.user!.id, {
      id: typeof body.id === 'string' ? body.id : undefined,
      name: body.name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      toolNames: body.toolNames,
      isPublic: body.isPublic
    });
    if (!saved) {
      return res.status(400).json({ error: { message: 'An agent needs a name and a system prompt.', code: 'AGENT_INVALID' } });
    }
    res.json({ agent: saved });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/agents/:id
agentsRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await deleteCustomAgent(req.user!.id, req.params.id);
    if (!ok) return res.status(404).json({ error: { message: 'Agent not found.' } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
