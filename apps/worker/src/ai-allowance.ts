/**
 * The AI review's daily allowance, as one Durable Object. KV has no atomic read-modify-write, so two reviews starting
 * together could both pass a KV counter; a Durable Object handles one request at a time and its storage waits block
 * other requests, so checking and reserving are one step. One instance ("global") holds every count.
 */
type Storage = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<boolean>; list<T>(options: { prefix: string }): Promise<Map<string, T>> };
export type AllowanceRequest = { action: 'reserve'; userId: string; perUser: number; global: number; lockMs: number } | { action: 'release'; userId: string };
export type AllowanceReply = { ok: true } | { ok: false; reason: 'busy' | 'user-limit' | 'global-limit' };

export class AiAllowance {
  constructor(private readonly state: { storage: Storage }, private readonly now = () => Date.now()) {}

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as AllowanceRequest;
    return Response.json(await this.handle(body));
  }

  /** Requests run one after another, so a check and its reservation are never split by another request. */
  private queue: Promise<unknown> = Promise.resolve();
  handle(body: AllowanceRequest): Promise<AllowanceReply> {
    const next = this.queue.then(() => this.run(body));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(body: AllowanceRequest): Promise<AllowanceReply> {
    const { storage } = this.state;
    const lock = `busy:${body.userId}`;
    if (body.action === 'release') { await storage.delete(lock); return { ok: true }; }
    const now = this.now();
    if (((await storage.get<number>(lock)) ?? 0) > now) return { ok: false, reason: 'busy' };
    // Counts are per UTC day, decided here (never by the caller, whose clock or delay could name another day). On the
    // first reservation of a new day the older counts are deleted; running-review locks are kept.
    const day = new Date(now).toISOString().slice(0, 10);
    if ((await storage.get<string>('day')) !== day) {
      for (const key of (await storage.list<number>({ prefix: 'count:' })).keys()) if (!key.startsWith(`count:${day}:`)) await storage.delete(key);
      await storage.put('day', day);
    }
    const userKey = `count:${day}:user:${body.userId}`;
    const globalKey = `count:${day}:global`;
    const mine = (await storage.get<number>(userKey)) ?? 0;
    if (mine >= body.perUser) return { ok: false, reason: 'user-limit' };
    const everyone = (await storage.get<number>(globalKey)) ?? 0;
    if (everyone >= body.global) return { ok: false, reason: 'global-limit' };
    await storage.put(userKey, mine + 1);
    await storage.put(globalKey, everyone + 1);
    await storage.put(lock, now + body.lockMs);
    return { ok: true };
  }
}
