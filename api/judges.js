import { listJudges, createJudge, updateJudge, deleteJudge } from '../lib/db.js';
import { isAuthed } from '../lib/auth.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ judges: await listJudges() });   // public (for dropdowns/filters)
    }
    if (!isAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    if (req.method === 'POST') {
      if (!body.name_en) return res.status(400).json({ error: 'name_en required' });
      return res.status(200).json({ judge: await createJudge(body) });
    }
    if (req.method === 'PUT') {
      if (!body.id) return res.status(400).json({ error: 'id required' });
      const out = await updateJudge(body.id, body, !!body.applyToCases);
      if (!out) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(out);   // { judge, propagated }
    }
    if (req.method === 'DELETE') {
      const id = body.id || req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      await deleteJudge(id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
