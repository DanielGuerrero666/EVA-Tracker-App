// Last middleware in the chain. Never forward err.message from unexpected
// (non-validation) errors to the client — it can leak SQL text or internals —
// only the status/message an operation explicitly set are safe to expose.
function errorHandler(err, req, res, _next) {
  console.error(err);

  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }

  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler };
