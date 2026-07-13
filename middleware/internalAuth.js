// middleware/internalAuth.js
//
// Guards routes meant to be called only by the scheduler service, not the
// browser. Do NOT put these behind Kinde auth — the scheduler has no user
// session to send.

export function internalAuth(req, res, next) {
  const provided = req.headers["x-internal-secret"];
  const expected = process.env.INTERNAL_API_SECRET;

  if (!expected) {
    console.error(
      "[internalAuth] INTERNAL_API_SECRET is not set — refusing all internal requests",
    );
    return res.status(500).json({ error: "Internal auth not configured" });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized (internal)" });
  }
  next();
}
