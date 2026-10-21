import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoStore } from '../src/store/dynamo';

const ddb = mockClient(DynamoDBDocumentClient);

const cancelled = (codes: string[]) =>
  Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('DynamoStore conditional writes', () => {
  let store: DynamoStore;
  beforeEach(() => {
    ddb.reset();
    store = new DynamoStore('table', new DynamoDBClient({ region: 'us-east-1' }));
  });

  it('admission uses a transaction with a capacity condition and host reservation', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await expect(store.admitParticipant('e1', 'u1', 'VIEWER', 50, '2026-01-01T00:00:00Z')).resolves.toEqual({
      status: 'admitted',
    });
    const input = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    const [session, capacity] = input.TransactItems!;
    expect(session!.Put!.ConditionExpression).toBe('attribute_not_exists(PK) OR #state = :left');
    expect(capacity!.Update!.ConditionExpression).toContain('#total < :maxMinusOne');
    expect(capacity!.Update!.ExpressionAttributeValues).toMatchObject({ ':max': 50, ':maxMinusOne': 49 });
  });

  it('maps cancellation reasons to already_admitted / full', async () => {
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(['ConditionalCheckFailed', 'None']))
      .rejectsOnce(cancelled(['None', 'ConditionalCheckFailed']));
    expect((await store.admitParticipant('e1', 'u1', 'VIEWER', 50, 'now')).status).toBe('already_admitted');
    expect((await store.admitParticipant('e1', 'u1', 'VIEWER', 50, 'now')).status).toBe('full');
  });

  it('speaker approval guards status and the speaker counter atomically', async () => {
    ddb.on(TransactWriteCommand).rejectsOnce(cancelled(['None', 'ConditionalCheckFailed']));
    expect((await store.approveSpeakerRequest('e1', 'r1', 5, 'mod', 'now')).status).toBe('speaker_limit');
    const input = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(input.TransactItems![0]!.Update!.ConditionExpression).toBe('#status = :pending');
    expect(input.TransactItems![1]!.Update!.ConditionExpression).toBe(
      'attribute_not_exists(speakers) OR speakers < :max',
    );
  });

  it('invitation acceptance is conditional on PENDING and not expired', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await store.acceptInvitation(
      { id: 'i1', eventId: 'e1' } as never,
      { eventId: 'e1', userId: 'u1', eventStartAt: 's' } as never,
      '2026-01-01T00:00:00Z',
    );
    const update = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Update!;
    expect(update.ConditionExpression).toBe('#status = :pending AND expiresAt > :now');
  });

  it('event updates maintain the status index and bump the version', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { PK: 'EVENT#e1', SK: 'META', id: 'e1', status: 'LIVE' } });
    const updated = await store.updateEvent('e1', { status: 'LIVE' }, { ifStatusIn: ['SCHEDULED', 'READY'] });
    expect(updated).toEqual({ id: 'e1', status: 'LIVE' });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain('#g2pk = :g2pk');
    expect(input.UpdateExpression).toContain('#version = #version + :one');
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND #status IN (:s0, :s1)');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':g2pk': 'STATUS#LIVE' });
  });

  it('strips key attributes on read', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'USER#1', SK: 'PROFILE', GSI1PK: 'x', entity: 'User', userId: '1' } });
    expect(await store.getUser('1')).toEqual({ userId: '1' });
  });
});
