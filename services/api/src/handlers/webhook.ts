import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createLambdaDeps } from '../bootstrap';
import type { AppDeps } from '../deps';
import { errorResponse } from '../http/router';
import { handleLiveKitWebhook } from '../services/webhooks';

let depsPromise: Promise<AppDeps> | undefined;

/** POST /api/v1/webhooks/livekit — unauthenticated route; trust comes only from the LiveKit signature. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  depsPromise ??= createLambdaDeps().catch((err: unknown) => {
    depsPromise = undefined;
    throw err;
  });
  const deps = await depsPromise;
  const requestId = event.requestContext.requestId;
  try {
    const raw = event.body ?? '';
    // The signature covers the exact bytes LiveKit sent, so decode but never re-serialize.
    const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    const auth = event.headers?.authorization ?? event.headers?.Authorization;
    await handleLiveKitWebhook(deps, body, auth);
    return { statusCode: 200, body: '' };
  } catch (err) {
    const res = errorResponse(err, requestId, deps.logger);
    return { statusCode: res.status, headers: res.headers, body: res.body };
  }
}
