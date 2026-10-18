import { toNumber } from 'baileys';

export type ChatState = { archived?: boolean; pinned?: number | null; muteEndTime?: number | null };

const FIELDS = ['archived', 'pinned', 'muteEndTime'] as const;

/**
 * The archive, pin and mute state a Baileys chat carries, for a webhook item.
 *
 * A field is included only when the chat itself carries it: an app-state action
 * sets its own field (null when it clears a pin or a mute), and a history
 * Conversation sets a field only when WhatsApp sent it (protobuf defaults sit on
 * the prototype). A chat without the field says nothing about it, so the item
 * omits it rather than claiming archived: false.
 */
export function chatState(chat: Record<string, any> | undefined | null): ChatState {
  const state: Record<string, any> = {};
  if (!chat) return state;
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(chat, field)) continue;
    const value = chat[field];
    if (value === undefined) continue;
    if (value === null) state[field] = null;
    else state[field] = field === 'archived' ? !!value : toNumber(value);
  }
  return state;
}
