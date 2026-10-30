import { beforeAll, describe, expect, test } from "bun:test";
import { SignJWT, generateKeyPair } from "jose";
import { JwtProviderIdentity } from "../../src/auth/provider-identity";

// Keycloak real, do docker compose (realm "wagering", importado de keycloak/realm.json).
const base = process.env.KEYCLOAK_BASE_URL ?? "http://localhost:8080";
const issuer = `${base}/realms/wagering`;
const jwksUrl = `${issuer}/protocol/openid-connect/certs`;
const tokenUrl = `${issuer}/protocol/openid-connect/token`;

const identity = new JwtProviderIdentity({ issuer, audience: "wagering-api", jwksUrl });

let validToken = "";

async function fetchUserToken(): Promise<string> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "wagering-api",
      username: "provider-a",
      password: "provider-a-secret",
    }),
  });
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

beforeAll(async () => {
  // O Keycloak leva alguns segundos para importar o realm no primeiro start
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      validToken = await fetchUserToken();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`Keycloak não respondeu em 120s (suba o docker compose): ${String(lastError)}`);
});

describe("autenticação com Keycloak real (seção 2)", () => {
  test("token válido do provedor: identifica provider-a pelo claim provider_id", async () => {
    const result = await identity.authenticate({ authorization: `Bearer ${validToken}` });
    expect(result).toEqual({ providerId: "provider-a" });
  });

  test("sem header Authorization: não autenticado", async () => {
    expect(await identity.authenticate({})).toBeNull();
  });

  test("esquema diferente de Bearer: não autenticado", async () => {
    expect(await identity.authenticate({ authorization: "Basic abc123" })).toBeNull();
  });

  test("token malformado: não autenticado", async () => {
    expect(await identity.authenticate({ authorization: "Bearer lixo.lixo.lixo" })).toBeNull();
  });

  test("token assinado por outra chave (forjado), mesmo com issuer e audiência corretos: não autenticado", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ provider_id: "provider-a" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience("wagering-api")
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(await identity.authenticate({ authorization: `Bearer ${forged}` })).toBeNull();
  });

  test("token válido para outra audiência: não autenticado", async () => {
    const otherAudience = new JwtProviderIdentity({ issuer, audience: "outra-api", jwksUrl });
    expect(await otherAudience.authenticate({ authorization: `Bearer ${validToken}` })).toBeNull();
  });
});
