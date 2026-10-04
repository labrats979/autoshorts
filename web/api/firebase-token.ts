import { verifyToken } from "@clerk/backend";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// Exchanges a Clerk session token for a Firebase custom token, so the desktop app can
// use Firestore with the Clerk user id as the Firebase uid (see firestore.rules).
//
// Required Vercel environment variables:
//   CLERK_SECRET_KEY          Clerk dashboard > API keys
//   FIREBASE_SERVICE_ACCOUNT  Firebase service account JSON (Project settings > Service accounts)
// Optional:
//   CLERK_AUTHORIZED_PARTIES  comma-separated origins allowed in the token's azp claim

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function firebaseApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request): Promise<Response> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return json({ error: "CLERK_SECRET_KEY is not set on the server" }, 500);

  const sessionToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!sessionToken) return json({ error: "Missing Clerk session token" }, 401);

  const authorizedParties = process.env.CLERK_AUTHORIZED_PARTIES?.split(",")
    .map((party) => party.trim())
    .filter(Boolean);

  let userId: string;
  try {
    const claims = await verifyToken(sessionToken, {
      secretKey,
      authorizedParties: authorizedParties?.length ? authorizedParties : undefined,
    });
    userId = claims.sub;
  } catch {
    return json({ error: "Invalid or expired Clerk session token" }, 401);
  }

  try {
    const token = await getAuth(firebaseApp()).createCustomToken(userId);
    return json({ token });
  } catch (err) {
    console.error("Failed to mint Firebase custom token", err);
    return json({ error: "Could not create a Firebase token" }, 500);
  }
}
