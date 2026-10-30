import { createHash } from "node:crypto";
import {
  createDefaultChannelAdapterFactory,
  ChannelAdapterError,
  type ChannelAdapter,
  type ChannelAdapterFactory,
  type ChannelKind,
  type InboundMessage,
  type InlineKeyboardButton,
} from "@pihub/channels";
import type { ChannelObservedStatus, ChannelRecord } from "./store.js";

/**
 * Manager-owned adapter lifecycle (design §1.4): desired set in, live adapters
 * out. The Manager is the only party that holds a plaintext channel token, in
 * memory, for the lifetime of the adapter — it is never written to `agent.json`
 * and never written to `channels.json`.
 */
export interface DesiredChannelInput {
  kind: ChannelKind;
  label?: string;
  token?: string;
  tokenDigest?: string;
  /**
   * Auto-pair window from the Dashboard projection (`null`/ausente = CLOSED).
   * Stored on the record and nothing else: part 2 is what acts on it.
   */
  pairingWindowEndsAt?: string | null;
}

export interface ChannelRuntimeRegistryDeps {
  adapterFactory?: ChannelAdapterFactory;
  /** Inbound plumbing is slice (c) part 2; the seam is wired here from day one. */
  onInbound?: (
    agentName: string,
    kind: ChannelKind,
    message: InboundMessage,
  ) => void;
  now?: () => number;
  /**
   * Sink for the failures that are reported and swallowed (a callback ACK). Default:
   * one `console.error` line with the same `[channels]` prefix the rest of the runtime
   * uses.
   */
  log?: (line: string) => void;
}

interface LiveAdapter {
  adapter: ChannelAdapter;
  /** In-memory custody only. Never serialized, never logged. */
  token: string;
  tokenDigest: string;
}

/** Digest of a token, used when the projection sends the token but no digest. */
export function tokenDigestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function resolveDigest(input: DesiredChannelInput): string | undefined {
  if (input.tokenDigest) return input.tokenDigest;
  if (input.token) return tokenDigestOf(input.token);
  return undefined;
}

/** Error text is persisted and mirrored to the Dashboard: it must not carry the token. */
function describeStartFailure(error: unknown, token: string): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return message.split(token).join("[redacted]").slice(0, 300);
}

export class ChannelRuntimeRegistry {
  private readonly adapterFactory: ChannelAdapterFactory;
  private onInbound:
    | ((agentName: string, kind: ChannelKind, message: InboundMessage) => void)
    | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly live = new Map<string, Map<ChannelKind, LiveAdapter>>();
  private readonly observed = new Map<string, Map<ChannelKind, ChannelRecord>>();

      constructor(deps: ChannelRuntimeRegistryDeps = {}) {
        this.adapterFactory =
          deps.adapterFactory ?? createDefaultChannelAdapterFactory();
        this.onInbound = deps.onInbound;
        this.now = deps.now ?? (() => Date.now());
        this.log = deps.log ?? ((line) => console.error(`[channels] ${line}`));
      }
    
      /**
       * Late-bound inbound consumer (slice (c) part 2b).
       *
       * The handler needs the turns bridge, the pairing machine and the outbox —
       * all of them composed AFTER the registry exists (`createApp` in the startup
       * chain). A constructor-only `onInbound` would force the composition root to
       * build the registry last, and then nothing could stop it on shutdown. This
       * is the one setter, and it is set-once-per-registry in practice: the
       * adapters themselves only ever call through `this.onInbound?.(...)`.
       */
      attachInbound(
        handler: (agentName: string, kind: ChannelKind, message: InboundMessage) => void,
      ): void {
        this.onInbound = handler;
      }
    
