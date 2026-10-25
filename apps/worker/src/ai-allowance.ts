/**
 * The AI review's daily allowance, as one Durable Object. KV has no atomic read-modify-write, so two reviews starting
 * together could both pass a KV counter; a Durable Object handles one request at a time and its storage waits block
 * other requests, so checking and reserving are one step. One instance ("global") holds every count.
 */
type Storage = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<boolean>; deleteAll?(): Promise<void> };
export type AllowanceRequest = { action: 'reserve'; userId: string; day: string; perUser: number; global: number; lockMs: number } | { action: 'release'; userId: string };
export type AllowanceReply = { ok: true } | { ok: false; reason: 'busy' | 'user-limit' | 'global-limit' };

export class AiAllowance {
  constructor(private readonly state: { storage: Storage }) {}

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
    const now = Date.now();
    if (((await storage.get<number>(lock)) ?? 0) > now) return { ok: false, reason: 'busy' };
    // Counts are per UTC day; an older day's counts are dropped on the first reservation of a new day.
    if ((await storage.get<string>('day')) !== body.day) {
      if (storage.deleteAll) await storage.deleteAll();
      await storage.put('day', body.day);
    }
    const mine = (await storage.get<number>(`user:${body.userId}`)) ?? 0;
    if (mine >= body.perUser) return { ok: false, reason: 'user-limit' };
    const everyone = (await storage.get<number>('global')) ?? 0;
    if (everyone >= body.global) return { ok: false, reason: 'global-limit' };
    await storage.put(`user:${body.userId}`, mine + 1);
    await storage.put('global', everyone + 1);
    await storage.put(lock, now + body.lockMs);
    return { ok: true };
  }
}
