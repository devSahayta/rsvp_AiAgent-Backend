// middleware/extractKindeUser.js
import { createRemoteJWKSet, jwtVerify } from "jose";
import { configDotenv } from "dotenv";
const KINDE_DOMAIN = process.env.KINDE_DOMAIN || "sahaytarsvp.kinde.com"; // ensure set in env
const JWKS_URL = `https://${KINDE_DOMAIN}/.well-known/jwks.json`;

// createRemoteJWKSet automatically fetches & caches JWKS and uses kid selection
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export const extractKindeUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return next(); // public request, continue

    const token = authHeader.split(" ")[1];
    if (!token) return next();

    // Verify JWT; this throws if invalid
    const { payload } = await jwtVerify(token, jwks, {
      // audience/issuer checks are optional but recommended if you know them
      // audience: process.env.KINDE_CLIENT_ID,
      issuer: `https://${KINDE_DOMAIN}`,
      algorithms: ["RS256"],
    });

    // Kinde uses sub as user ID
    if (payload?.sub) {
      req.user = { id: payload.sub, kinde_payload: payload };
    }

    return next();
  } catch (err) {
    // Token invalid or malformed; do not crash server.
    console.error("Kinde Decode Error:", err?.message || err);
    return next(); // leave req.user undefined; authenticateUser will block protected routes
  }
};
