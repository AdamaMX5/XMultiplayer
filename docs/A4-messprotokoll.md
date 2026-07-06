# A4 — Messprotokoll (Kampf: Hit-Reporting, Server-HP-Autorität, hp_state, fire_event)

**Status: gemischt.** Die Server- und Agent-seitige HP-Autorität/Härtung
(`server/src/hpTracker.ts`, `server/src/server.ts`, `server/src/sessionManager.ts`,
`agent/src/relayFilter.ts`, `agent/src/arenaBounds.ts`) ist mit echten Tests
**VERIFIED** (193 Tests grün insgesamt: 45 protocol + 83 agent + 65 server,
`npm test --workspaces`). Alles Mod-seitige (`mod/md/XMP_Arena.xml`) ist wie bei
A1–A3 ausschließlich auf syntaktische XML-Gültigkeit geprüft (PowerShell
`[xml]`-Parser); die Semantik ist komplett ungeprüft, keine X4-Installation
verfügbar.

Dieser Meilenstein wurde in zwei Runden umgesetzt: der ursprüngliche Kernauftrag
(Abschnitte 1–3 unten), dann eine zweite Runde mit sieben zusätzlichen,
ausdrücklich angeforderten Härtungspunkten aus dem A3-Security-Audit
(Abschnitte 4–9) — Ownership-Autorität, Spawn-Cap, Agent-seitige Koordinaten-/
Velocity-Clamps, Orphan-Filter, `maxHull`/`maxShield` im `spawn`, sowie das
Auslagern von `simulateMdExtractField` und die Simulator-Erweiterung um
`hit_report`/`hp_state`.

## 1. Server ist HP-Autorität (`server/src/hpTracker.ts`)

`HpTracker` verwaltet `{hull, shield}` pro `sessionCode` + `objectId`. Registriert
wird bei jedem `spawn` (Startwerte `DEFAULT_HULL`/`DEFAULT_SHIELD` =
100/100, `protocol/src/combat.ts`); `hit_report` wird NIE roh weiterverbreitet,
nur das daraus berechnete `hp_state` geht an die GESAMTE Session (inklusive dem
Angreifer selbst — der braucht die Bestätigung genauso wie das Ziel). Ein Hull-
Wert `<= 0` löst eine Zerstörungssequenz aus: HP-Eintrag und Spawn-Datensatz
werden gelöscht, ein `despawn` mit `reason: "destroyed"` geht raus (spiegelt den
bestehenden Disconnect-Despawn-Mechanismus aus A2, siehe `broadcastDespawns`),
damit späte Beitreter nicht das zerstörte Schiff nachgespielt bekommen.

Design-Entscheidungen, alle mit echten Tests abgedeckt
(`server/tests/hpTracker.test.ts`, `server/tests/session.test.ts`):

- **"Shield vor Hull" (Team-Lead-Vorgabe, zweite Runde): Schild absorbiert
  zuerst, Überlauf fließt in Hull.** Die Vorgabe war ein Halbsatz, keine
  vollständige Spezifikation — konkret umgesetzt als **Interpretationsentscheidung**
  (hier bewusst dokumentiert statt stillschweigend angenommen):
  - `damageType: "shield"` (Normalfall, gewöhnliches Waffenfeuer): Schild
    absorbiert bis zu seinem aktuellen Wert; der REST ("Überlauf") geht auf Hull.
    Das ist die eigentliche "Shield vor Hull"-Logik.
  - `damageType: "hull"` (bewusst BEIBEHALTEN, nicht abgeschafft): umgeht den
    Schild komplett, Schaden geht immer direkt auf Hull — repräsentiert einen
    schildignorierenden/rumpfdurchdringenden Treffer. Das Feld existierte
    bereits vor dieser Vorgabe; es komplett zu entfernen hätte den nützlichen
    Bypass-Mechanismus gekostet, ohne dass die Vorgabe das explizit verlangt hätte.
  - Kein Cross-Pool-Verhalten in die andere Richtung: Hull-Schaden fließt NIE in
    Schild zurück (ergibt inhaltlich auch keinen Sinn).
  Getestet in `server/tests/hpTracker.test.ts` (u. a. "Shield vor Hull"-Überlauf-
  Fall, bereits erschöpftes Schild, Hull-Bypass unverändert wie zuvor).
- **`isDestroyed()` prüft nur Hull, nie Shield.** Schild auf 0 legt nur den Rumpf
  frei, zerstört das Schiff nicht.