      /**
       * The transport door the outbox uses: send through the LIVE adapter of that
       * Agent + kind. No adapter (stopped, never started, started without a
       * credential) is a `unavailable` failure — i.e. a retryable one, because the
       * row that asked for it is still valid and the channel may come back. The
       * decision of *whether to retry* stays in the outbox; this only reports.
       *
       * `keyboard` (T6b) is passed through untouched: rows of buttons are part of
       * the message the outbox already accepted, and validating them is the
       * adapter's job (it answers `invalid_keyboard`, which the outbox treats as
       * terminal). This layer transports, it does not interpret.
       */
      async send(
        agentName: string,
        kind: ChannelKind,
        input: { chatId: string; text: string; keyboard?: InlineKeyboardButton[][] },
      ): Promise<{ messageId: string }> {
        const entry = this.live.get(agentName)?.get(kind);
        if (!entry) {
          throw new ChannelAdapterError({
            code: "unavailable",
            message: `no live "${kind}" adapter for agent "${agentName}"`,
          });
        }
        return entry.adapter.send(input);
      }

      /**
       * Acknowledge a button press (T6b) so the sender's client stops its spinner.
       *
       * This is deliberately NOT a delivery: there is no queue, no retry and no
       * `OutboxRow`, because an ACK is worthless once the press is old — the answer
       * the human keeps is the message the outbox sends. So:
       * - no live adapter, or an adapter written before keyboards existed → resolve
       *   silently (nothing to answer through, nothing to report);
       * - the transport rejecting the ACK → one log line, never a throw: the press
       *   already happened and the inbound path that called this still owes the
       *   human its real answer.
       */
      async answerCallback(
        agentName: string,
        kind: ChannelKind,
        callbackQueryId: string,
        text?: string,
      ): Promise<void> {
        const entry = this.live.get(agentName)?.get(kind);
        const answer = entry?.adapter.answerCallback;
        if (!entry || !answer) return;
        try {
          await answer.call(entry.adapter, callbackQueryId, text);
      } catch (error) {
          this.log(
            `callback ACK failed agent=${agentName} kind=${kind}: ${String(error)}`,
          );
        }
      }
    
      /** Every Agent the registry is currently polling for (shutdown, drain-all). */
      liveAgents(): string[] {
        return [...this.live.keys()].filter((name) => (this.live.get(name)?.size ?? 0) > 0);
      }
    
      /**
       * Manager shutdown: stop every adapter so no bot polls past process death.
       * Silent and best-effort by construction (`quietStop`), and it clears the
       * observed maps because a report about an adapter that no longer exists
       * would be a lie.
       */
      async stopAll(): Promise<void> {
        for (const agentName of [...this.live.keys()]) await this.stopAgent(agentName);
      }

