import { listCases, createCase, updateCase, deleteCase } from '../lib/db.js';
import { isAuthed } from '../lib/auth.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const rows = await listCases();
      // public read
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ cases: rows });
    }

    // All writes require admin session
    if (!isAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    if (req.method === 'POST') {
      if (!body.caseno) return res.status(400).json({ error: 'caseno required' });
      const row = await createCase(body);
      return res.status(200).json({ case: row });
    }
    if (req.method === 'PUT') {
      if (!body.id) return res.status(400).json({ error: 'id required' });
      const row = await updateCase(body.id, body);
      return res.status(200).json({ case: row });
    }
    if (req.method === 'DELETE') {
      const id = body.id || req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      await deleteCase(id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
