# C6 — Messprotokoll (Kommando-Relay: Docking)

**Status: gemischt, wie A1-C5.** Protokoll, Server und Agent sind mit echten
Tests **VERIFIED** (367 Tests grün insgesamt: 91 protocol + 111 agent + 165
server, `npm test --workspaces`, siehe Abschnitt 4). Alles Mod-seitige (`mod/md/XMP_Coop.xml`s
neue `XMP_Coop_OnDock`/`HandleDockRequest`/`HandleDockResponse`-Cues, die
neuen `$XMP.CoopExportedObjectByWireId`/`$XMP.SectorProxyWireIdByGameId`-
Tabellen, `mod/md/XMP_Arena.xml`s zwei neue Dispatch-Zweige) ist wie bei
A1-C5 ausschließlich auf syntaktische XML-Gültigkeit geprüft
(`System.Xml.XmlDocument.Load`), die Semantik ist komplett ungeprüft — keine
X4-Installation verfügbar.

**Interne Review-Runde vor diesem Commit** (Agent-Team, drei parallele
Perspektiven auf denselben Diff, wie schon bei C1-C5): ein echter Fund vor
dem Commit behoben. Der Sicherheits-Experte fand, dass `agent/src/
pipeSanitize.ts`s `sanitizeForPipe` keinen Zweig für `dock_response.reason`
hatte — im Gegensatz zu JEDEM anderen Freitext-Feld in diesem Protokoll
(`chat.text`, `session.playerName`, `sector_object.macroName`/`objectId`,
NPC-`spawn.shipType`/`objectId`) fehlte der zweite, Pipe-spezifische
Sanitizing-Layer (`sanitizeForPipeExtraction`), der `{`/`}`/`,` entfernt —
ohne ihn hätte ein `reason` mit einem dieser Zeichen die Extraktion der
GESCHWISTER-Felder (`targetId`/`requesterId`/`approved`) in derselben
JSON-Zeile auf dem Gast-Client korrumpieren können. Kein bewusster
Scope-Cut (nicht in Abschnitt 6 dieses Dokuments gelistet) — schlicht
übersehen, jetzt mit einem neuen `dock_response`-Zweig behoben (3 neue Tests
in `agent/tests/pipeSanitize.test.ts`). Der Test-Experte bestätigte
Protokoll+Server = **VERIFIED**, Mod = **PLAUSIBLE**, keine Bugs gefunden
(Dispatch-Pfad und Tabellen-Paarungen beim Nachlesen bestätigt). Der
Code-Review-Experte vergab **✅ Akzeptiert** ohne Änderungswunsch (separate
Ownership-Maps statt einer generischen Abstraktion bewusst bestätigt als
richtige Wahl bei dieser Größe).

## 0. Umfang-Entscheidung (mit dem Entwickler abgestimmt)

PlanMod.md listet für C6 fünf Unterpunkte, explizit "bewusst inkrementell,
sortiert nach Wert/Aufwand": Docking, Reparatur/Nachschub, Handel,
Flottenbefehle, Missionen (letztere bereits im Plan selbst zurückgestellt).
Reparatur und Handel würden zusätzlich ein Credits/Wirtschaftsmodell
brauchen, das in dieser Codebase komplett fehlt — vor Beginn der
Implementierung wurde mit dem Entwickler abgestimmt, **nur Docking** für
diesen C6-Commit umzusetzen; die übrigen vier Unterpunkte bleiben
zurückgestellt (siehe Abschnitt 6).

## 1. Die eigentliche Design-Frage: Punkt-zu-Punkt statt Broadcast

Jede Nachricht vor C6 wurde entweder an die GANZE Session gebroadcastet
(`state_update`, `spawn`, `sector_object`, ...) oder war server-generiert
(`hp_state`). Eine Docking-Interaktion ist von Natur aus zweiseitig (der
anfragende Spieler und dasjenige Mitglied, das die Zielstation exportiert
hat) — ein Broadcast an ein DRITTES, unbeteiligtes Mitglied wäre sowohl
verschwenderisch als auch ein leichtes Informationsleck (wer wo andockt).
`server/src/server.ts`s neue `sendToMember`-Funktion löst das: echtes
Punkt-zu-Punkt-Routing, das erste dieser Art im gesamten Protokoll.