  /**
   * Replace-all convergence for one Agent: kinds that disappeared are stopped
   * silently, kinds whose digest changed are re-created, and a kind that still
   * carries the same digest keeps its live adapter (an idempotent projection
   * must not reconnect a polling bot on every Dashboard reconcile).
   */
  async replaceAll(
    agentName: string,
    desired: readonly DesiredChannelInput[],
  ): Promise<ChannelRecord[]> {
    const timestamp = this.now();
    const previousLive = this.live.get(agentName) ?? new Map<ChannelKind, LiveAdapter>();
    const previousRecords =
      this.observed.get(agentName) ?? new Map<ChannelKind, ChannelRecord>();

    const desiredByKind = new Map<ChannelKind, DesiredChannelInput>();
    for (const entry of desired) desiredByKind.set(entry.kind, entry);

    const nextLive = new Map<ChannelKind, LiveAdapter>();
    const nextRecords = new Map<ChannelKind, ChannelRecord>();

    for (const [kind, input] of desiredByKind) {
      const token = input.token;
      const tokenDigest = resolveDigest(input);
      const running = previousLive.get(kind);
      const before = previousRecords.get(kind);

      const record = (
        observedStatus: ChannelObservedStatus,
        extra: Partial<ChannelRecord> = {},
      ): ChannelRecord => {
        const next: ChannelRecord = {
          kind,
          observedStatus,
          updatedAt: timestamp,
          ...(input.label !== undefined ? { label: input.label } : {}),
              ...(tokenDigest !== undefined ? { tokenDigest } : {}),
              ...(input.pairingWindowEndsAt !== undefined
                ? { pairingWindowEndsAt: input.pairingWindowEndsAt }
                : {}),
          ...(before?.lastSeenAt !== undefined ? { lastSeenAt: before.lastSeenAt } : {}),
          ...extra,
        };
        return next;
      };

      // No credential in this projection: whatever was running must go, and the
      // channel is observed as unpaired (never "assume it is still connected").
      if (!token) {
        if (running) await this.quietStop(running.adapter);
        nextRecords.set(kind, record("unpaired"));
        continue;
      }

      if (running && running.tokenDigest === tokenDigest) {
        nextLive.set(kind, running);
        nextRecords.set(
          kind,
          record(before?.observedStatus ?? "active", {
            lastSeenAt: timestamp,
            ...(before?.lastError !== undefined ? { lastError: before.lastError } : {}),
          }),
        );
        continue;
      }

      // Token rotated / adapter re-created: silent teardown first, no farewell.
      if (running) await this.quietStop(running.adapter);

      const adapter = this.adapterFactory(kind);
      if (!adapter) {
        nextRecords.set(
          kind,
          record("error", { lastError: `no channel adapter for kind "${kind}"` }),
        );
        continue;
      }

      try {
        await adapter.start({
          token,
          onInbound: (message) => this.onInbound?.(agentName, kind, message),
        });
      } catch (error) {
        nextRecords.set(
          kind,
          record("error", { lastError: describeStartFailure(error, token) }),
        );
        continue;
      }
      nextLive.set(kind, {
        adapter,
        token,
        tokenDigest: tokenDigest ?? tokenDigestOf(token),
      });
      nextRecords.set(kind, record("active", { lastSeenAt: timestamp }));
    }

    // Kinds that are simply gone from the desired set: silent teardown (I2 —
    // replace-all means "remove", never "keep what you already had").
    for (const [kind, entry] of previousLive) {
      if (!desiredByKind.has(kind)) await this.quietStop(entry.adapter);
    }

    this.live.set(agentName, nextLive);
    this.observed.set(agentName, nextRecords);
    return [...nextRecords.values()].sort((a, b) => a.kind.localeCompare(b.kind));
  }
  observedOf(agentName: string): ChannelRecord[] {
    return [...(this.observed.get(agentName)?.values() ?? [])].sort((a, b) =>
      a.kind.localeCompare(b.kind),
    );
  }

  isRunning(agentName: string, kind: ChannelKind): boolean {
    return this.live.get(agentName)?.has(kind) ?? false;
  }

    /**
     * `DELETE /agents/:name/channels/:kind`: teardown of ONE kind, leaving the
     * other live adapters alone (a `replaceAll` cannot express this — the
     * plaintext tokens of the surviving kinds live only in memory here). Silent
     * stop, no farewell, and the observed record disappears: "removed" must not
     * keep reporting an adapter that no longer exists.
     * Returns the kinds still live after the removal.
     */
    async remove(agentName: string, kind: ChannelKind): Promise<ChannelKind[]> {
      const entries = this.live.get(agentName);
      const running = entries?.get(kind);
      if (running) {
        entries?.delete(kind);
        await this.quietStop(running.adapter);
      }
      const records = this.observed.get(agentName);
      records?.delete(kind);
      return [...(entries?.keys() ?? [])];
    }
    
    /** Purge / Agent deletion: stop everything, keep no desired state behind. */
  async stopAgent(agentName: string): Promise<void> {
    const entries = this.live.get(agentName);
    if (entries) {
      for (const entry of entries.values()) await this.quietStop(entry.adapter);
    }
    this.live.delete(agentName);
    this.observed.delete(agentName);
  }

  private async quietStop(adapter: ChannelAdapter): Promise<void> {
    try {
      await adapter.stop();
    } catch {
      // Teardown is silent and best-effort: a transport that cannot confirm a
      // stop must not fail the projection that asked for it.
    }
  }
}
