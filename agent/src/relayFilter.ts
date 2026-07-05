import { isKnownShipMacro, type ProtocolMessage } from "@xmultiplayer/protocol";

export type RelayDecision = { forward: true } | { forward: false; reason: string };

/**
 * Decides whether a message received from the relay server (about another session
 * member) may be forwarded into the pipe (game). From A2 on this is a trust
 * boundary: a `spawn` naming a `shipType` outside the known-good whitelist is
 * rejected here, before it ever reaches `create_ship` in the mod.
 */
export function decideRelay(msg: ProtocolMessage): RelayDecision {
  if (msg.type === "spawn" && !isKnownShipMacro(msg.shipType)) {
    return { forward: false, reason: `unknown shipType "${msg.shipType}", rejected by whitelist` };
  }
  return { forward: true };
}
