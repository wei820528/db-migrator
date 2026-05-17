const router = require('express').Router();
const jobs = require('../lib/jobs');

router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

module.exports = router;
