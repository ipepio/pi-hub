import type {
  HumanRequestChannel,
  HumanRequestChannelInput,
} from "../primary-channel/human-request-delivery.ts";

/**
 * Fix B1 (verify round) — the late-bound HITL door of the composition root.
 *
 * WHY THIS EXISTS. The spec (`agent-channels` → "Unified session delivery-by-origin",
 * case 3) says a waiting-human card is a proactive message: it leaves through the
 * SAME router/outbox as any other non-web message, and «can we deliver it?» is
 * answered by the BINDING. `composeChannels` builds exactly that seam (`hitl`) and
 * `HumanRequestDelivery` accepts it (`options.channel`). Nothing connected the two:
 * the composition root handed the delivery a legacy Bot API client keyed on
 * `agent.json.telegramToken` — a field the cutover stopped writing — so the card
 * was a silent no-op in production while the unit suite stayed green (it built the
 * delivery *with* the seam, i.e. tested a wiring that did not exist).
 *
 * WHY IT CANNOT BE A PLAIN VALUE. `runStartup` builds `TurnExecution` (and with it
 * `HumanRequestDelivery`) at step 8, while `composeChannels` runs at step 13 — the
 * seam simply does not exist yet when the delivery is constructed. This object is
 * the stable reference the delivery holds for the whole life of the process; the
 * composition root binds the real seam into it when step 13 arrives.
 *
 * The window is FAIL-CLOSED, never optimistic:
 * - `boundChatOf` answers `null`, which `HumanRequestDelivery` turns into its
 *   documented `HUMAN_REQUEST_DELIVERY_SKIPPED reason=no_bound_channel` — zero
 *   effects, zero side writes, and a human request that stays visible in the panel;
 * - `enqueue` rejects, so no caller can ever record a card as queued when there is
 *   nothing behind the door.
 *
 * No token and no chat id crosses this boundary in either direction.
 *
 * SHAPE: the door IS a `HumanRequestChannel` — the composition root hands
 * `HumanRequestDelivery({ channel: hitlDoor })` the door itself, nothing to unwrap —
 * and it also exposes the same two methods narrowed to `HumanRequestChannel` under
 * `.channel`, for a caller that wants to hold only the delivery face and never the
 * `bind` one. Both faces are the SAME closures over the same late reference, so
 * binding is visible through either and there is no second source of truth.
 */
export interface LateBoundHitl extends HumanRequestChannel {
  /**
   * The door narrowed to what `HumanRequestDelivery({ channel })` may call: no
   * `bind`, no `bound`. Behaviourally identical to the door itself.
   */
  readonly channel: HumanRequestChannel;
  /** Bind the seam `composeChannels` built. Re-binding replaces the previous door. */
  bind(hitl: HumanRequestChannel): void;
  /** Observable for tests and logs: is there anything behind the door yet? */
  readonly bound: boolean;
}

/** Error text of the unbound door — one vocabulary, easy to grep in the journal. */
const NOT_BOUND = "HITL channel door is not bound: no channel composition is live yet";

export function createLateBoundHitl(options: { log?: (line: string) => void } = {}): LateBoundHitl {
  const log = options.log ?? ((line: string) => console.error(line));
  let hitl: HumanRequestChannel | undefined;

  async function boundChatOf(agentName: string): Promise<string | null> {
    const seam = hitl;
    // Sin composición no hay destino: `null` es el skip documentado, no un fallo.
    return seam ? seam.boundChatOf(agentName) : null;
  }

  async function enqueue(input: HumanRequestChannelInput): Promise<void> {
    const seam = hitl;
    if (!seam) throw new Error(NOT_BOUND);
    await seam.enqueue(input);
  }

  const channel: HumanRequestChannel = { boundChatOf, enqueue };

  return {
    channel,
    boundChatOf,
    enqueue,
    get bound(): boolean {
      return hitl !== undefined;
    },
    bind(next: HumanRequestChannel): void {
      if (hitl) log("HITL_CHANNEL_DOOR_REBOUND: the composition root bound the door twice");
      hitl = next;
    },
  };
}
