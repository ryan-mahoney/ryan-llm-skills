import { executeOperation } from './engine.mjs';
process.once('message', async input => {
  let sent = false;
  const accepted = value => { if (!sent && process.connected) { sent = true; process.send({ value }); } };
  try { await executeOperation(input, { accepted }); }
  catch { if (!sent && process.connected) process.send({ error: 'Dev server operation is busy or unavailable. Refresh its status.' }); }
  finally { if (process.connected) process.disconnect(); }
});
