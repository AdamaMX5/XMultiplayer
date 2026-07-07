# A5 — Messprotokoll (Drop-in-Arena: Presence-Join, Loadout, Kill-Feed, SETA-Erkennung, Kartenvarianten)

**Status: gemischt.** Block 1 (SessionManager-Session-Wechsel-Fix), Block 2
(`requireOwnership()`-Refactoring), die Node-seitigen Teile von Punkt 4-6
(Agent-dynamische Session, Kill-Feed, Regel-Preset) und Block 9-11
(Security-Härtung) sind mit echten Tests **VERIFIED** (273 Tests grün
insgesamt: 64 protocol + 92 agent + 117 server, `npm test --workspaces`).
Alles Mod-seitige (`mod/md/XMP_Arena.xml`, `mod/aiscripts/XMP.ProxyPilot.xml`,
`mod/libraries/*.xml`) ist wie bei A1-A4 ausschließlich auf syntaktische
XML-Gültigkeit geprüft (PowerShell `[xml]`-Parser); die Semantik ist komplett
ungeprüft, keine X4-Installation verfügbar. Block 9-11 betrifft ausschließlich
Server/Agent (keine Mod-Änderungen).

Umgestaltet nach Entwickler-Entscheidung: **Drop-in-Arena statt Lobby.** Kein
Ready-Check, kein Countdown, kein Session-Code-Dialog — wer den Arena-Sektor
betritt, ist drin.

## 1. SessionManager-Fix (Ghost-Spawns bei Session-Wechsel)

`SessionManager.join()` gibt jetzt zurück, was `leave()` intern zurückgibt
(die ALTE Session, falls vorhanden). `server.ts`s `joinSession()` prüft: wenn
eine andere, ABWEICHENDE alte Session existiert, wird für sie
`broadcastLeave` + `broadcastDespawns` (inkl. `hp.remove`) ausgeführt — exakt
dieselbe Aufräumlogik wie bei einem echten Disconnect. Ein Re-Join derselben
Session (kein echter Wechsel) löst KEIN Despawn für die eigene, weiterhin
gültige Spawn aus.

Getestet in `server/tests/session.test.ts` ("A5 review fix: switching
sessions...") und `server/tests/sessionManager.test.ts` (`join()`s neuer
Rückgabewert, 3 Fälle: erster Join, echter Wechsel, Re-Join derselben Session).

## 2. `requireOwnership()`-Refactoring

Die vier duplizierten Ownership-Prüfungen (`hit_report.sourceId`,
`state_update.shipId`, `despawn.objectId`, `fire_event.sourceId`) sind jetzt
eine gemeinsame Funktion `requireOwnership(sessions, clientId, objectId,
messageType, field): boolean`. Reines Refactoring, keine Verhaltensänderung,
alle bestehenden Tests bleiben unverändert grün.

## 3. Server-Fix, während der Umsetzung entdeckt: expliziter Client-`leave` wirkte nur dekorativ