Routing-Schlüssel:
- `dock_request` → geroutet an den Besitzer von `targetId`, nachschlagbar
  über eine NEUE Ownership-Map für `sector_object` (`sectorObjectOwnerOf`,
  `server/src/sessionManager.ts`) — C1 hatte für `sector_object` nie ein
  Ownership-Konzept gebraucht (keine Despawn-Nachricht existiert dafür).
- `dock_response` → geroutet an den Besitzer von `requesterId`, über die
  BEREITS BESTEHENDE Spawn-Ownership-Map (`ownerOf`, seit A2) — bewusst
  KEINE neue "Pending-Request"-Tabelle: die eigene Schiffs-Spawn des
  Anfragenden IST bereits der Routing-Schlüssel zurück zu ihm.

## 2. Protokoll — `dock_request`/`dock_response`

Zwei neue Nachrichtentypen (`protocol/src/messages.ts`), Validierung in
`parse.ts` (neue `isBoolean`-Hilfsfunktion in `validators.ts` für
`approved`), kanonische Serialisierung in `canonical.ts`. Keine
Wiederverwendung eines bestehenden Typs mit Diskriminator-Feld (wie
`session`.`action`) — bewusst zwei eigenständige Typen, konsistent mit
PlanMod.md's eigenem Prinzip "jede Interaktion = eigenes Mini-Protokoll".

| Feld | Typ | Bemerkung |
|---|---|---|
| `targetId` | string | `sector_object.objectId` der Zielstation |
| `requesterId` | string | `spawn.objectId` des anfragenden Spielerschiffs |
| `approved` | boolean (nur `dock_response`) | Bestätigung des Stationsbesitzers |
| `reason` | string, optional (nur `dock_response`) | Nur bei `approved: false` relevant, serverseitig sanitized |

Nebenbei behobene, bereits vorher bestehende Doku-Lücke: `protocol/schema/
v1.json` hatte `sector_object`/`sector_mirror`/`spawn.category` etc. nie
nachgezogen (älterer, unabhängiger Stand als C1/C3) — dieses Mal NICHT
vollständig nachgezogen (zu groß für diesen Milestone, siehe Abschnitt 6),
nur die eigenen zwei neuen Typen wurden ergänzt.

Getestet in `protocol/tests/parse.test.ts` (6 neue Tests) und
`canonical.test.ts` (Roundtrip für beide neuen Typen).

## 3. Server — Sector-Object-Ownership + Punkt-zu-Punkt-Routing

**`SessionManager`**: neue parallele Maps `sectorObjectOwnerByObjectId`/
`sectorObjectIdsByMember` (gleiches Idiom wie `ownerByObjectId`/
`spawnsByMember`, aber bewusst NICHT dieselbe Map wiederverwendet — deren
Lebenszyklus, Grand Cap/Respawn-Semantik ist auf gespawnte Objekte
zugeschnitten, `sector_object` hat keinen Despawn-Pfad). Neue Methoden
`recordSectorObject`/`sectorObjectOwnerOf`/`forgetSectorObjectsOf` (letztere
für Disconnect-Aufräumen, an zwei Stellen verdrahtet: `leaveSession` UND
`joinSession`s Session-Wechsel-Zweig — Letzteres nicht sicherheitskritisch,
`sendToMember`s eigene Mitgliedschafts-Prüfung würde ohnehin sicher
fehlschlagen, aber Hygiene-Parität mit `broadcastDespawns` an derselben
Stelle).

**`server.ts`**: `sector_object`-Verarbeitung ruft jetzt
`sessions.recordSectorObject` vor dem Broadcast auf. Neue `sendToMember`-
Hilfsfunktion (Punkt-zu-Punkt, mit einer zusätzlichen Sicherheitsprüfung
gegenüber dem bestehenden `ownerOf`/`sectorObjectOwnerOf`-Muster: bestätigt,
dass das Zielmitglied tatsächlich noch Mitglied DIESER Session ist, bevor
überhaupt ein Socket nachgeschlagen wird — Verteidigung gegen eine
Wire-Id-Kollision über zwei UNABHÄNGIGE Sessions hinweg, ein Risiko, das
`ownerOf` selbst strukturell schon immer hatte, aber nie brauchte, weil
`broadcast()`/`broadcastToSession()` durch ihre eigene Session-Iteration
ohnehin schon session-scoped sind).

`dock_request`: `requireOwnership` auf `requesterId` (A4-Muster, wie
`hit_report.sourceId`), `targetId` bewusst NICHT ownership-geprüft (derselbe
Grund wie bei `hit_report.targetId` — genau das ist der Zweck). Unbekanntes
`targetId` wird verworfen (kein Routing-Ziel).