- **Schadensbegrenzung, zwei getrennte Prüfungen (`hpTracker.ts`):**
  1. **`isValidDamageClaim()`** (neu, zweite Runde — schließt eine Lücke, die in
     der ersten Runde übersehen wurde): `damage` muss endlich UND echt positiv
     sein. Ohne diese Prüfung hätte ein `hit_report` mit negativem Schaden das
     Ziel STILLSCHWEIGEND GEHEILT (`hull - (-50)` erhöht den Wert), obwohl es in
     v1 explizit keine Regeneration geben soll. `Number.isFinite` allein (bereits
     in `protocol/src/parse.ts`s `isNumber`) reicht nicht, da sie NaN/Infinity
     abfängt, aber negative endliche Werte durchlässt.
  2. **`clampDamage()`** (`MAX_DAMAGE_PER_HIT = 1000`, aus der ersten Runde): ohne
     Deckelung könnte ein einzelner `hit_report` mit z. B. `damage: 999999999`
     jedes Schiff sofort zerstören, unabhängig vom tatsächlichen HP-Pool — direkte
     Fortsetzung der A2-Vertrauensgrenze (Client-Eingaben sind nicht
     vertrauenswürdig, siehe `docs/A2-messprotokoll.md`). Absichtlich als eigene,
     pure Funktion extrahiert statt inline in `handleHitReport`: `DEFAULT_HULL`
     (100) liegt unter `MAX_DAMAGE_PER_HIT` (1000), ein Integrationstest über
     `applyDamage` kann also "gedeckelt" nicht von "gar nicht gedeckelt"
     unterscheiden (beides landet bei 0) — der eigentliche Clamping-Test ist
     deshalb ein reiner Unit-Test.
- **Unbekannte/bereits zerstörte `targetId`:** `applyDamage` liefert `undefined`,
  der `hit_report` wird stillschweigend verworfen (kein Crash, kein `hp_state`).
- **Respawn (gleiche `objectId` erneut gespawnt) setzt HP zurück** auf die
  Default-Werte, keine übrig gebliebene Beschädigung.
- **`spawn.maxHull`/`spawn.maxShield` (neu, zweite Runde):** optionale Felder,
  mit denen der SENDER (der Mod, der den tatsächlichen `shipType` kennt) die
  Start-HP mitgeben kann, statt sich auf die festen `DEFAULT_HULL`/
  `DEFAULT_SHIELD` verlassen zu müssen. `XMP_Arena_AnnounceSpawn` sendet aktuell
  dieselben Werte (100/100, `$XMP.CombatDefaultMaxHull`/`$XMP.CombatDefaultMaxShield`
  in `XMP_Arena_TuningDefaults`) — kein Verhaltensunterschied heute, aber der Weg
  zu echter Pro-Schiffstyp-HP ist damit bereits im Protokoll vorhanden, ohne
  einen weiteren Breaking Change zu brauchen. Wie jeder andere Client-Wert wird
  auch dieser NICHT als vertrauenswürdiger als ein `hit_report` behandelt.

- [ ] Feste `DEFAULT_HULL`/`DEFAULT_SHIELD` = 100/100 für ALLE Schiffstypen ist
      immer noch eine grobe Vereinfachung, auch nachdem `maxHull`/`maxShield` das
      PROTOKOLL dafür vorbereitet haben — der Mod sendet aktuell trotzdem überall
      dieselben Zahlen, ignoriert reale Unterschiede zwischen z. B. einem leichten
      Jäger und einem schwereren Schiff aus der `SHIP_MACRO_WHITELIST`
      (`protocol/src/shipMacros.ts`). Für spätere Feinabstimmung: Tabelle
      shipType → Start-HP, mod-seitig in `XMP_Arena_AnnounceSpawn` nachziehen.