Beim Entwurf des Sektor-Austritt-Flows (Abschnitt 5) fiel auf: ein
CLIENT-gesendetes `session`-`leave` wurde bisher nur an andere Mitglieder
weitergeleitet, aber `sessions.leave(clientId)` wurde für diesen Pfad NIE
aufgerufen (nur ein echter WebSocket-Disconnect rief es auf). Der sendende
Client blieb serverseitig weiterhin als Mitglied dieser Session geführt, obwohl
alle anderen gerade eine "hat verlassen"-Nachricht bekommen hatten.
**Fix:** neue Funktion `leaveSession()`, geteilt zwischen `handleDisconnect`
und einem neuen, expliziten `action === "leave"`-Zweig in `handleMessage`.
Getestet in `server/tests/session.test.ts` ("A5 fix: an explicit client-sent
leave... actually removes session membership").

## 4. MD — Sektor-Präsenz als Drop-in-Trigger (`mod/md/XMP_Arena.xml`)

Ersetzt A1-A4s `XMP_Arena_AnnounceSpawn` (spawnte unbedingt, sobald die Pipe
bereit war, unabhängig vom Spielerstandort) durch einen echten Präsenz-Trigger:

- **`XMP_Arena_PresenceLoop`/`XMP_Arena_PresenceCheck`**: pollt einmal pro
  Sekunde (bewusst NICHT an den 10Hz-Telemetrie-Takt gekoppelt — Sektorwechsel
  sind selten, ein langsamerer, unabhängiger Takt ist billiger und entkoppelt
  Telemetrie-Rate von Präsenz-Erkennungs-Latenz) und vergleicht
  `player.sector.macro.name` gegen `$XMP.ArenaSectorMacroName`
  (`'XMP_Arena_Sector_macro'`, `libraries/sectors.xml`).
- **Eintritt → `XMP_Arena_OnEnterSector`**: sendet `session` `join`
  (`sessionCode: "arena"`, fester Literal, passend zum Agent-Default,
  `agent/src/config.ts`) gefolgt von `spawn` mit ECHTEN Daten: `shipType` =
  `player.entity.macro.name` (bereits etabliertes Muster seit A1), `maxHull`/
  `maxShield` = `player.entity.hullmax`/`shieldmax` (NEUE Annahme, siehe unten).
- **Austritt → `XMP_Arena_OnExitSector`**: `despawn` (`reason:
  "left_sector"`) gefolgt von `session` `leave`.

### Offene Annahmen, nach Risiko geordnet

- [ ] **`player.sector` existiert und hat `.macro.name`** (mirrort das bereits
      etablierte `player.entity.macro.name`-Muster). Größtes Risiko in diesem
      Abschnitt — ohne funktionierende Sektor-Erkennung entsteht überhaupt kein
      `session join`/`spawn`, der gesamte Drop-in-Mechanismus bliebe inaktiv.
- [ ] **`player.entity.hullmax`/`shieldmax` als ABSOLUTE Punktwerte.** X4
      drückt Hull/Schild in anderen Kontexten häufig als 0..1-BRUCHTEIL aus,
      nicht als absolute Punkte — falls das hier zutrifft, müsste vor dem
      Senden gegen eine bekannte Basis (z. B. `DEFAULT_HULL`/`DEFAULT_SHIELD`)
      umgerechnet werden. Anders als die alten festen 100/100-Konstanten (A4)
      gibt es hier KEINEN Laufzeit-Fallback — MD hat kein try/catch, ein
      falscher Property-Name bricht vermutlich die gesamte Eintritts-Sequenz,
      nicht nur diese zwei Felder. `server/src/server.ts`s
      `DEFAULT_HULL`/`DEFAULT_SHIELD`-Fallback bleibt das Sicherheitsnetz, falls
      diese Felder stattdessen künftig weggelassen werden müssen.
- [ ] **Loadout wird NICHT gesendet** — bewusste Entscheidung, kein Versehen.
      Eine Waffen-Enumeration bräuchte eine angenommene
      Collection-Iterations-API (`do_for_all` über z. B.
      `player.entity.equipment.weapons`), für die es in diesem Repo noch KEIN
      etabliertes Muster gibt (anders als `shipType`/`hullmax`/`shieldmax`, die
      alle einen bereits verwendeten Zugriffsstil spiegeln). Ein falscher
      Ratewert hier riskiert, die GESAMTE Eintritts-Sequenz zu brechen, für ein
      Feld, das im Protokoll ohnehin optional ist (`SpawnMessage.loadout?`) —
      das Risiko/Nutzen-Verhältnis sprach dagegen, das jetzt zu raten.
      **Nächster Schritt, sobald eine X4-Installation verfügbar ist:** die
      reale Waffen-Enumerations-API im MD-Referenzmaterial/in-game nachschlagen,
      dann `XMP_Arena_OnEnterSector` um den Loadout-Aufbau ergänzen.

## 5. Agent — dynamische Session (`agent/src/index.ts`, `sessionState.ts`, `config.ts`)

- **`AgentConfig.sessionCodeExplicit`** (neu): unterscheidet "ein
  `--session`/`XMP_SESSION` wurde tatsächlich angegeben" von "nur der
  Default". Nur im EXPLIZITEN Fall joint der Agent noch automatisch beim
  Connect (Simulator/E2E-Tests/Operator-Override) — sonst wartet er auf den
  Mod, der `session join` selbst über die Pipe schickt, sobald er echte
  Sektor-Präsenz erkennt (Abschnitt 4).
- **`SessionState`** (neu, `agent/src/sessionState.ts`): merkt sich die letzte
  ausgehende `session join`- und `spawn`-Zeile, um sie nach einem
  WebSocket-Reconnect erneut zu senden — der Relay-Server vergisst die
  Session-Mitgliedschaft komplett (neue `clientId` pro Verbindung), ohne
  Wiederherstellung bliebe der Agent verbunden, aber unsichtbar für seine
  eigene Session. Vollständig unit-getestet (`agent/tests/sessionState.test.ts`,
  9 Tests: Join/Spawn merken, Leave löscht beides, Despawn löscht nur die
  betroffene Spawn, irrelevante Nachrichtentypen ändern nichts).
- **`knownSpawns`/`knownObjectIds`-Cache wird bei Reconnect GELEERT, nicht
  ergänzt** (A2-Resync-Problem): der Server repliziert beim Re-Join ohnehin
  den aktuellen Session-Zustand; ohne vorheriges Leeren könnte ein Geist-Eintrag
  (jemand hat während der Trennung despawnt, wir haben das nie gesehen)
  neben dem frischen Replay überleben.
- **MD kann `session`-Nachrichten generisch über die Pipe schicken** — bereits
  vorher der Fall (`handleLine` leitet jeden validen Nachrichtentyp
  unverändert weiter), jetzt zusätzlich verifiziert UND für
  `SessionState.observeOutbound()` mitgenutzt.

- [ ] Kein echter End-to-End-Test für den WS-Reconnect-Fall selbst (Server-Port
      neu binden, echten Agent-Prozess beobachten) — das reine Zustands-Verhalten
      ist über `SessionState`s Unit-Tests vollständig abgedeckt, die Verdrahtung
      in `index.ts` ist einfache Glue-Logik. Bewusster Trade-off angesichts des
      Gesamtumfangs von A5; bei Bedarf nachrüstbar.

## 6. Kill-Feed (`server/src/server.ts`)

`destroyObject()` (HP-Autorität, A4) baut jetzt zusätzlich eine `chat`-Nachricht
(`from: "server"`, `text: "<Angreifer> destroyed <Opfer>"`) und broadcastet sie
an die GESAMTE Session — kein neuer Nachrichtentyp nötig, der Server ist
ohnehin die einzige Instanz, die einen Kill wirklich kennt (er ist die
HP-Autorität). MD müsste `chat` als Bildschirm-Notification anzeigen
(**Annahme, nicht umgesetzt**: welche MD-Aktion sich dafür eignet, ist
unklar — `XMP_Arena_Dispatch` routet `chat` aktuell gar nicht; das wäre der
nächste Schritt, sobald eine konkrete Notification-Aktion bestätigt ist).
Getestet in `server/tests/session.test.ts` ("A5 kill-feed: destruction
broadcasts a chat message...").

## 7. Regel-Preset: Schiffsklassen-Filter (`server/src/shipClassPolicy.ts`)

`--ships`/`XMP_SHIPS` (`s`|`m`|`sm`|`all`, Default `all`) steuert, welche
Schiffsklassen spawnen dürfen — zusätzlich zur bestehenden
`SHIP_MACRO_WHITELIST` (`protocol/src/shipMacros.ts`), nicht als Ersatz dafür.
Klasse wird aus dem Makro-Namen selbst abgeleitet (`_s_`/`_m_`-Token), keine
zweite, separat zu pflegende Tabelle.

**Nebenbefund, während der Umsetzung entdeckt:** der Server hatte `spawn.shipType`
bisher NIE selbst validiert — die Whitelist-Prüfung lief ausschließlich
agent-seitig (`decideRelay`, nur für EINGEHENDE Spawns vom Relay). Ein Client,
der sich direkt per WebSocket verbindet (den Agent umgeht), hätte einen
beliebigen `shipType` einschleusen können. **Fix:** `isKnownShipMacro()`-Prüfung
jetzt auch serverseitig, vor der neuen Klassen-Preset-Prüfung.

Getestet in `server/tests/shipClassPolicy.test.ts` (10 Unit-Tests) und
`server/tests/session.test.ts` (serverseitige Whitelist-Ablehnung,
Klassen-Preset-Ablehnung + Gegenprobe).

## 8. SETA/Pause-Erkennung (`mod/md/XMP_Arena.xml`, `mod/aiscripts/XMP.ProxyPilot.xml`)

- **`XMP_Arena_SetaLoop`/`XMP_Arena_SetaCheck`**: pollt einmal pro Sekunde
  (gleiche Kadenz-Begründung wie die Präsenz-Prüfung, Abschnitt 4) den eigenen
  SETA-Status. **Annahme (größtes Risiko hier): `player.timewarp` existiert**
  und liefert einen Multiplikator (1 = normal, höher während SETA). Bei
  Änderung wird `session` `seta_on`/`seta_off` gesendet (neue `SessionAction`-
  Werte, `protocol/src/messages.ts`/`parse.ts`).
- **Echte PAUSE-Erkennung wird bewusst NICHT versucht.** Begründung: ist das
  Spiel wirklich pausiert, halten MD-Skripte selbst höchstwahrscheinlich auch
  an (die gesamte Simulation steht) — dann könnte KEIN Cue, auch dieser nicht,
  das Eintreten einer Pause überhaupt erkennen. Ein Verlassen der Pause ließe
  sich allenfalls nachträglich über eine Zeitlücke vermuten, was wiederum neue,
  unsichere Annahmen bräuchte. In der Praxis sendet ein pausierter Spieler
  ohnehin einfach keine Updates mehr — und genau das behandelt der BEREITS
  BESTEHENDE Dead-Reckoning-Update-Timeout (`$UpdateTimeoutSec`, A3) schon
  gracefully (Proxy hält an). "Gegner reagiert aus irgendeinem Grund nicht
  mehr, Pause eingeschlossen" hat also schon sinnvolles Verhalten, ganz ohne
  pausenspezifischen Code.
- **Empfang → `XMP_Arena_HandleSetaStatus`**: sucht die betroffene `objectId`
  über eine NEUE Rückwärts-Tabelle `$XMP.ProxyObjectIdByOwner.{playerName}`
  (befüllt in `XMP_Arena_HandleSpawn`, geleert in `XMP_Arena_DestroyProxy` —
  eine `session`-Nachricht kennt nur den Spielernamen, keine `objectId`) und
  setzt `this.blackboard.$XMP_Frozen` auf dem entsprechenden Proxy.
- **`XMP.ProxyPilot.xml`**: `$XMP_Frozen == true` hat Vorrang vor der gesamten
  bestehenden Snap-/Extrapolations-/Timeout-Logik (jetzt im `else`-Zweig
  verschachtelt) — Begründung: die Extrapolationsmathematik geht von 1:1
  Echtzeit-zu-Spielzeit aus, genau das bricht SETA für die beschleunigte
  Seite, Weiterrechnen würde also aktiv IN DIE FALSCHE RICHTUNG extrapolieren,
  nicht nur "ein bisschen veraltet" sein. `$IsStopped` wird bewusst mit dem
  bestehenden Timeout-Zweig geteilt (ein `move.stop` pro Stillstandsphase,
  unabhängig vom Grund).

- [ ] `player.timewarp` als Existenz/Wertebereich unbestätigt.
- [ ] Kein Notification-Mechanismus umgesetzt (nur `debug_text` als Platzhalter,
      wie überall in diesem Mod) — "Gegner-Clients zeigen Notification" aus dem
      Auftrag ist damit nur als Log-Zeile erfüllt, nicht als echte
      Bildschirm-Anzeige; dieselbe offene Frage wie beim Kill-Feed (Abschnitt 6).

## 9. Kartenvarianten (`mod/libraries/{clusters,sectors,zones,galaxy,gamestarts}.xml`, `mod/t/0001-L044.xml`)

Drei zusätzliche, zur Basis-Arena strukturell identische Cluster/Sektor/Zone/
Gamestart-Quadrupel: Asteroidenfeld, Trümmerfeld, Nebelregion. Jede Variante ist
ein eigener Gamestart (wie die Basis-Arena seit A2) statt eines Laufzeit-Schalters
auf dem bestehenden Sektor — Variantenwahl = anderer Gamestart beim Start,
nichts Dynamischeres.

**Determinismus** (explizite Anforderung aus dem Auftrag) ergibt sich hier
kostenlos: das ist statisches, handgeschriebenes XML, das mit dem Mod
ausgeliefert wird, nichts zur Laufzeit Generiertes/Zufälliges — beide Spieler
mit derselben Mod-Version sehen automatisch byte-identische Geometrie, kein
Sync-Mechanismus nötig.

**HÖCHSTES RISIKO in diesem Abschnitt:** die drei `<region>`-Verweise
(`region_asteroidbelt_dense_01_macro`, `region_debrisfield_01_macro`,
`region_nebula_dense_01_macro`) sind REINE PLATZHALTER nach der üblichen
X4-Namenskonvention, NICHT gegen die echte Spiel-Bibliothek geprüft — dieselbe
Risikokategorie wie die Schiffs-Makro-Whitelist
(`protocol/src/shipMacros.ts`). Die umgebende Cluster-/Sektor-/Zonen-/
Gamestart-Struktur selbst ist risikoarm (identisch zum bereits etablierten
Basis-Arena-Muster) — nur diese drei einzelnen `<region>`-Zeilen müssten
korrigiert werden, falls die Namen falsch sind.

- [ ] Sobald eine X4-Installation verfügbar ist: die echten Region-Definitions-
      Makronamen aus der Spiel-Bibliothek nachschlagen und die drei
      Platzhalter ersetzen.

## 10. Security-Härtung für Internet-Betrieb (Block 9-11)

Reine Server-/Agent-Änderungen, keine Mod-Änderungen. Alle Konfigurationswerte
sind CLI-Flags/Env-Variablen mit generösen Defaults, die normales LAN-Spiel
nicht beeinträchtigen sollen (siehe `server/src/index.ts`).

### 9. hit_report-Härtung

- **Rate-Limit** (`server/src/rateLimiter.ts`, `TokenBucket`): allgemeine
  Nachrichten-Rate pro Client (Default 60 Kapazität, 30/s Nachfüllrate, ÜBER
  ALLE Nachrichtentypen, Punkt 10) UND eine SEPARATE, engere Grenze
  ausschließlich für `hit_report` (Default 20 Kapazität, 20/s — "~20/s" wie
  gefordert). Zwei getrennte `TokenBucket`-Instanzen, da Kampf-Spam eine eigene,
  engere Grenze verdient, unabhängig von der allgemeinen.
- **Respawn-Gate:** vor diesem Fix konnte ein Client `spawn` für seine EIGENE,
  noch lebende `objectId` jederzeit erneut senden — `hp.register()` setzt
  Hull/Schild bedingungslos auf Maximum zurück, das war also ein kostenloser,
  unbegrenzter Selbstheilungs-Exploit (bei Schaden einfach `spawn` erneut
  senden). **Fix:** ein `spawn` für eine `objectId`, die der SENDER selbst noch
  aktiv besitzt (`ownerOf() === clientId`), wird jetzt abgelehnt — Voraussetzung
  für ein erneutes Spawnen ist eine vorherige, echte Zerstörung/Despawn
  (`removeSpawn()` löscht den Eintrag aus `ownerByObjectId`, danach ist
  `ownerOf()` wieder `undefined`, ein Respawn also wieder erlaubt).
  **Zusammenspiel mit Block 1 (Session-Wechsel-Fix):** ein Sitzungswechsel gibt
  die `objectId` in der ALTEN Session bereits frei (eigener HP-Tracker pro
  `sessionCode`), ein Client kann also nach einem echten Sektorwechsel sofort
  neu spawnen, ohne den Respawn-Gate zu verletzen — beide Mechanismen wurden
  bewusst so kombiniert getestet (`server/tests/session.test.ts`, "A5 respawn
  gate: re-spawning a STILL-ACTIVE objectId...").

### 10. Server-Limits

- **Verbindungslimits** (`server.ts`s `wss.on("connection", ...)`): Max
  Gesamtverbindungen (Default 500) und max Verbindungen pro Remote-IP (Default
  50, großzügig gewählt, da lokale Mehrfach-Tests/NAT-Szenarien alle von
  DERSELBEN IP kommen) — eine überzählige Verbindung wird sofort mit Code 1013
  ("Try Again Later") geschlossen, bevor sie überhaupt Session-Bookkeeping
  bekommt.
- **Max Sessions** (`SessionManager.hasSession()`, neu): ein `join`, das eine
  NEUE Session anlegen würde, wird abgelehnt, sobald `maxSessions` (Default
  1000) erreicht ist — ein `join` in eine BEREITS EXISTIERENDE Session ist
  davon nie betroffen, egal wie viele Sessions es schon gibt.
- **arenaBounds serverseitig:** `isWithinArenaBounds`/`isPlausibleVelocity`
  (aus `protocol/src/arenaBounds.ts`, seit A4 Commit 5fdc238 im
  protocol-Package) liefen bisher NUR agent-seitig (`decideRelay`, nur für
  EINGEHENDE `state_update`s über andere Spieler). Ein Client, der sich direkt
  per WebSocket verbindet statt über den Agent, hätte beliebige Positionen/
  Geschwindigkeiten einschleusen können. Jetzt zusätzlich serverseitig geprüft,
  derselbe Fund wie die fehlende Schiffs-Whitelist-Prüfung (Abschnitt 7).

### 11. Session-Codes + String-Sanitizing

- **Internet-Modus** (`--public`/`XMP_PUBLIC`, Default aus): erzwingt für
  `session join` einen Code, der NICHT der LAN-Default `"arena"` ist UND
  mindestens `MIN_PUBLIC_SESSION_CODE_LENGTH` (12) Zeichen lang ist. Keine
  echte Entropie-Berechnung, sondern eine billig durchsetzbare Mindestgrenze —
  ohne Flag bleibt `"arena"` wie gehabt gültig (LAN-Konvention unverändert).
- **String-Sanitizing** (`protocol/src/sanitize.ts`, neu, geteilt zwischen
  Server und Agent): `playerName`/`chat.from`/`chat.text` werden IMMER
  (Kontroll-Zeichen entfernt: Newlines/Escape-Sequenzen, die Log-Injection
  ermöglichen würden; Längenbegrenzung: 32 Zeichen für Namen, 256 für
  Chat-Text) UND, nur agent-seitig, zusätzlich AGGRESSIV um `{`, `}`, `,`
  bereinigt (`sanitizeForPipeExtraction`) — genau die Zeichen, die
  `XMP_Arena_ExtractField`s naive String-Suche bricht (dokumentierte,
  vorbestehende Lücke aus A2/A3: ein Stringwert mit literalem `}`/`,` bricht
  die Extraktion vorzeitig ab). Zwei getrennte Sanitisierungs-Ebenen an zwei
  Stellen:
  - **Server** (`server.ts`s `joinSession`/neuer `chat`-Zweig): EINMAL beim
    Empfang sanitisiert, sowohl was gespeichert wird (SessionMember, vom
    Kill-Feed wiederverwendet) als auch was gebroadcastet wird — nicht nur die
    eigenen Log-Zeilen.
  - **Agent** (`agent/src/pipeSanitize.ts`, neu): direkt vor dem
    Pipe-Schreiben, zusätzlich zur bereits server-seitig erfolgten
    Sanitisierung, mit der aggressiveren `{`/`}`/`,`-Bereinigung obendrauf.
    "Aggressiv filtern ist ok, Kosmetik vor Korrektheit" (Auftrag) — Zeichen
    werden entfernt, nicht escaped.

- [ ] `MIN_PUBLIC_SESSION_CODE_LENGTH = 12` ist eine Schätzung, keine echte
      Entropie-Berechnung — für einen öffentlichen Betrieb evtl. durch eine
      echte Zufalls-Code-Generierung serverseitig ersetzen, statt nur eine
      Mindestlänge zu erzwingen.
- [ ] Verbindungs-/Sessions-Limits (Abschnitt 10) sind Schätzungen für
      LAN/kleine-Gruppen-Betrieb — vor echtem Internet-Betrieb mit den
      tatsächlich erwarteten Spielerzahlen kalibrieren.

## 11. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren; zuerst `player.sector.macro.name`
   (Abschnitt 4) bestätigen — ohne funktionierende Sektor-Erkennung entsteht
   kein Drop-in überhaupt, der Rest dieses Meilensteins bliebe ungetestet.
2. `player.entity.hullmax`/`shieldmax` (Abschnitt 4) und `player.timewarp`
   (Abschnitt 8) isoliert bestätigen — beide haben keinen Laufzeit-Fallback.
3. Die drei Region-Makronamen (Abschnitt 9) gegen die echte Spielbibliothek
   korrigieren.
4. Loadout-Enumeration (Abschnitt 4) nachrüsten, sobald die reale Waffen-API
   bekannt ist.
5. Eine konkrete Notification-Aktion für Kill-Feed (Abschnitt 6) und
   SETA-Status (Abschnitt 8) festlegen, statt nur `debug_text`.
6. Block 9-11 (Security-Härtung, Abschnitt 10) ist umgesetzt und getestet.
   Verbleibend: die Verbindungs-/Sessions-Limits und die
   Session-Code-Mindestlänge (Abschnitt 10, beide als Schätzungen markiert) vor
   echtem Internet-Betrieb anhand der tatsächlich erwarteten Spielerzahlen
   kalibrieren; ggf. echte Zufalls-Code-Generierung statt reiner
   Mindestlängen-Prüfung ergänzen.