`dock_response`: MUSS von demjenigen kommen, der `targetId` tatsächlich
exportiert hat (`sectorObjectOwnerOf(targetId) !== clientId` → verworfen —
neuer Ownership-Check, verhindert, dass ein Mitglied im Namen einer fremden
Station antwortet). `reason` wird vor dem Routing mit `sanitizeChatText`
sanitized (gleiche Vertrauensstufe wie `chat.text`).

Getestet in `server/tests/sessionManager.test.ts` (9 neue Tests) und einer
neuen eigenen Datei `server/tests/dockRelay.test.ts` (9 Integrationstests
über die volle WebSocket-Kette: Punkt-zu-Punkt-Routing in beide Richtungen,
unbekanntes `targetId`/`requesterId`, gespoofter `requesterId`/`targetId`,
voller Round-Trip, Reason-Sanitizing, Nachrichten außerhalb einer Session).

**Agent (`agent/src/pipeSanitize.ts`)**: `sanitizeForPipe` bekommt einen
neuen `dock_response`-Zweig (`sanitizeForPipeExtraction(sanitizeChatText(
reason))`, wenn `reason` vorhanden ist) — von der Sicherheits-Review vor
diesem Commit gefunden (siehe oben), nicht ursprünglich mitgedacht. Getestet
in `agent/tests/pipeSanitize.test.ts` (3 neue Tests).

## 4. Test-Gesamtstand

`npm test --workspaces`: 91 protocol + 111 agent + 165 server = **367 Tests,
alle grün** (agent's 111 include the 3 new `dock_response.reason`
pipe-sanitizing tests from the security review fix above).

## 5. Mod — Docking-Erkennung und -Relay (`mod/md/`)

### 5.1 Zwei neue persistente Tabellen (die eigentliche Vorarbeit)

C1 hielt für exportierte `sector_object`s nie eine PERSISTENTE Referenz auf
das echte Objekt — nur eine transiente Liste, die pro Export neu aufgebaut
und danach verworfen wird. C6 braucht diese Referenz SPÄTER wieder (wenn ein
`dock_request` für ihre Wire-Id eintrifft), also bekommt
`XMP_Coop_FindObjectsOfClass` eine neue Tabelle
`$XMP.CoopExportedObjectByWireId` — exakt dieselbe Lücke, die C4 bereits für
NPCs geschlossen hat (`$XMP.CoopBubbleGameObjectByWireId`), nur für
exportierte `sector_object`-Einträge statt für Bubble-NPCs.

Symmetrisch dazu, auf der GAST-Seite: `XMP_Coop_HandleSectorObject` bekommt
eine neue Reverse-Lookup-Tabelle `$XMP.SectorProxyWireIdByGameId` (Spiegel
von `$XMP.ProxyWireIdByGameId`, A4), damit ein lokales Docking-Ereignis
(das nur die Spiel-Objekt-Referenz kennt) zurück auf die Wire-Id aufgelöst
werden kann. C5s `XMP_Coop_HandleSectorChange`-Teardown wurde entsprechend
erweitert, um diese neue Reverse-Lookup-Tabelle symmetrisch mit aufzuräumen.

### 5.2 Drei neue Cues

- **`XMP_Coop_OnDock`** (Gast-Seite): neue, unbestätigte Annahme einer
  `event_object_docked`-Bedingung (skaliert auf `player.entity`, spiegelt
  `event_object_fired`s bestehende Skalierung; `event.object` spiegelt
  `event_object_attacked`s `event.object`). Filtert über die neue Reverse-
  Lookup-Tabelle auf "docken an einer bekannten gespiegelten Station" und
  sendet `dock_request`.