- [ ] `MAX_DAMAGE_PER_HIT = 1000` ist eine Schätzung ("deutlich über einem
      plausiblen Einzeltreffer, aber klein genug um Missbrauch zu deckeln") —
      nach erstem echten Waffentest kalibrieren.
- [ ] Die "Shield vor Hull"-Interpretationsentscheidung oben (insbesondere der
      beibehaltene `damageType: "hull"`-Bypass) ist eine Annahme über das
      GEMEINTE Kampfmodell, keine bestätigte Spezifikation — bei Bedarf mit dem
      Team-Lead gegenprüfen, falls das Kampfgefühl im ersten Live-Test nicht dem
      erwarteten Verhalten entspricht.

## 2. Mod-seitige Annahmen (`mod/md/XMP_Arena.xml`), alle PLAUSIBLE, nicht VERIFIED

Vollständige Liste auch im Dateikopf von `XMP_Arena.xml` selbst. Zusammengefasst:

1. **`set_object_invulnerable object="..." value="true"`** — auf jeden Proxy bei
   Spawn angewendet (`XMP_Arena_HandleSpawn`). Ein Proxy ist ausschließlich eine
   lokale visuelle Repräsentation eines ECHTEN Schiffs im Spiel eines anderen
   Spielers; er darf lokal weder Schaden nehmen noch verursachen — die einzige
   Autorität über sein Schicksal ist der Server.
2. **`event_object_attacked` (ungescoped, universumsweit)** — die lokale
   Treffer-Erkennung (`XMP_Arena_OnProxyAttacked`). Angenommen: feuert AUCH für
   ein unverwundbares Objekt (genau deshalb gewählt statt eines
   Hull/Shield-Differenz-Polling: bei echter Unverwundbarkeit ändert sich der
   HP-Wert ja nie, ein reiner Delta-Vergleich könnte also gar keinen Treffer
   erkennen). Reverse-Lookup `$XMP.ProxyWireIdByGameId.{event.object.id}` (Spiel-
   Objekt → Wire-`objectId`) wird bei Spawn befüllt, da `event.object` eine
   Spiel-Objektreferenz ist, keine eigene Wire-ID.
3. **`event_object_fired object="player.entity"`** — die lokale "ich habe gerade
   gefeuert"-Erkennung (`XMP_Arena_OnOwnWeaponFired`), Grundlage für den
   ausgehenden `fire_event`.
4. **`set_object_hull` / `set_object_shield`** — wenden das server-autoritative
   `hp_state` auf das EIGENE echte Schiff an (`XMP_Arena_HandleHpState`, Fall
   "eigenes Schiff"). Das ist der einzige Ort in diesem Mod, an dem eine
   Netzwerk-Nachricht eine wirklich konsequenzreiche Änderung am tatsächlichen
   Schiff des Spielers auslöst.
5. **`destroy_object`s `explosion`-Attribut** (angenommen boolesch, Default
   vermutlich `false`) — A2s Disconnect-Despawn bleibt lautlos
   (`explosion="false"`, implizit über den bisherigen Aufruf ohne das Attribut),
   ein Kampf-Kill (`hp_state` mit `hull <= 0`) setzt explizit
   `explosion="true"`, damit ein "Spieler hat die Verbindung verloren" und ein
   "Schiff wurde zerstört" sich für alle Zuschauer sichtbar unterscheiden
   (PlanMod.md A4 "kontrollierte Zerstörungssequenz").
6. **`fire_weapon_cosmetic`** — rein visueller/akustischer Waffeneffekt ohne
   Schadenskomponente (`XMP_Arena_HandleFireEvent`). Reproduziert absichtlich
   NICHT den exakt gemeldeten `origin`/`direction`, sondern feuert von der
   aktuellen Position/Ausrichtung des Proxys selbst — vermeidet eine weitere
   Ebene verschachtelter JSON-Sub-Extraktion für einen rein kosmetischen Effekt.
   Falls das im Spiel sichtbar unpassend wirkt: Sub-Extraktion für
   `origin`/`direction` nachrüsten (Felder werden bereits vom Sender mitgesendet,
   siehe `protocol/src/messages.ts` `FireEventMessage`).

- [ ] Bestätigen: `event_object_attacked` liefert Schadensmenge/-typ über
      `event.param`/`event.param2` (angenommen, spiegelt das bereits an anderer
      Stelle in dieser Datei verwendete `event.param3`-Muster von
      `md.Named_Pipes.OnLineReceived`) — Namen/Reihenfolge ungeprüft.
- [ ] Bestätigen: `event.param2` bei `event_object_attacked` ist ein bereits
      String-artiger Schadenstyp ("hull"/"shield"), keine Enum/ID, die erst
      übersetzt werden müsste.
- [ ] Bestätigen: `event_object_fired` existiert in dieser Form und liefert
      Waffenname (`event.param`) und Feuerrichtung (`event.param2` als
      x/y/z-Tabelle) wie angenommen.
- [ ] Bestätigen: Ein unverwundbares Objekt (`set_object_invulnerable`) verliert
      durch lokale Treffer WIRKLICH keine Hull/Shield-Punkte — falls doch (die
      Flag nur "kein Tod", aber keine harte 0-Schaden-Garantie bedeutet), bräuchte
      `XMP_Arena_OnProxyAttacked` zusätzlich eine Hull/Shield-Wiederherstellung
      direkt nach der Erkennung (Restore-statt-Prevent-Strategie), analog zum in
      früheren Entwurfsrunden verworfenen Delta-Polling-Ansatz.
- [ ] Bestätigen: `destroy_object` auf `player.entity` (eigenes Schiff, bei
      `hull <= 0` aus `hp_state`) verhält sich kontrolliert und löst keine
      unerwarteten Seiteneffekte mit X4s eigener Tod/Rettungskapsel/Versicherungs-
      Logik aus. **Höchstes Risiko in diesem Meilenstein:** dies ist die einzige
      Stelle im gesamten Mod, an der eine Netzwerknachricht das tatsächliche
      Schiff des Spielers zerstört. Kein "Match-Ende"/Respawn-Flow existiert noch
      — bewusst auf A5 verschoben ("Sieg/Niederlage-Erkennung").
- [ ] **Doppel-Zerstörungs-Verdacht (Fund der A4-Testrunde):** `XMP_Arena_HandleHpState`
      ruft für das eigene Schiff erst `set_object_hull ... exact="0"` und danach
      (bei `hull <= 0`) zusätzlich `destroy_object` auf. Unbestätigt, ob
      `set_object_hull 0` bereits selbst X4s Zerstörungssequenz auslöst — falls ja,
      wäre der nachfolgende `destroy_object`-Aufruf eine zweite Zerstörung auf einem
      möglicherweise schon zerstörten Objekt (Fehlerpotential: Exception, doppelte
      Explosion, doppelte Bergungs-/Versicherungslogik). Beim isolierten In-Game-Test
      (Abschnitt "Nächste Schritte", Punkt 3) gezielt prüfen; falls `set_object_hull 0`
      schon zerstört, den expliziten `destroy_object`-Aufruf im Eigenes-Schiff-Pfad
      entfernen (Proxies sind nicht betroffen — sie sind unverwundbar und laufen
      über den separaten `XMP_Arena_DestroyProxy`-Teardown).

## 3. Bekannte, akzeptierte Schwäche: Client-seitige Treffer-Erkennung (PlanMod.md A4)

Wer trifft, ENTSCHEIDET lokal ("ich habe getroffen") und meldet das per
`hit_report`; der Server verrechnet nur noch die Zahl, prüft aber nicht
nach, ob der Treffer aus SEINER (verzögerten) Sicht der Weltzustände plausibel
war. Bei Latenzen oberhalb von etwa 100ms (siehe `docs/A1-messprotokoll.md`
Abschnitt 1, `docs/A3-messprotokoll.md` Abschnitt 7 zur allgemeinen
Latenz-Situation) kann ein Ziel sichtbar "um die Ecke getroffen werden": der
Angreifer sieht auf seinem Bildschirm noch die alte Position/Ausrichtung des
Ziels (Dead-Reckoning-Extrapolation, A3), während das Ziel selbst (auf seinem
eigenen Client) längst weitergedreht/-geflogen ist.

Explizit akzeptiert für V1 (PlanMod.md 0.4/1.3 Erwartungsmanagement), **keine
serverseitige Lag-Kompensation** (Rückspul-/Rewind-Trefferprüfung o. Ä.) geplant
oder umgesetzt. Die einzige serverseitige Härtung ist die Schadensdeckelung aus
Abschnitt 1 — sie verhindert Missbrauch (unplausibel hoher Schaden), nicht
unplausible ZEITPUNKTE/POSITIONEN von Treffern.

- [ ] Nach erstem Live-Test: wie störend ist der Effekt bei den in A1/A3
      gemessenen realen Latenzen tatsächlich? Falls untragbar: Rewind-basierte
      Serverprüfung als Post-V1-Erweiterung evaluieren (deutlich höherer Aufwand,
      braucht Positions-Historie serverseitig statt nur aktuellem HP-Zustand).

## 4. Konsistenz mit dem Spawn-Tracking aus A2

`server/src/sessionManager.ts` bekommt zwei neue Methoden speziell für A4:
`membersOf()` (Broadcast an ALLE Mitglieder, nicht nur "die anderen" — ein
`hp_state` muss auch beim Angreifer selbst ankommen) und `removeSpawn()` (ein
EINZELNES Objekt aus dem Spawn-Tracking entfernen, ohne die übrigen Spawns
desselben Mitglieds anzufassen — anders als `takeSpawnedObjectIds()`, das für
den kompletten Disconnect eines Mitglieds gedacht ist). Dafür merkt sich
`SessionManager` jetzt zusätzlich `ownerByObjectId` (objectId → memberId) als
Rückwärts-Index. Beide neuen Pfade sind über
`server/tests/session.test.ts` abgedeckt (u. a. "hull reaching 0 broadcasts a
despawn ... and forgets the spawn record for later joiners").

## 5. Ownership-Autorität (zweite Runde, A3-Security-Audit-Nachtrag)

`ownerByObjectId` existierte bereits seit der ersten A4-Runde (Abschnitt 4), wurde
aber nur zum AUFRÄUMEN benutzt, nie zum DURCHSETZEN — der A3-Audit hatte genau
das bemängelt. `SessionManager.ownerOf(objectId)` ist jetzt die zentrale Prüfung,
die `server.ts`s `handleMessage` vor JEDER objektbezogenen Nachricht aufruft:

| Nachricht | Geprüftes Feld | Ausnahme |
|---|---|---|
| `spawn` | `objectId` darf nicht einem ANDEREN Mitglied gehören | eigene erneute Spawns (Respawn) sind erlaubt |
| `state_update` | `shipId` muss dem Sender gehören | — |
| `despawn` | `objectId` muss dem Sender gehören | (Clients senden das laut Protokoll normalerweise nie selbst, siehe `protocol.md`; Prüfung ist Verteidigung in der Tiefe) |
| `fire_event` | `sourceId` muss dem Sender gehören | — |
| `hit_report` | `sourceId` muss dem Sender gehören | **`targetId` bewusst NICHT geprüft** — ein Treffer ist per Definition auf ein FREMDES Objekt |

Wichtig: `ownerOf()` liefert `undefined` sowohl für "nie gespawnt" als auch für
"gehört jemand anderem" — beide Fälle werden IDENTISCH behandelt (Nachricht
verwerfen + loggen), nie als "niemandes, also für jeden frei". Das schließt auch
gleich einen Teil von Abschnitt 8 (Orphan-Filter) auf Server-Seite mit ab: ein
`state_update` für eine `shipId`, die nie gespawnt wurde, wird verworfen — nicht
nur eine gespoofte fremde ID.

Vollständig getestet in `server/tests/session.test.ts` und
`server/tests/sessionManager.test.ts` (`ownerOf`, `hasOtherActiveSpawn`, plus alle
bestehenden Tests, die jetzt zuerst einen echten Spawn/Ownership-Nachweis
brauchen, wo vorher ein bloßer `state_update`/`hit_report` ohne vorherigen Spawn
reichte — das ist eine bewusste Verhaltensänderung, keine zufällige
Testanpassung).

## 6. Spawn-Cap: maximal ein aktiver Spawn pro Mitglied (v1)

`SessionManager.hasOtherActiveSpawn(memberId, objectId)`: true, wenn das
Mitglied bereits eine ANDERE `objectId` aktiv gespawnt hat. `server.ts` lehnt in
diesem Fall einen weiteren `spawn` ab (Log-Zeile, keine Broadcast). Erneutes
Spawnen DERSELBEN `objectId` (Respawn) ist weiterhin uneingeschränkt erlaubt und
zählt nicht als "andere" Spawn. Getestet in `server/tests/session.test.ts`
("A4 spawn cap: ..." — zwei Tests, einer für den Ablehnungsfall inkl.
Disconnect-Cleanup-Konsistenz, einer der explizit bestätigt, dass Respawn NICHT
blockiert wird) und `server/tests/sessionManager.test.ts` (`hasOtherActiveSpawn`
isoliert).

- [ ] "Ein Spawn pro Mitglied" ist eine v1-Annahme (1 Spieler = 1 Schiff). Sobald
      z. B. Drohnen/Gefechtsschiffe mit separatem Trägerschiff hinzukommen
      (nicht Teil von PlanMod.md bis inkl. A4), muss dieser Cap überarbeitet
      werden (pro Mitglied konfigurierbares Limit statt hartem `1`).

## 7. Agent-seitige Koordinaten-/Velocity-Clamps (`agent/src/arenaBounds.ts`)

Neue, rein lokale (kein Protokoll-Bezug) Prüfung im Agent, NICHT im Server:
`ARENA_BOUNDS_METERS` (±500km je Achse) und `MAX_VELOCITY_MPS` (10km/s,
Betrag über alle drei Achsen). `decideRelay` (`agent/src/relayFilter.ts`) lehnt
ein `state_update` ab, dessen `position`/`velocity` diese Grenzen verletzt,
BEVOR es beim Pipe-Write (`set_object_position`/Blackboard) ankommt. Bewusst
grosszügig gewählt (A2s dedizierter Arena-Sektor ist klein, aber diese Werte
sollen nur eindeutig unplausible Werte abfangen, keine schnellen-aber-echten).
`Math.abs(NaN) <= X` und `NaN*NaN <= X²` sind beide `false`, die Prüfungen fangen
NaN/Infinity also automatisch mit ab, ohne eigenen Sonderfall.

Warum im Agent, nicht im Server (Team-Lead-Vorgabe explizit so formuliert,
`decideRelay erweitern`): der Agent ist ohnehin schon die Stelle, an der
`spawn`s Shiptype-Whitelist geprüft wird (A2) — konsistent, alle
"ist das plausibel genug, um in die Pipe/das Spiel zu gelangen"-Prüfungen an
einem Ort zu bündeln, statt sie zwischen Server und Agent aufzuteilen.

Getestet in `agent/tests/arenaBounds.test.ts` (reine Funktionstests,
inkl. Grenzwert exakt an der Kante, NaN/Infinity, kombinierte Geschwindigkeit
über alle drei Achsen statt nur pro Achse) und
`agent/tests/relayFilter.test.ts` (Integration in `decideRelay`).

- [ ] `ARENA_BOUNDS_METERS`/`MAX_VELOCITY_MPS` sind Schätzungen — nach dem ersten
      Live-Test mit echten Schiffsgeschwindigkeiten (inkl. Boost) kalibrieren;
      zu knapp gewählt würde legitime schnelle Bewegungen fälschlich verwerfen.

## 8. Orphan-Filter: `state_update`/`hit_report` nur für bekannte Spawns

Ergänzt `decideRelay` um eine zweite neue Prüfung: ein `state_update` (Feld
`shipId`) oder `hit_report` (Feld `targetId`), für das der Agent keinen
bekannten Spawn hat, wird verworfen — BEVOR es `agent/src/latencyTracker.ts`s
`LatencyTracker.update()` erreicht. Ohne diese Prüfung könnte eine wachsende
Zahl nie gespawnter/bereits despawnter IDs die interne Map des Trackers
unbegrenzt wachsen lassen, da `reset()` nur bei legitimen `spawn`/`despawn`-
Ereignissen für eine ID aufgerufen wird.

`agent/src/index.ts` führt dafür `knownObjectIds` (ein `Set<string>`) parallel
zum bestehenden `knownSpawns` (`Map<string,string>`, die pipe-fertigen Zeilen
für Replay) — an exakt denselben zwei Stellen aktualisiert (spawn hinzufügen,
despawn entfernen), damit `decideRelay` nicht bei jeder einzelnen Nachricht neu
ein Set aus `knownSpawns.keys()` bauen muss.

**Wichtige Einschränkung, hier dokumentiert statt stillschweigend übernommen:**
`hit_report` durchläuft `agent/src/index.ts`s `handleRemoteMessage` (relay → Pipe)
in der Praxis NIE, da der Server laut Protokoll (`protocol.md`) `hit_report`
niemals roh zurücksendet, nur das daraus berechnete `hp_state` (Abschnitt 1).
Die `hit_report`-Hälfte dieses Filters ist also aktuell TOT CODE im
Normalbetrieb — bewusst trotzdem eingebaut, als Verteidigung in der Tiefe falls
sich der Server-Vertrag je ändert, und weil die Prüfung praktisch kostenlos ist
(dieselbe `knownObjectIds`-Abfrage, die `state_update` sowieso schon braucht).

Getestet in `agent/tests/relayFilter.test.ts` ("rejects a state_update for a
shipId with no known spawn", "rejects a hit_report for a targetId with no known
spawn", jeweils mit Gegenprobe für den bekannten Fall).

## 9. `simulateMdExtractField`-Auslagerung und Simulator-Erweiterung (Review-Auflage)

**Auslagerung (Pflicht-Zusatz aus der Aufgabenstellung, vor jeder
ExtractField-Änderung zu erledigen):** `simulateMdExtractField` lebte bisher
inline in `protocol/tests/canonical.test.ts`; jetzt in einer eigenen Datei
`protocol/tests/helpers/mdExtractFieldSimulation.ts`, importiert von
`canonical.test.ts`. `XMP_Arena_ExtractField`s Dateikopf-Kommentar in
`XMP_Arena.xml` verweist jetzt explizit dorthin ("IF YOU CHANGE THE LOGIC BELOW:
... update that file in lockstep"), damit künftige Änderungen an der Cue nicht
mehr riskieren, den Node-Mirror unbemerkt aus dem Tritt zu bringen. Neue
Extraktionstests speziell für die A4-Nachrichtentypen ergänzt (bisher nur
`state_update`/`spawn` durchgetestet): volles Feld-für-Feld-Auslesen einer
`hit_report`-Zeile (inkl. `damageType` als letztes Feld, Letztes-Feld-Fix aus A3)
und einer `hp_state`-Zeile (inkl. `hull`/`shield` = exakt `0`, um sicherzustellen,
dass ein Nullwert nicht mit dem "nicht gefunden"-Sentinel `-1` verwechselt wird).

**Simulator (`agent/src/simulate.ts`):** neue optionale Flags `--hit-target
<objectId>`, `--damage <n>` (Default 25), `--damage-type hull|shield` (Default
`hull`), `--hit-delay-ms <n>` (Default 2000). Mit `--hit-target` gesetzt, sendet
die Instanz `--hit-delay-ms` nach dem Verbinden EINMALIG einen `hit_report` mit
`sourceId` = der eigenen `--object-id` (Ownership-Autorität aus Abschnitt 5
verlangt das). Eingehend wird jetzt zusätzlich `hp_state` geloggt (inkl.
`(DESTROYED)`-Suffix bei `hull <= 0`) und `despawn`s `reason`-Feld mit
ausgegeben, damit ein "destroyed" sich von einem gewöhnlichen "disconnect"
unterscheiden lässt. Damit ist die komplette Kampf-Kette mit zwei
Simulator-Instanzen ohne X4-Installation vorführbar, exakt wie A2s
Spawn/State-Update-Kette es bereits war — siehe `simulate.ts`s Dateikopf für das
konkrete Demo-Kommando.

## 10. Nächste Schritte

1. X4 + SirNukes Mod Support APIs installieren; zuerst `event_object_attacked`
   und `event_object_fired` isoliert bestätigen (Abschnitt 2) — ohne diese zwei
   Events entsteht überhaupt kein `hit_report`/`fire_event`, der Rest des
   Meilensteins bliebe ungetestet.
2. `set_object_invulnerable`s tatsächliche Wirkung prüfen (Abschnitt 2, vorletzter
   Punkt) — falls sie doch echten Schaden zulässt, Restore-Fallback ergänzen.
3. Höchstes Risiko zuerst isoliert testen: `destroy_object` auf `player.entity`
   (Abschnitt 2, letzter Punkt) in einer Umgebung, in der ein unerwartetes
   Nebenverhalten (Rettungskapsel, Versicherung, Game-Over-Screen) keine echten
   Spielstanddaten gefährdet.
4. Erst danach den vollen Kreislauf 1:1 live testen: Spieler A trifft Proxy von
   Spieler B → `hit_report` → `hp_state` bei beiden → Spieler B sieht sein
   eigenes Schiff beschädigt, Spieler A sieht den Proxy unverändert (da
   unverwundbar) außer beim finalen Kill (Explosion). Vorher lokal mit dem
   erweiterten Simulator (Abschnitt 9) durchspielen, um die Server/Agent-Seite
   der Kette schon ohne X4 zu bestätigen.
5. Abschnitt 3 (akzeptierte Schwäche) mit echten Latenzmessungen aus A1/A3
   gegenprüfen; entscheiden, ob sie für den nächsten Meilenstein tragbar bleibt.
6. Die "Shield vor Hull"-Interpretationsentscheidung (Abschnitt 1) mit dem
   Team-Lead gegenprüfen, falls das Kampfgefühl im ersten Live-Test überrascht.
7. `ARENA_BOUNDS_METERS`/`MAX_VELOCITY_MPS` (Abschnitt 7) anhand echter
   Geschwindigkeiten kalibrieren.
