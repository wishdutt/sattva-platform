import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createLambdaDeps } from '../bootstrap';
import type { AppDeps } from '../deps';
import { buildRouter } from '../http/routes';

const router = buildRouter();
let depsPromise: Promise<AppDeps> | undefined;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  depsPromise ??= createLambdaDeps().catch((err: unknown) => {
    depsPromise = undefined; // retry initialization on the next invocation
    throw err;
  });
  const deps = await depsPromise;
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const res = await router.handle(deps, {
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: event.headers ?? {},
    query: event.queryStringParameters ?? {},
    body,
    requestId: event.requestContext.requestId,
  });
  return { statusCode: res.status, headers: res.headers, body: res.body };
}