- **`XMP_Coop_HandleDockRequest`** (Host-Seite): validiert gegen
  `$XMP.CoopExportedObjectByWireId` ("kenne ich das noch als von mir
  exportiert und existiert es noch") und antwortet mit `dock_response`.
  Baut zwei vollständige, separate JSON-Strings (genehmigt/abgelehnt) statt
  ein Feld bedingt wegzulassen — dieselbe Zwei-Zweige-Idiom wie
  `XMP_Arena_SetaCheck`s `seta_on`/`seta_off`-Paar, da diese Codebase kein
  Muster für bedingt-vorhandene JSON-Felder in MD kennt.
- **`XMP_Coop_HandleDockResponse`** (Gast-Seite): reagiert mit
  `debug_text` — dieselbe akzeptierte "kein echter
  Benachrichtigungsmechanismus" Lücke, die A5 bereits für Kill-Feed/SETA
  offen ließ (`docs/A5-messprotokoll.md`), keine neue Lücke.

### 5.3 Ehrlicher Umfang der "Host-Validierung"

Der Host prüft NUR "kenne ich das noch als von mir exportiert und existiert
es noch" — es gibt weder ein Wirtschaftsmodell noch ein
Zugriffsrechte-/Rollenmodell noch eine Schiffs-Registry in dieser Codebase.
Eine Genehmigung hat aktuell KEINE weitere Spielzustands-Konsequenz über die
Bestätigung selbst hinaus. Das ist bewusst das FUNDAMENT, auf dem PlanMod.md's
übrige C6-Unterpunkte (Reparatur/Nachschub, Handel, Flottenbefehle) echte
Konsequenzen aufbauen würden, kein vollständiges Feature für sich.

## 6. Bewusst nicht in C6 umgesetzt

- **Reparatur/Nachschub, Handel, Flottenbefehle, Missionen**: mit dem
  Entwickler abgestimmt zurückgestellt (Abschnitt 0) — brauchen ein
  Credits-/Wirtschaftsmodell bzw. Rollenmodell, das diese Codebase noch
  nicht hat.
- **Kein Undocking-Handling**: keine Docked-Schiff-Registry existiert, also
  gibt es nichts Zustandsbehaftetes, das ein Undock-Ereignis freigeben
  müsste. Revisit sobald Reparatur/Handel echten, persistenten Zustand ans
  Docken hängen.
- **Kein Pending-Request-Tracking**: der Server merkt sich nicht, welchen
  `dock_request` ein `dock_response` beantwortet — ein Mitglied, das
  `targetId` besitzt, könnte ein unaufgefordertes `dock_response` für eine
  beliebige, real existierende `requesterId` senden. Harmlos für jetzt (kein
  echter Konsequenz-Pfad existiert), zu überarbeiten sobald `approved` echte
  Bedeutung bekommt.
- **Kein Objekttyp-Check host-seitig**: ein `dock_request` für die Wire-Id
  eines Gates/Asteroidenfelds/einer Region würde ebenfalls "genehmigt", wenn
  diese ID noch getrackt wird — vertraut darauf, dass die echte
  Spielphysik das bereits verhindert (ein Schiff kann physisch nicht an
  einem Gate andocken), dieselbe Vertrauenshaltung wie beim client-seitigen
  Hit-Detection-Modell (A4).
- **Kein vollständiger Nachzug von `protocol/schema/v1.json`** für
  `sector_object`/`sector_mirror`/`spawn.category` etc. (bereits vor C6
  bestehende, unabhängige Lücke) — nur die zwei neuen C6-Typen wurden
  ergänzt, der Rest bleibt wie vorgefunden.
- **Wire-Id-Kollisionsrisiko**: geerbt, nicht neu eingeführt — jedes
  Objekt-Wire-Id in diesem Protokoll ist direkt die reale X4-Objekt-`.id`
  (seit A1 für Schiffe, seit C1 für `sector_object`), was theoretisch über
  zwei unabhängige Spielinstanzen kollidieren könnte. `sendToMember`s
  Session-Mitgliedschaftsprüfung mindert die AUSWIRKUNG (kein
  Cross-Session-Fehlrouting), löst aber nicht das zugrundeliegende
  Id-Schema — dieselbe Risikoklasse, die für Spawn-Ids bereits seit A1
  unadressiert ist.

## 7. Nächste Schritte

1. X4-Installation nötig, um `event_object_docked`s Existenz/Form zu
   prüfen — DIE zentrale neue Annahme dieses Milestones, ohne die die
   gesamte Gast-seitige Erkennung nie feuert.
2. Prüfen, ob eine über einen kompletten Spielsitzung hinweg gespeicherte
   Objektreferenz (`$XMP.CoopExportedObjectByWireId`) tatsächlich gültig
   bleibt, auch nachdem der Host selbst den Sektor gewechselt hat (C5) —
   ein Objekt aus einem VERLASSENEN Sektor könnte eine andere
   Referenz-Gültigkeit haben als eines im aktuellen.
3. Reparatur/Nachschub als nächster C6-Unterpunkt, sobald ein
   Credits-/Wirtschaftsmodell für dieses Projekt entschieden ist.
