# XMultiplayer

Eine Mod, welche die Synchronisation von Objekten in X4: Foundations über einen
externen Server ermöglicht, komplett über Bordmittel des Modding-Systems (keine
Engine-Änderung). Ziel ist zunächst ein Arena-Sektor für PvP-Duelle (Phase 1),
danach ein eingeschränkter Koop-Modus im Universum eines Hosts (Phase 2). Bei
Erfolg als Machbarkeitsnachweis lohnt sich ein Gespräch mit Egosoft über eine
native Umsetzung in der Engine (siehe `docs/PlanEngine.md`).

**Erwartungsmanagement:** Elite-Dangerous-Dogfighting-Präzision ist NICHT das Ziel
dieses Projekts und per Mod prinzipiell nicht erreichbar. Mission-Director-Cues
takten nicht framegenau, Projektile sind nicht synchronisierbar, und Bewegung von
Fremdobjekten läuft über Teleport + Dead-Reckoning-Extrapolation, nicht über echte
Netzwerk-Interpolation. Das Ziel ist ein glaubwürdiges "Geisterduell mit Spannung",
keine Netcode-Präzision moderner Multiplayer-Titel. Details und Hintergrund in
`docs/PlanMod.md` (Abschnitte 0.4, 1.3, 3).

## Architektur

```
+-----------+   Named Pipe    +-------------+   WebSocket   +----------------+
| X4 Client |<--------------->|  Agent A    |<------------->|                |
| (Mod: MD- |  NDJSON/JSON     | (Node.js,   |     JSON      |  Relay-Server  |
|  Scripts) |                  |  Pipe<->WS) |               |  (Node.js, ws) |
+-----------+                  +-------------+               |                |
                                                               |  Sessions,     |
+-----------+   Named Pipe    +-------------+   WebSocket    |  Broadcast     |
| X4 Client |<--------------->|  Agent B    |<------------->|                |
| (Mod: MD- |  NDJSON/JSON     | (Node.js,   |     JSON      +----------------+
|  Scripts) |                  |  Pipe<->WS) |
+-----------+                  +-------------+
```

Jeder Client bleibt lokal autoritativ für sein eigenes Universum ("Multiplayer NEBEN
der Simulation, nicht darin" - `docs/PlanMod.md`). Der Relay-Server gruppiert
Clients pro Session und broadcastet Nachrichten an die jeweils anderen
Sitzungsmitglieder; er ist ab Milestone A4 zusätzlich HP-Autorität für den Kampf.

## Repo-Struktur

```
/mod/       X4-Extension (content.xml, md/) - Telemetrie-Export, später Proxy-Spawning
/agent/     Node.js-Agent (Named-Pipe-Server, WebSocket-Client, Simulator für Tests ohne X4)
/server/    Node.js-Relay-Server (Sessions, später HP-Autorität)
/protocol/  Geteiltes Nachrichtenprotokoll v1 (TS-Typen + JSON-Schema + Validierung)
/docs/      Pläne (PlanMod.md, PlanEngine.md) und Messprotokolle (A1-messprotokoll.md)
```

## Setup

Voraussetzung: Node.js 20+, npm 10+.

```bash
npm install                  # installiert alle Workspaces (protocol, agent, server)
npm test                     # Tests in allen Workspaces
npm run typecheck            # tsc --noEmit in allen Workspaces
```

### Relay-Server starten

```bash
cd server
npm start                    # Standard: Port 8765, override mit --port <n> oder XMP_PORT
```

### Agent starten

```bash
cd agent
npm start -- --server ws://localhost:8765 --session arena-1 --player-name Alice
```

Der Agent öffnet einen Named-Pipe-Server unter `\\.\pipe\x4_xmultiplayer` (Name
konfigurierbar über `--pipe-name`) und wartet auf die Verbindung durch das Spiel.

### End-to-End testen ohne X4

```bash
cd agent
npm start                    # Terminal 1: Agent
npm run simulate             # Terminal 2: Fake-X4-Client, sendet 10 Hz Kreisflug-Telemetrie
```

### Mod installieren

Siehe `mod/README.md` für die Installationsanleitung (Extensions-Ordner, Abhängigkeit
"SirNukes Mod Support APIs" aus dem Steam Workshop). In-Game-Validierung der
Mission-Director-Semantik steht noch aus - siehe `docs/A1-messprotokoll.md`.
